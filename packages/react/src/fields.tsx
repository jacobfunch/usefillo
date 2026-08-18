import type {
  Block,
  CheckboxField,
  ChoiceField,
  ContentBlock,
  Field,
  FieldValue,
  LinearScaleField,
  MatrixField,
  NumberField,
  RankingField as RankingFieldSchema,
  RatingField,
  SelectOption,
} from "@usefillo/core";
import {
  formatAnswer,
  formatGroupedNumber,
  isField,
  isValidPartialNumberText,
  localeForNotation,
  parseGroupedNumber,
  pipeBlock,
  radioGroupStep,
  REQUIRED_FIELD_MESSAGE,
  requiredFieldMessage,
  shouldAutoSubmit,
  slotClass,
  visibleFields,
} from "@usefillo/core";
import type { ComponentType } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CustomComponents,
  FieldComponentProps,
  FieldComponents,
  FilloApi,
  FilloFieldIds,
} from "./api.js";
import { useFieldSlots, useFilloAppearance, useSlotClass, useStrings } from "./appearance.js";
import { useFillo, useFilloAnnounce, useFilloFieldIds } from "./context.js";
import { RepeatingGroup } from "./group.js";
import { PhoneField } from "./phone.js";
import { SignatureField } from "./signature.js";
import { FileUploadField } from "./upload.js";

/**
 * Shared ARIA wiring so every control announces its validity and required
 * state and ties to its description/error text. Spread onto the input (or, for
 * choice fields, the group element).
 *
 * `aria-required` is scoped to hosts whose role actually supports it (ARIA
 * 1.2's per-role allowed-attributes table): real inputs and `role="radiogroup"`
 * do, but `role="group"` and `role="button"` do not — axe's aria-allowed-attr
 * flags it as critical (ledger #1, docs/decisions/input-quality.md). Callers
 * on a group/button host pass `required: false`; the field's required-ness is
 * still conveyed (the shell's required styling/`data-required`, plus, where a
 * group wraps real inputs, per-input aria-required — never scattered onto
 * every checkbox in a group, which stays a plain visual/label convention).
 */
function fieldAria(
  field: Field,
  error: string | undefined,
  ids: FilloFieldIds,
  opts: { required?: boolean } = {},
) {
  const describedBy = [
    field.description ? ids.descriptionId : null,
    error ? ids.errorId : null,
  ].filter(Boolean) as string[];
  const requiredSupported = opts.required ?? true;
  return {
    "aria-invalid": error ? true : undefined,
    "aria-required": requiredSupported && field.required ? true : undefined,
    "aria-describedby": describedBy.length ? describedBy.join(" ") : undefined,
  };
}

/** Control-slot class + marker for a field's main interactive element. */
function useControl(base: string, field: Field, error: string | undefined) {
  return {
    className: useSlotClass(base, {
      slot: "control",
      kind: field.kind,
      fieldId: field.id,
      invalid: Boolean(error),
      required: Boolean(field.required),
    }),
    "data-fillo": "control" as const,
  };
}

/**
 * Label + description + error chrome shared by every default field. Exported
 * (internal to the package, not part of the public barrel in index.ts) so
 * group.tsx's RepeatingGroup can wrap its own instance-cards content in the
 * exact same shell rather than a hand-rolled duplicate (contract: "renders
 * in the standard field shell").
 */
export function FieldShell({
  field,
  error,
  ids,
  children,
}: {
  field: Field;
  error: string | undefined;
  ids: FilloFieldIds;
  children: React.ReactNode;
}) {
  const state = {
    kind: field.kind,
    fieldId: field.id,
    invalid: Boolean(error),
    required: Boolean(field.required),
  };
  // Hooks stay unconditional — classes are computed even for absent parts.
  const fieldCls = useSlotClass(
    `fillo-field fillo-field--${field.kind}${error ? " fillo-field--error" : ""}`,
    { slot: "field", ...state },
  );
  const labelCls = useSlotClass("fillo-label", { slot: "label", ...state });
  const descriptionCls = useSlotClass("fillo-description", { slot: "fieldDescription", ...state });
  const errorCls = useSlotClass("fillo-error", { slot: "error", ...state });
  const strings = useStrings();
  return (
    <div
      className={fieldCls}
      data-fillo="field"
      data-field={field.id}
      data-kind={field.kind}
      data-invalid={error ? "" : undefined}
      data-required={field.required ? "" : undefined}
    >
      <label className={labelCls} data-fillo="label" id={ids.labelId} htmlFor={ids.inputId}>
        {field.label}
        {/* A repeating group's `required` is normalization-forced false —
            minInstances owns completeness, so only a min-0 group is optional. */}
        {!field.required && !(field.kind === "repeating_group" && (field.minInstances ?? 1) > 0) && (
          <span className="fillo-optional">{strings.optional}</span>
        )}
      </label>
      {field.description && (
        <p className={descriptionCls} data-fillo="fieldDescription" id={ids.descriptionId}>
          {field.description}
        </p>
      )}
      {children}
      {/* Inline validation stays beside the field and is wired through
          aria-describedby. Failed submit focuses the first invalid control,
          so it announces this guidance without a duplicate alert panel. */}
      {error && (
        <p className={errorCls} data-fillo="error" id={ids.errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

function TextInput({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const type =
    field.kind === "email"
      ? "email"
      : field.kind === "url"
        ? "url"
        : field.kind === "number"
          ? "number"
          : field.kind === "date"
            ? "date"
            : "text";
  // Contract: email -> autocomplete="email", url -> "url"; short_text/
  // long_text/date get no guessed token.
  const autoComplete = field.kind === "email" ? "email" : field.kind === "url" ? "url" : undefined;
  const control = useControl("fillo-input", field, error);
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <input
        id={ids.inputId}
        {...control}
        type={type}
        autoComplete={autoComplete}
        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
        placeholder={field.placeholder}
        maxLength={"maxLength" in field ? field.maxLength : undefined}
        min={field.kind === "number" ? field.min : undefined}
        max={field.kind === "number" ? field.max : undefined}
        onChange={(e) => setValue(e.target.value)}
        {...fieldAria(field, error, ids)}
      />
    </FieldShell>
  );
}

/**
 * Delegates to TextInput untouched when there's no prefix, suffix, or
 * notation — byte-identical DOM to a plain number field. Adornments wrap the
 * input in `.fillo-number`; the formatted path (grouped OR affix-only) is
 * `type="text"` + `inputMode="decimal"` (a native number input silently
 * rejects separator/affix characters) with no min/max DOM attributes — inert
 * on text, core validation enforces them. It keeps an edit-session draft so
 * the formatted display never taints `data`, which always holds what
 * setValue received (contract decision 2). No unformat-on-focus: focusing
 * changes nothing, the draft starts on the first keystroke and clears on
 * blur, when the display reformats from the stored value.
 * All hooks run unconditionally before the delegate check — the toggle
 * flows through live schema edits (the builder preview), same instance.
 * Every keystroke is filtered through `isValidPartialNumberText` (input-
 * quality contract's keystroke filter) before the draft/setValue logic
 * below ever sees it — an edit that fails (a bad paste included, rejected
 * wholesale, never trimmed to its valid prefix) never reaches state. Since
 * the browser has already written the rejected text into the DOM ahead of
 * React, `revertTick` forces a real re-render so the controlled `value`
 * prop resyncs the input back to the last-good `display`; `pendingCaret`
 * carries the pre-keystroke caret position to the layout effect below,
 * which restores it once that resync lands — the same deferred-restore
 * idiom as the phone field's digit-anchored caret (phone.tsx:101-117).
 */
function NumberInput({ field, value, error, setValue, api, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const control = useControl("fillo-input", field, error);
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [, setRevertTick] = useState(0);

  // Runs after every render (no deps, matching phone.tsx's idiom): a no-op
  // unless a keystroke was just rejected and left a caret position pending.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    inputRef.current?.setSelectionRange(pos, pos);
  });

  const num = field as NumberField;
  const grouped = num.notation !== undefined;
  // "grouped" detects the browser locale (undefined); the fixed styles pin
  // the separators via core's notation→locale map, shared with @usefillo/dom.
  const locale = localeForNotation(num.notation);
  const hasAffix = Boolean(num.prefix) || Boolean(num.suffix);
  if (!grouped && !hasAffix) {
    return (
      <TextInput
        field={field}
        value={value}
        error={error}
        setValue={setValue}
        api={api}
        ids={providedIds}
      />
    );
  }

  const stored = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const n = Number(stored);
  const display =
    draft !== null
      ? draft
      : grouped && stored !== "" && Number.isFinite(n)
        ? formatGroupedNumber(n, { locale, decimals: num.decimals })
        : stored;

  const input = (
    <input
      ref={inputRef}
      id={ids.inputId}
      {...control}
      type="text"
      inputMode="decimal"
      value={display}
      placeholder={field.placeholder}
      onBlur={grouped ? () => setDraft(null) : undefined}
      onChange={(e) => {
        if (!isValidPartialNumberText(e.target.value, locale)) {
          // Reject wholesale (a bad paste included) — keep the previous
          // draft/display. `display` itself isn't changing, so bump the tick
          // to guarantee a real re-render (an unchanged useState value would
          // bail out and leave the browser's stray edit on screen); the
          // effect above restores the caret once that resync commits.
          pendingCaret.current = e.target.selectionStart ?? e.target.value.length;
          setRevertTick((t) => t + 1);
          return;
        }
        if (grouped) {
          setDraft(e.target.value);
          setValue(parseGroupedNumber(e.target.value, locale));
        } else {
          setValue(e.target.value);
        }
      }}
      {...fieldAria(field, error, ids)}
    />
  );

  return (
    <FieldShell field={field} error={error} ids={ids}>
      {hasAffix ? (
        <div className="fillo-number">
          {num.prefix && <span className="fillo-number-prefix">{num.prefix}</span>}
          {input}
          {num.suffix && <span className="fillo-number-suffix">{num.suffix}</span>}
        </div>
      ) : (
        input
      )}
    </FieldShell>
  );
}

function LongText({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const control = useControl("fillo-input fillo-textarea", field, error);
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <textarea
        id={ids.inputId}
        {...control}
        rows={4}
        value={typeof value === "string" ? value : ""}
        placeholder={field.placeholder}
        maxLength={"maxLength" in field ? field.maxLength : undefined}
        onChange={(e) => setValue(e.target.value)}
        {...fieldAria(field, error, ids)}
      />
    </FieldShell>
  );
}

/**
 * Options in display order. Shuffling happens after mount so server-rendered
 * markup matches the first client render (no hydration mismatch); the order
 * is then stable for the rest of the session.
 */
function useDisplayOptions(choice: ChoiceField) {
  const idsKey = choice.options.map((o) => o.id).join("\u0000");
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => {
    if (!choice.shuffleOptions) return;
    const ids = idsKey === "" ? [] : idsKey.split("\u0000");
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    setOrder(ids);
    // Keyed by option ids, not array identity — builders recreate the schema
    // object on every keystroke and the order shouldn't reshuffle with it.
  }, [choice.shuffleOptions, idsKey]);

  if (!choice.shuffleOptions || !order) return choice.options;
  const byId = new Map(choice.options.map((o) => [o.id, o]));
  const shuffled = order.flatMap((id) => byId.get(id) ?? []);
  return shuffled.length === choice.options.length ? shuffled : choice.options;
}

const OPTION_ICON_PATHS: Record<NonNullable<SelectOption["icon"]>, string> = {
  thumbs_up:
    "M7 10v10M7 10l4.8-6.1a2 2 0 0 1 3.5 1.7L14.6 10h4.8a2.1 2.1 0 0 1 2 2.5l-1.1 5.4A3 3 0 0 1 17.4 20H7M3 10h4v10H3z",
  thumbs_down:
    "M7 14V4M7 14l4.8 6.1a2 2 0 0 0 3.5-1.7L14.6 14h4.8a2.1 2.1 0 0 0 2-2.5l-1.1-5.4A3 3 0 0 0 17.4 4H7M3 4h4v10H3z",
};

function ChoiceIcon({ icon }: { icon?: SelectOption["icon"] }) {
  if (!icon) return null;
  return (
    <svg
      className="fillo-option-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={OPTION_ICON_PATHS[icon]} />
    </svg>
  );
}

function SingleChoice({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const appearance = useFilloAppearance();
  const strings = useStrings();
  const optionCls = (base: string, optionId: string, selected: boolean) =>
    slotClass(base, appearance, { slot: "option", kind: field.kind, fieldId: field.id, optionId, selected });
  const choice = field as ChoiceField;
  const options = useDisplayOptions(choice);
  const isOtherValue =
    typeof value === "string" && value !== "" && !choice.options.some((o) => o.id === value);
  const [otherOn, setOtherOn] = useState(isOtherValue);
  const otherActive = isOtherValue || (value === "" && otherOn);
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <div
        className={slotClass("fillo-options", appearance, { slot: "options", kind: field.kind, fieldId: field.id })}
        data-fillo="options"
        role="radiogroup"
        aria-labelledby={ids.labelId}
        {...fieldAria(field, error, ids)}
      >
        {options.map((opt) => (
          <label
            key={opt.id}
            data-option={opt.id}
            data-fillo="option"
            data-selected={value === opt.id ? "" : undefined}
            className={optionCls(
              `fillo-option${opt.icon ? " fillo-option--has-icon" : ""}${
                value === opt.id ? " fillo-option--selected" : ""
              }`,
              opt.id,
              value === opt.id,
            )}
          >
            <input
              type="radio"
              className="fillo-option-input"
              name={ids.name}
              checked={value === opt.id}
              onChange={() => {
                setOtherOn(false);
                setValue(opt.id);
              }}
            />
            <ChoiceIcon icon={opt.icon} />
            {opt.icon && value === opt.id && (
              // Icon-mode hides the native input, so its check state is
              // otherwise color-only (forfeits forced-colors' own indicator).
              <span className="fillo-option-check" aria-hidden="true">✓</span>
            )}
            <span className={slotClass("fillo-option-label", appearance, { slot: "optionLabel", kind: field.kind, fieldId: field.id })} data-fillo="optionLabel">{opt.label}</span>
          </label>
        ))}
        {choice.allowOther && (
          // The outer element is a <label> so the whole row is a pointer
          // target (native label click-forwarding), same as every other
          // option row above. The free-text input below is its own labelable
          // descendant, so it handles its own clicks without re-toggling the
          // radio (dom's proven pattern).
          <label
            data-fillo="option"
            data-selected={otherActive ? "" : undefined}
            className={optionCls(
              `fillo-option fillo-option--other${
                otherActive ? " fillo-option--selected fillo-option--with-other" : ""
              }`,
              "__other",
              otherActive,
            )}
          >
            <span className="fillo-option-main">
              <input
                type="radio"
                className="fillo-option-input"
                name={ids.name}
                checked={otherActive}
                onChange={() => {
                  setOtherOn(true);
                  setValue("");
                }}
              />
              <span className={slotClass("fillo-option-label", appearance, { slot: "optionLabel", kind: field.kind, fieldId: field.id })} data-fillo="optionLabel">{strings.other}</span>
            </span>
            {otherActive && (
              <input
                type="text"
                className="fillo-input fillo-other-input"
                aria-label={strings.otherPrompt}
                placeholder={strings.otherPlaceholder}
                autoFocus={!isOtherValue}
                value={isOtherValue ? String(value) : ""}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </label>
        )}
      </div>
    </FieldShell>
  );
}

function MultiChoice({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const choice = field as ChoiceField;
  const options = useDisplayOptions(choice);
  const strings = useStrings();
  const optionIds = new Set(choice.options.map((o) => o.id));
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const otherText = selected.find((v) => !optionIds.has(v));
  const [otherOn, setOtherOn] = useState(otherText !== undefined);
  const otherActive = otherText !== undefined || otherOn;
  const toggle = (id: string) =>
    setValue(selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id]);
  const appearance = useFilloAppearance();
  const optionCls = (base: string, optionId: string, isSelected: boolean) =>
    slotClass(base, appearance, { slot: "option", kind: field.kind, fieldId: field.id, optionId, selected: isSelected });
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <div
        className={slotClass("fillo-options", appearance, { slot: "options", kind: field.kind, fieldId: field.id })}
        data-fillo="options"
        role="group"
        aria-labelledby={ids.labelId}
        {...fieldAria(field, error, ids, { required: false })}
      >
        {options.map((opt) => (
          <label
            key={opt.id}
            data-option={opt.id}
            data-fillo="option"
            data-selected={selected.includes(opt.id) ? "" : undefined}
            className={optionCls(
              `fillo-option${opt.icon ? " fillo-option--has-icon" : ""}${
                selected.includes(opt.id) ? " fillo-option--selected" : ""
              }`,
              opt.id,
              selected.includes(opt.id),
            )}
          >
            <input
              type="checkbox"
              className="fillo-option-input"
              checked={selected.includes(opt.id)}
              onChange={() => toggle(opt.id)}
            />
            <ChoiceIcon icon={opt.icon} />
            {opt.icon && selected.includes(opt.id) && (
              // Icon-mode hides the native input, so its check state is
              // otherwise color-only (forfeits forced-colors' own indicator).
              <span className="fillo-option-check" aria-hidden="true">✓</span>
            )}
            <span className={slotClass("fillo-option-label", appearance, { slot: "optionLabel", kind: field.kind, fieldId: field.id })} data-fillo="optionLabel">{opt.label}</span>
          </label>
        ))}
        {choice.allowOther && (
          // The outer element is a <label> so the whole row is a pointer
          // target (native label click-forwarding), same as every other
          // option row above. The free-text input below is its own labelable
          // descendant, so it handles its own clicks without re-toggling the
          // checkbox (dom's proven pattern).
          <label
            data-fillo="option"
            data-selected={otherActive ? "" : undefined}
            className={optionCls(
              `fillo-option fillo-option--other${
                otherActive ? " fillo-option--selected fillo-option--with-other" : ""
              }`,
              "__other",
              otherActive,
            )}
          >
            <span className="fillo-option-main">
              <input
                type="checkbox"
                className="fillo-option-input"
                checked={otherActive}
                onChange={() => {
                  if (otherActive) {
                    setOtherOn(false);
                    setValue(selected.filter((v) => optionIds.has(v)));
                  } else {
                    setOtherOn(true);
                  }
                }}
              />
              <span className={slotClass("fillo-option-label", appearance, { slot: "optionLabel", kind: field.kind, fieldId: field.id })} data-fillo="optionLabel">{strings.other}</span>
            </span>
            {otherActive && (
              <input
                type="text"
                className="fillo-input fillo-other-input"
                aria-label={strings.otherPrompt}
                placeholder={strings.otherPlaceholder}
                autoFocus={otherText === undefined}
                value={otherText ?? ""}
                onChange={(e) => {
                  const rest = selected.filter((v) => optionIds.has(v));
                  setValue(e.target.value ? [...rest, e.target.value] : rest);
                }}
              />
            )}
          </label>
        )}
      </div>
    </FieldShell>
  );
}

function otherSentinel(field: ChoiceField): string {
  let value = "__fillo_other__";
  const ids = new Set(field.options.map((option) => option.id));
  while (ids.has(value)) value += "_";
  return value;
}

function Dropdown({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const strings = useStrings();
  const choice = field as ChoiceField;
  const options = useDisplayOptions(choice);
  const otherValue = otherSentinel(choice);
  const isOtherValue =
    typeof value === "string" && value !== "" && !choice.options.some((o) => o.id === value);
  const [otherOn, setOtherOn] = useState(isOtherValue);
  const otherActive = isOtherValue || (value === "" && otherOn);
  const control = useControl("fillo-input fillo-select", field, error);
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <div className="fillo-select-wrap">
        <select
          id={ids.inputId}
          {...control}
          {...fieldAria(field, error, ids)}
          value={otherActive ? otherValue : typeof value === "string" ? value : ""}
          onChange={(e) => {
            if (e.target.value === otherValue) {
              setOtherOn(true);
              setValue("");
            } else {
              setOtherOn(false);
              setValue(e.target.value || null);
            }
          }}
        >
          <option value="">{field.placeholder ?? strings.choosePlaceholder}</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
          {choice.allowOther && <option value={otherValue}>{`${strings.other}…`}</option>}
        </select>
        <span className="fillo-select-icon" aria-hidden="true" />
      </div>
      {otherActive && (
        <input
          type="text"
          className="fillo-input fillo-other-input fillo-other-input--block"
          aria-label={strings.otherPrompt}
          placeholder={strings.otherPlaceholder}
          autoFocus={!isOtherValue}
          value={isOtherValue ? String(value) : ""}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
    </FieldShell>
  );
}

function Checkbox({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const strings = useStrings();
  const appearance = useFilloAppearance();
  const slots = useFieldSlots(field, error);
  const checkbox = field as CheckboxField;
  if (checkbox.appearance === "toggle") {
    return (
      <div
        {...slots.wrapperProps(
          `fillo-field fillo-field--checkbox fillo-field--toggle${error ? " fillo-field--error" : ""}`,
        )}
      >
        <label className="fillo-toggle" data-fillo="option" data-checked={value === true ? "" : undefined}>
          <span className="fillo-toggle-copy">
            <span className={slotClass("fillo-option-label", appearance, { slot: "optionLabel", kind: field.kind, fieldId: field.id })} data-fillo="optionLabel">
              {field.label}
              {!field.required && <span className="fillo-optional">{strings.optional}</span>}
            </span>
          </span>
          <input
            id={ids.inputId}
            type="checkbox"
            className="fillo-toggle-input"
            checked={value === true}
            onChange={(e) => setValue(e.target.checked)}
            {...fieldAria(field, error, ids)}
          />
          <span className="fillo-toggle-track" aria-hidden="true">
            <span className="fillo-toggle-thumb" />
          </span>
        </label>
        {field.description && (
          <p className={slots.description} data-fillo="fieldDescription" id={ids.descriptionId}>
            {field.description}
          </p>
        )}
        {error && (
          <p className={slots.error} data-fillo="error" id={ids.errorId}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      {...slots.wrapperProps(
        `fillo-field fillo-field--checkbox${error ? " fillo-field--error" : ""}`,
      )}
    >
      <label className="fillo-option" data-fillo="option" data-checked={value === true ? "" : undefined}>
        <input
          id={ids.inputId}
          type="checkbox"
          className="fillo-option-input"
          checked={value === true}
          onChange={(e) => setValue(e.target.checked)}
          {...fieldAria(field, error, ids)}
        />
        <span className={slotClass("fillo-option-label", appearance, { slot: "optionLabel", kind: field.kind, fieldId: field.id })} data-fillo="optionLabel">
          {field.label}
          {!field.required && <span className="fillo-optional">{strings.optional}</span>}
        </span>
      </label>
      {field.description && (
        <p className={slots.description} data-fillo="fieldDescription" id={ids.descriptionId}>
          {field.description}
        </p>
      )}
      {error && (
        <p className={slots.error} data-fillo="error" id={ids.errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Arrow-key handler for a single-select radiogroup built from buttons — a
 * thin DOM adapter around core's `radioGroupStep` (shared with
 * @usefillo/dom; audit P2.3: the old per-renderer math wrapped at the
 * extremes, had no Home/End, and was RTL-blind). Moves focus to the stepped
 * option and selects it; `steps` is the ordered value list. RTL is resolved
 * fresh per keydown from computed style so a `dir="rtl"` ancestor flips
 * Left/Right with no extra plumbing.
 */
function radiogroupKeyDown<T>(
  e: React.KeyboardEvent<HTMLDivElement>,
  steps: T[],
  current: T | null,
  setValue: (v: T) => void,
) {
  const group = e.currentTarget;
  const rtl = getComputedStyle(group).direction === "rtl";
  const index = rovingIndex(steps, current);
  const next = radioGroupStep(e.key, index, steps.length, { rtl });
  if (next == null) return;
  e.preventDefault();
  const value = steps[next];
  if (value === undefined) return;
  setValue(value);
  const buttons = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  buttons[next]?.focus();
}

/** Index of the option that should be tabbable (roving tabindex). */
function rovingIndex<T>(steps: T[], current: T | null): number {
  if (current == null) return 0;
  const i = steps.indexOf(current);
  return i === -1 ? 0 : i;
}

function Rating({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const max = (field as RatingField).max ?? 5;
  const current = typeof value === "number" ? value : 0;
  const steps = Array.from({ length: max }, (_, i) => i + 1);
  const selected = current > 0 ? current : null;
  const tabbable = rovingIndex(steps, selected);
  const appearance = useFilloAppearance();
  const control = useControl("fillo-rating", field, error);
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <div
        id={ids.inputId}
        {...control}
        role="radiogroup"
        aria-labelledby={ids.labelId}
        {...fieldAria(field, error, ids)}
        onKeyDown={(e) => radiogroupKeyDown(e, steps, selected, (n) => setValue(n))}
      >
        {steps.map((n, i) => (
          <button
            key={n}
            type="button"
            data-fillo="option"
            data-selected={n <= current ? "" : undefined}
            className={slotClass(`fillo-star${n <= current ? " fillo-star--active" : ""}`, appearance, {
              slot: "option",
              kind: field.kind,
              fieldId: field.id,
              selected: n <= current,
            })}
            role="radio"
            aria-label={`${n} of ${max}`}
            aria-checked={n === current}
            tabIndex={i === tabbable ? 0 : -1}
            onClick={(event) => {
              // APG: Space/Enter (a keyboard-triggered click reports
              // detail 0) on an already-checked value is a no-op; pointer
              // click-again may still clear it.
              if (event.detail === 0 && n === current) return;
              setValue(n === current ? null : n);
            }}
          >
            {n <= current ? "★" : "☆"}
          </button>
        ))}
      </div>
    </FieldShell>
  );
}

function LinearScale({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const scale = field as LinearScaleField;
  const min = scale.min ?? 1;
  const max = scale.max ?? 10;
  const steps = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const current = typeof value === "number" ? value : null;
  const tabbable = rovingIndex(steps, current);
  // Associate the min/max end labels with the group via aria-describedby.
  const hasLabels = Boolean(scale.minLabel || scale.maxLabel);
  const minLabelId = `${ids.inputId}-min`;
  const maxLabelId = `${ids.inputId}-max`;
  const describedBy =
    [
      scale.minLabel ? minLabelId : null,
      scale.maxLabel ? maxLabelId : null,
      field.description ? ids.descriptionId : null,
      error ? ids.errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const appearance = useFilloAppearance();
  const control = useControl("fillo-scale", field, error);
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <div
        id={ids.inputId}
        {...control}
        role="radiogroup"
        aria-labelledby={ids.labelId}
        aria-invalid={error ? true : undefined}
        aria-required={field.required ? true : undefined}
        aria-describedby={describedBy}
        onKeyDown={(e) => radiogroupKeyDown(e, steps, current, (n) => setValue(n))}
      >
        {steps.map((n, i) => (
          <button
            key={n}
            type="button"
            data-fillo="option"
            data-selected={value === n ? "" : undefined}
            className={slotClass(`fillo-scale-step${value === n ? " fillo-scale-step--active" : ""}`, appearance, {
              slot: "option",
              kind: field.kind,
              fieldId: field.id,
              selected: value === n,
            })}
            role="radio"
            aria-label={String(n)}
            aria-checked={value === n}
            tabIndex={i === tabbable ? 0 : -1}
            onClick={(event) => {
              // APG: Space/Enter on an already-checked value is a no-op;
              // pointer click-again may still clear it.
              if (event.detail === 0 && n === current) return;
              setValue(value === n ? null : n);
            }}
          >
            {n}
          </button>
        ))}
      </div>
      {hasLabels && (
        <div className="fillo-scale-labels">
          <span id={minLabelId}>{scale.minLabel}</span>
          <span id={maxLabelId}>{scale.maxLabel}</span>
        </div>
      )}
    </FieldShell>
  );
}

function Ranking({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const strings = useStrings();
  const announce = useFilloAnnounce();
  const ranking = field as RankingFieldSchema;
  // Current order: answered order first, then any unranked options.
  const answered = Array.isArray(value) ? (value as string[]) : [];
  const order = [
    ...answered.filter((id) => ranking.options.some((o) => o.id === id)),
    ...ranking.options.map((o) => o.id).filter((id) => !answered.includes(id)),
  ];

  // A move that lands an item on an extreme disables the button the
  // respondent just pressed — a disabled control can't hold focus, so it
  // would otherwise strand focus on <body> (audit P1.5; dom's restoreFocus
  // strategy, adapted for react: the reordered <li> keeps its DOM identity
  // via `key`, so a plain ref to the pressed button survives the re-render
  // and we don't need dom's id+direction lookup). Once the reorder commits,
  // refocus the item's other, still-enabled move button.
  const pressedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const pressed = pressedRef.current;
    pressedRef.current = null;
    if (!pressed || !pressed.disabled) return;
    const sibling = pressed.parentElement?.querySelector<HTMLButtonElement>(
      ".fillo-ranking-move:not(:disabled)",
    );
    sibling?.focus();
    // Keyed on `value` (a fresh array reference every commit) rather than
    // anything read directly in the body — this only needs to re-run once
    // per reorder, after the move that set pressedRef has actually landed.
  }, [value]);

  function move(id: string, delta: number, button: HTMLButtonElement) {
    const index = order.indexOf(id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    pressedRef.current = button;
    const next = [...order];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setValue(next);
    // Contract §Announcements: a polite live-region narration of the new
    // position — the reorder itself is only visible on screen (P1.5/§Ranking).
    const moved = ranking.options.find((o) => o.id === id);
    if (moved) announce(strings.rankingPosition(moved.label, target + 1, order.length));
  }

  return (
    <FieldShell field={field} error={error} ids={ids}>
      <div
        id={ids.inputId}
        role="group"
        aria-labelledby={ids.labelId}
        {...fieldAria(field, error, ids, { required: false })}
      >
        <ol className="fillo-ranking">
          {order.map((id, index) => {
            const option = ranking.options.find((o) => o.id === id);
            if (!option) return null;
            return (
              <li key={id} className="fillo-ranking-item">
                <span className="fillo-ranking-index">{index + 1}</span>
                <span className="fillo-ranking-label">{option.label}</span>
                <span className="fillo-ranking-controls">
                  <button
                    type="button"
                    className="fillo-ranking-move"
                    aria-label={`Move ${option.label} up`}
                    disabled={index === 0}
                    onClick={(e) => move(id, -1, e.currentTarget)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="fillo-ranking-move"
                    aria-label={`Move ${option.label} down`}
                    disabled={index === order.length - 1}
                    onClick={(e) => move(id, 1, e.currentTarget)}
                  >
                    ↓
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </FieldShell>
  );
}

function Matrix({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const matrix = field as MatrixField;
  const answers = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<
    string,
    string
  >;
  return (
    <FieldShell field={field} error={error} ids={ids}>
      <div
        id={ids.inputId}
        className="fillo-matrix-wrap"
        role="group"
        aria-labelledby={ids.labelId}
        {...fieldAria(field, error, ids, { required: false })}
      >
        <table className="fillo-matrix">
          <thead>
            <tr>
              {/* The corner above the row-label column names nothing — a
                  <th> here is an empty header (axe empty-table-header,
                  ledger #2); HTML-AAM/APG's fix is a plain <td>, not a
                  labeled th (there's no label to give it). */}
              <td />
              {matrix.columns.map((col) => (
                <th key={col.id} scope="col">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const rowLabelId = `${ids.inputId}-${row.id}`;
              const answered = answers[row.id] !== undefined;
              // A required row is invalid only once it's been left unanswered
              // and the field has surfaced an error.
              const rowInvalid = Boolean(error) && field.required && !answered;
              const radioId = (col: MatrixField["columns"][number]) =>
                `${ids.inputId}-${row.id}-${col.id}`;
              return (
                // The <tr> keeps its native row role so the grid's row/column
                // header association survives for screen readers. The row's
                // radiogroup lives on an inner element that aria-owns the radios
                // scattered across the cells (they can't be DOM-nested inside a
                // single element within a table row).
                <tr key={row.id}>
                  <th scope="row">
                    <div
                      role="radiogroup"
                      aria-labelledby={`${ids.labelId} ${rowLabelId}`}
                      aria-owns={matrix.columns.map(radioId).join(" ")}
                    >
                      <span id={rowLabelId}>{row.label}</span>
                    </div>
                  </th>
                  {matrix.columns.map((col) => (
                    <td key={col.id} data-label={col.label}>
                      {/* The label fills the cell (pointer target ≥24px) and
                          data-label feeds the narrow-viewport stacked layout,
                          which reads column names from the attribute. */}
                      <label className="fillo-matrix-cell">
                        <input
                          id={radioId(col)}
                          type="radio"
                          className="fillo-option-input"
                          name={`${ids.name}-${row.id}`}
                          aria-label={`${row.label}: ${col.label}`}
                          aria-required={field.required ? true : undefined}
                          aria-invalid={rowInvalid ? true : undefined}
                          checked={answers[row.id] === col.id}
                          onChange={() => setValue({ ...answers, [row.id]: col.id })}
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </FieldShell>
  );
}

function Hidden() {
  return null;
}

/**
 * A calculated field's read-only display row: label + the formatted value the
 * engine computed into `data` — never an input, never a tab stop. The value
 * lives in an <output> (a labelable element whose whole purpose is a
 * calculation result), so the shell's <label for> ties the field label to the
 * value text and screen readers announce "Subtotal: $42" — and its implicit
 * polite live region announces recomputes. Formatting goes through core's
 * formatAnswer so decimals/prefix/suffix render identically to the grid/CSV.
 * Unanswered (a null calc result keeps the key out of data) renders an em dash.
 */
function Calculated({ field, value, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  // required is forced false in normalization; a derived value is never invalid.
  const state = { kind: field.kind, fieldId: field.id, invalid: false, required: false };
  const rootCls = useSlotClass("fillo-field fillo-field--calculated fillo-calculated", {
    slot: "calculated",
    ...state,
  });
  const labelCls = useSlotClass("fillo-label", { slot: "label", ...state });
  const descriptionCls = useSlotClass("fillo-description", { slot: "fieldDescription", ...state });
  const answered = value !== undefined && value !== null && value !== "";
  return (
    <div
      className={rootCls}
      data-fillo="calculated"
      data-field={field.id}
      data-kind={field.kind}
    >
      {/* No "(optional)" marker: this is a computed line, not a skippable question. */}
      <label className={labelCls} data-fillo="label" id={ids.labelId} htmlFor={ids.inputId}>
        {field.label}
      </label>
      {field.description && (
        <p className={descriptionCls} data-fillo="fieldDescription" id={ids.descriptionId}>
          {field.description}
        </p>
      )}
      <output
        id={ids.inputId}
        className={`fillo-calculated-value${answered ? "" : " fillo-calculated-value--empty"}`}
        aria-describedby={field.description ? ids.descriptionId : undefined}
      >
        {answered ? formatAnswer(field, value) : "—"}
      </output>
    </div>
  );
}

// Every built-in kind has a default. "custom" has none by design — it's
// resolved from customComponents at render time.
const DEFAULT_COMPONENTS: Record<
  Exclude<Field["kind"], "custom">,
  ComponentType<FieldComponentProps>
> = {
  short_text: TextInput,
  email: TextInput,
  url: TextInput,
  phone: PhoneField,
  number: NumberInput,
  date: TextInput,
  long_text: LongText,
  select: SingleChoice,
  multi_select: MultiChoice,
  dropdown: Dropdown,
  checkbox: Checkbox,
  rating: Rating,
  linear_scale: LinearScale,
  ranking: Ranking,
  matrix: Matrix,
  signature: SignatureField,
  file_upload: FileUploadField,
  hidden: Hidden,
  calculated: Calculated,
  repeating_group: RepeatingGroup,
};

function ContentRenderer({ block }: { block: ContentBlock }) {
  switch (block.kind) {
    case "heading":
      return <h3 className="fillo-heading">{block.text}</h3>;
    case "paragraph":
      return <p className="fillo-paragraph">{block.text}</p>;
    case "divider":
      return <hr className="fillo-divider" />;
  }
}


interface BlockRendererProps {
  block: Block;
  api: FilloApi;
  components?: FieldComponents;
  customComponents?: CustomComponents;
}

/** True if any of the block's piped text fields contains an `{{answer}}` token. */
function blockHasPiping(block: Block): boolean {
  const has = (s: string | undefined) => typeof s === "string" && s.includes("{{");
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return has(block.text);
    case "divider":
      return false;
    default:
      return has(block.label) || has(block.description);
  }
}

/**
 * Skip re-rendering a block when nothing it can observe has changed. With the
 * memoized api, every keystroke produces a new api object — so this comparison
 * is what stops one field's input from re-rendering every other field.
 *
 * A block depends on: its own value + error, its block/components identity, and
 * — when it pipes other answers, is auto-submit eligible, or is a custom field
 * (which may read arbitrary api) — wider slices of state. We re-render whenever
 * any of those change, so neither the render output nor the auto-submit closure
 * can go stale.
 */
function blockPropsEqual(prev: BlockRendererProps, next: BlockRendererProps): boolean {
  if (
    prev.block !== next.block ||
    prev.components !== next.components ||
    prev.customComponents !== next.customComponents
  ) {
    return false;
  }
  const id = next.block.id;
  if (prev.api.data[id] !== next.api.data[id]) return false;
  if (prev.api.errors[id] !== next.api.errors[id]) return false;

  // User renderers receive the entire api and may legitimately read any part
  // of it. Only the built-ins can use the narrower dependency comparison below.
  if (
    next.block.kind === "custom" ||
    (isField(next.block) && Boolean(next.components?.[next.block.kind]))
  ) {
    return prev.api === next.api;
  }

  // Piped text reads other fields' answers; fall back to comparing the data
  // reference (it changes on any edit).
  if ((blockHasPiping(prev.block) || blockHasPiping(next.block)) && prev.api.data !== next.api.data) {
    return false;
  }

  // Auto-submit's setValue closure validates the whole response, so it must see
  // fresh data/status/uploading/isLastPage.
  if (next.api.form.settings.submitMode === "auto") {
    if (
      prev.api.data !== next.api.data ||
      prev.api.status !== next.api.status ||
      prev.api.uploading !== next.api.uploading ||
      prev.api.isLastPage !== next.api.isLastPage
    ) {
      return false;
    }
  }
  return true;
}

function BlockRendererInner({ block, api, components, customComponents }: BlockRendererProps) {
  // Resolve {{answer}} tokens in this block's text against the current data.
  block = pipeBlock(block, api.data, api.form);
  const ids = useFilloFieldIds(block.id);
  const strings = useStrings();

  if (!isField(block)) return <ContentRenderer block={block} />;

  let Component: ComponentType<FieldComponentProps> | undefined;
  if (block.kind === "custom") {
    // The public maps narrow `field` per kind; internally we render against the
    // widened `Field`, so cast the resolved component back to the loose props.
    Component = (customComponents?.[block.component] ?? components?.custom) as
      | ComponentType<FieldComponentProps>
      | undefined;
    if (!Component) {
      const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
      if (proc?.env?.NODE_ENV !== "production") {
        console.warn(
          `[fillo] No renderer for custom field "${block.id}" (component "${block.component}"). ` +
            `Pass it via the customComponents prop.`,
        );
      }
      return null;
    }
  } else {
    Component =
      (components?.[block.kind] as ComponentType<FieldComponentProps> | undefined) ??
      DEFAULT_COMPONENTS[block.kind];
  }

  // Core returns a stable required sentinel (it has no strings context on the
  // validation path); map it here to field-aware/localized renderer copy.
  // Other messages pass through unchanged.
  const rawError = api.errors[block.id];
  const error =
    rawError === REQUIRED_FIELD_MESSAGE ? requiredFieldMessage(block, strings) : rawError;

  return (
    <Component
      field={block}
      value={api.data[block.id]}
      error={error}
      setValue={(v) => {
        api.setValue(block.id, v);
        const ctx = {
          form: api.form,
          data: api.data,
          status: api.status,
          isLastPage: api.isLastPage,
          uploading: api.uploading,
        };
        if (shouldAutoSubmit(block, v, ctx)) void api.submit().catch(() => {});
      }}
      api={api}
      ids={ids}
    />
  );
}

/**
 * Memoized so a keystroke in one field doesn't re-render every other field —
 * see blockPropsEqual for exactly what a block is allowed to depend on.
 */
export const BlockRenderer = memo(BlockRendererInner, blockPropsEqual);

/**
 * Render a single field by id using the default (or overridden) component —
 * drop it anywhere inside a <FilloProvider> to place fields in your own
 * layout. For total control over the markup, use the useField() hook instead.
 */
export function FormField({
  id,
  components,
  customComponents,
}: {
  id: string;
  components?: FieldComponents;
  customComponents?: CustomComponents;
}) {
  const api = useFillo();
  // Same fixpoint the engine validates with: a logic-hidden field must not be
  // fillable here — its answer would be silently discarded at submit.
  const visibleIds = useMemo(
    () => new Set(visibleFields(api.form, api.data).map((f) => f.id)),
    [api.form, api.data],
  );
  const block = api.form.pages.flatMap((p) => p.blocks).find((b) => b.id === id);
  if (!block) return null;
  if (isField(block) && !visibleIds.has(block.id)) return null;
  return (
    <BlockRenderer
      block={block}
      api={api}
      components={components}
      customComponents={customComponents}
    />
  );
}
