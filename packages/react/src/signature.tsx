import { useEffect, useRef, useState } from "react";
import type { FieldComponentProps } from "./api.js";
import { useFilloFieldIds } from "./context.js";
import { useFieldSlots, useStrings } from "./appearance.js";

/**
 * Canvas signature pad. Stores a PNG data URL in the response data.
 * Pointer-events based, so it works with mouse, touch and pen.
 */
export function SignatureField({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const slots = useFieldSlots(field, error);
  const strings = useStrings();
  const typedInputId = `${ids.inputId}-typed`;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const typedInputRef = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(Boolean(value));
  // Keyboard/screen-reader path: type a name and we render it onto the same
  // canvas, so the stored value is always a PNG data URL regardless of input
  // method. Pointer users can still draw.
  const [typedName, setTypedName] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Crisp lines on retina; size from CSS box.
    const scale = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(scale, scale);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(canvas).color;

    // Canvas geometry/style is initialized once; value restoration is handled
    // by the effect below because saved drafts can arrive after mount.
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let cancelled = false;
    const rect = canvas.getBoundingClientRect();
    if (typeof value === "string" && value.startsWith("data:image/")) {
      setHasInk(true);
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, rect.width, rect.height);
      };
      img.src = value;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setHasInk(false);
      setTypedName("");
    }
    return () => {
      cancelled = true;
    };
  }, [value]);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Switching to drawing supersedes a typed name — clear the input so the two
    // paths don't visually contradict each other.
    if (typedName) setTypedName("");
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  /** Render a typed name onto the canvas (the keyboard-accessible signature). */
  function drawTypedName(text: string) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (text.trim()) {
      ctx.fillStyle = getComputedStyle(canvas).color;
      ctx.font = `italic ${Math.min(40, rect.height * 0.45)}px "Segoe Script", "Brush Script MT", cursive`;
      ctx.textBaseline = "middle";
      ctx.fillText(text, 12, rect.height / 2);
      setHasInk(true);
      setValue(canvas.toDataURL("image/png"));
    } else {
      setHasInk(false);
      setValue(null);
    }
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function end(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    setHasInk(true);
    setValue(e.currentTarget.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
    setTypedName("");
    setValue(null);
    // Clear unmounts its own button (rendered only while hasInk) — move
    // focus to the type-to-sign input instead of stranding it (audit P1.6).
    typedInputRef.current?.focus();
  }

  const describedBy =
    [field.description ? ids.descriptionId : null, error ? ids.errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div {...slots.wrapperProps(`fillo-field fillo-field--signature${error ? " fillo-field--error" : ""}`)}>
      {/* A canvas isn't a labelable element, so the group (not the canvas)
          carries the field label; the type-to-sign input is the keyboard path. */}
      <span className={slots.label} data-fillo="label" id={ids.labelId}>
        {field.label}
        {!field.required && <span className="fillo-optional">{strings.optional}</span>}
      </span>
      {field.description && (
        <p className={slots.description} data-fillo="fieldDescription" id={ids.descriptionId}>
          {field.description}
        </p>
      )}
      <div
        role="group"
        aria-labelledby={ids.labelId}
        aria-describedby={describedBy}
      >
        <div className={slots.control("fillo-signature")} data-fillo="control">
          <canvas
            ref={canvasRef}
            className="fillo-signature-canvas"
            // Drawing is a pointer-only enhancement; keyboard/SR users sign via
            // the text input below, so keep the canvas out of the tab/focus
            // order (no tabIndex) — but it's still an image AT users browsing
            // by virtual cursor land on, so it needs a real accessible name
            // (audit P1.6: aria-hidden left it with no name/state at all).
            role="img"
            aria-label={hasInk ? strings.signatureSigned : strings.signatureEmpty}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onPointerLeave={end}
          />
          {hasInk && (
            <button type="button" className="fillo-signature-clear" onClick={clear}>
              Clear
            </button>
          )}
          {!hasInk && <span className="fillo-signature-hint" aria-hidden="true">Sign here</span>}
        </div>
        <div className="fillo-signature-type">
          <label className="fillo-signature-type-label" htmlFor={typedInputId}>
            Or type your full name to sign
          </label>
          <input
            id={typedInputId}
            ref={typedInputRef}
            type="text"
            className="fillo-input fillo-signature-type-input"
            autoComplete="name"
            value={typedName}
            required={field.required || undefined}
            aria-required={field.required || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => {
              setTypedName(e.target.value);
              drawTypedName(e.target.value);
            }}
          />
        </div>
      </div>
      {error && (
        <p className={slots.error} data-fillo="error" id={ids.errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
