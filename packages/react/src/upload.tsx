import type {
  FileUploadField as FileUploadFieldSchema,
  FileValue,
  FilloError,
  FilloRendererStrings,
} from "@usefillo/core";
import { useEffect, useRef, useState } from "react";
import type { FieldComponentProps } from "./api.js";
import { useFieldSlots, useStrings } from "./appearance.js";
import { safeHttpUrl } from "./chrome.js";
import { useFilloChrome, useFilloFieldIds } from "./context.js";

interface InFlight {
  key: string;
  name: string;
  size: number;
  fraction: number;
  error?: string;
  /** The source File, retained on a failed row so it can be retried. */
  file?: File;
  /** True when the row failed the local size limit — retrying can't help. */
  tooLarge?: boolean;
}

/**
 * One-line spoken summary of the upload list for the aria-live region:
 * announces in-progress count (so the disabled submit is explained), then
 * any completed/failed totals. Empty string when nothing's happening.
 */
function uploadStatus(
  inFlight: InFlight[],
  doneCount: number,
  strings: FilloRendererStrings,
): string {
  const failed = inFlight.filter((f) => f.error).length;
  const active = inFlight.length - failed;
  const parts: string[] = [];
  if (active > 0) parts.push(strings.filesUploading(active));
  if (failed > 0) parts.push(strings.uploadsFailed(failed));
  if (active === 0 && doneCount > 0) parts.push(strings.filesUploaded(doneCount));
  return parts.join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Provider and infrastructure failures are retryable, but their raw details
 * are only useful in server logs. Keep the respondent-facing row concise. */
function uploadFailureMessage(error: unknown, strings: FilloRendererStrings): string {
  // Do not use `instanceof`: an embed can resolve a second copy of core while
  // still receiving its FilloError from the client. Its name/status are the
  // stable public error contract across that package boundary.
  if (error instanceof Error && error.name === "FilloError") {
    const status = (error as Error & { status?: number }).status;
    if (status === 0 || (status !== undefined && status >= 500)) {
      return strings.uploadUnavailable;
    }
  }
  return strings.uploadFailed;
}

type FileRowState = "uploading" | "done" | "failed";

/** Decorative state marks keep upload rows understandable without making
 * screen readers repeat the adjacent visible status text. */
function FileStateIcon({ state }: { state: FileRowState }) {
  if (state === "done") {
    return (
      <span className="fillo-file-state fillo-file-state--done" aria-hidden="true">
        <svg
          className="fillo-file-state-icon"
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M3.75 12a8.25 8.25 0 1 0 16.5 0 8.25 8.25 0 1 0-16.5 0" />
          <path d="m8.5 12 2.25 2.25 4.75-5" />
        </svg>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="fillo-file-state fillo-file-state--failed" aria-hidden="true">
        <svg
          className="fillo-file-state-icon"
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M3.75 12a8.25 8.25 0 1 0 16.5 0 8.25 8.25 0 1 0-16.5 0" />
          <path d="M12 7.75v5.5" />
          <path d="M12 16.5h.01" />
        </svg>
      </span>
    );
  }
  return (
    <span className="fillo-file-state fillo-file-state--uploading" aria-hidden="true">
      <svg
        className="fillo-file-state-icon"
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M7.25 3.75h6.5l3 3v13.5h-9.5z" />
        <path d="M13.75 3.75v3h3" />
      </svg>
    </span>
  );
}

function CloseIcon() {
  return (
    <svg
      className="fillo-file-action-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

/**
 * Default file upload field: drag & drop, multiple files, live progress, and
 * provider-aware browser-direct transfer (resumable where supported). Replace
 * it via `components` if needed; completed uploads are FileValue[] in the data.
 */
export function FileUploadField({
  field,
  value,
  error,
  setValue,
  api,
  ids: providedIds,
}: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const slots = useFieldSlots(field, error);
  const strings = useStrings();
  const chrome = useFilloChrome();
  const schema = field as FileUploadFieldSchema;
  const inputRef = useRef<HTMLInputElement>(null);
  const [inFlight, setInFlight] = useState<InFlight[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Abort in-flight uploads on unmount and guard setState so a form that
  // navigates away mid-upload doesn't leak a transfer or warn on a dead component.
  const mountedRef = useRef(true);
  const controllers = useRef(new Map<string, AbortController>());
  // Count active uploads so submit only unblocks when every file in this field
  // is done — not when the first of several finishes.
  const inFlightCount = useRef(0);
  const setUploading = api.setUploading;
  const fieldId = field.id;
  useEffect(() => {
    // React development StrictMode replays effect setup/cleanup once. Restore
    // the live flag during setup so the second mount can accept completions.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllers.current.forEach((c) => c.abort());
      // A condition/page change can unmount only this field while the form
      // stays alive. Release its controller-level submit lock immediately.
      if (inFlightCount.current > 0) setUploading(fieldId, false);
    };
  }, [fieldId, setUploading]);

  const files = (Array.isArray(value) ? value : []) as FileValue[];
  // Async uploads from the same selection complete independently. Keep a
  // current accumulator so the second completion cannot overwrite the first
  // with the stale `api.data` captured when both uploads started.
  const filesRef = useRef<FileValue[]>(files);
  filesRef.current = files;
  const maxFiles = schema.maxFiles ?? 1;
  const configuredMaxMb = schema.maxFileSizeMb ?? 500;
  const maxMb = chrome?.uploadFileSizeLimitMb
    ? Math.min(configuredMaxMb, chrome.uploadFileSizeLimitMb)
    : configuredMaxMb;
  const maxBytes = maxMb * 1024 * 1024;
  // The server can keep an optional-upload form open while refusing new file
  // sessions. Disable only this control; developer chrome additionally gets
  // the dashboard deep link that fixes the storage state.
  const renderOnly = chrome?.renderOnly === true;
  const storageBlocked = chrome?.uploadsAvailable === false;
  const storageUrl = storageBlocked && chrome?.devChrome ? safeHttpUrl(chrome.warningUrl) : null;
  const canUpload = !renderOnly && Boolean(api.client && api.formId) && !storageBlocked;
  // A failed row still occupies the list until dismissed, but it holds no slot —
  // counting it would hide the dropzone and strand the field after one failure.
  const activeInFlight = inFlight.filter((f) => !f.error).length;
  const remaining = maxFiles - files.length - activeInFlight;

  async function startUpload(file: File) {
    // No capacity left (field already at maxFiles) — starting would upload then
    // get sliced off on success, orphaning it. The drop handler pre-filters too;
    // this guards the retry path and any other caller.
    if (maxFiles - filesRef.current.length - inFlightCount.current <= 0) return;
    const key = `${file.name}-${file.size}-${Math.floor(performance.now())}`;
    if (file.size > maxBytes) {
      setInFlight((prev) => [
        ...prev,
        {
          key,
          name: file.name,
          size: file.size,
          fraction: 0,
          file,
          tooLarge: true,
          error: strings.fileTooLarge(maxMb),
        },
      ]);
      return;
    }
    setInFlight((prev) => [...prev, { key, name: file.name, size: file.size, fraction: 0, file }]);
    inFlightCount.current += 1;
    setUploading(fieldId, true);
    const controller = new AbortController();
    controllers.current.set(key, controller);
    try {
      const uploaded = await api.client!.uploadFile(api.formId!, file, {
        fieldId,
        signal: controller.signal,
        onProgress: ({ fraction }) => {
          if (mountedRef.current) {
            setInFlight((prev) => prev.map((f) => (f.key === key ? { ...f, fraction } : f)));
          }
        },
      });
      if (!mountedRef.current) return;
      setInFlight((prev) => prev.filter((f) => f.key !== key));
      const next = [...filesRef.current, uploaded].slice(0, maxFiles);
      filesRef.current = next;
      setValue(next);
    } catch (err) {
      // Aborted (cancel/unmount) or failed. Cancellation is not an error. For
      // genuine failures, preserve the full SDK diagnostic for the host while
      // keeping provider prose out of the respondent-facing row.
      if (mountedRef.current && !controller.signal.aborted) {
        if (err instanceof Error && err.name === "FilloError") {
          chrome?.onError?.(err as FilloError);
        }
        const message = uploadFailureMessage(err, strings);
        setInFlight((prev) => prev.map((f) => (f.key === key ? { ...f, error: message } : f)));
      }
    } finally {
      controllers.current.delete(key);
      inFlightCount.current -= 1;
      if (mountedRef.current && inFlightCount.current === 0) setUploading(fieldId, false);
    }
  }

  function cancelUpload(key: string) {
    controllers.current.get(key)?.abort();
    setInFlight((prev) => prev.filter((f) => f.key !== key));
  }

  function handleFiles(list: FileList | null) {
    if (!list) return;
    const currentRoom = Math.max(0, maxFiles - filesRef.current.length - inFlightCount.current);
    Array.from(list)
      .slice(0, currentRoom)
      .forEach((file) => void startUpload(file));
    if (inputRef.current) inputRef.current.value = "";
  }

  function removeFile(fileId: string) {
    const next = filesRef.current.filter((f) => f.fileId !== fileId);
    filesRef.current = next;
    setValue(next);
  }

  const describedBy =
    [field.description ? ids.descriptionId : null, error ? ids.errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div
      {...slots.wrapperProps(
        `fillo-field fillo-field--file_upload${error ? " fillo-field--error" : ""}`,
      )}
    >
      <label className={slots.label} data-fillo="label" id={ids.labelId} htmlFor={ids.inputId}>
        {field.label}
        {!field.required && <span className="fillo-optional">{strings.optional}</span>}
      </label>
      {field.description && (
        <p className={slots.description} data-fillo="fieldDescription" id={ids.descriptionId}>
          {field.description}
        </p>
      )}

      {remaining > 0 && (
        <div
          data-fillo="control"
          data-drag-over={dragOver ? "" : undefined}
          className={slots.control(
            `fillo-dropzone${dragOver ? " fillo-dropzone--over" : ""}${canUpload ? "" : " fillo-dropzone--disabled"}`,
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (canUpload) handleFiles(e.dataTransfer.files);
          }}
          onClick={() => canUpload && inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-disabled={!canUpload || undefined}
          // The dropzone is the operable control, so the accessible name + state
          // live here (not on the display:none input, where focus is a no-op and
          // focusFirstInvalid couldn't land). No aria-required: role="button"
          // doesn't support it (axe aria-allowed-attr, ledger #1) — the field's
          // required-ness is still conveyed by the shell's required styling.
          aria-labelledby={ids.labelId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (canUpload) inputRef.current?.click();
            }
          }}
        >
          <input
            ref={inputRef}
            id={ids.inputId}
            type="file"
            hidden
            disabled={!canUpload}
            multiple={maxFiles > 1}
            accept={schema.accept?.join(",")}
            onChange={(e) => canUpload && handleFiles(e.target.files)}
          />
          {canUpload ? (
            <>
              <span className="fillo-dropzone-title">{strings.dropzoneTitle(maxFiles > 1)}</span>
              <span className="fillo-dropzone-hint">{strings.dropzoneHint(maxMb)}</span>
            </>
          ) : storageBlocked && chrome?.devChrome ? (
            <span className="fillo-dropzone-hint">
              Connect file storage to enable uploads
              {storageUrl && (
                <>
                  {" — "}
                  <a href={storageUrl} target="_blank" rel="noopener noreferrer">
                    {storageUrl}
                  </a>
                </>
              )}
            </span>
          ) : (
            <span className="fillo-dropzone-hint">
              {renderOnly
                ? strings.uploadsRenderOnly
                : storageBlocked
                  ? strings.uploadsUnavailable
                  : strings.uploadsDisabled}
            </span>
          )}
        </div>
      )}

      {/* Screen-reader narration of the upload lifecycle. Submit is disabled
          while uploads are active, so the "please wait" message explains why
          and the re-enable is implicit when the message clears. WCAG 4.1.3.
          Hidden inline (off-screen, never display:none — that mutes aria-live)
          so it stays invisible without the optional stylesheet. */}
      <div
        role="status"
        aria-live="polite"
        className="fillo-sr-only"
        style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}
      >
        {uploadStatus(inFlight, files.length, strings)}
      </div>

      {(inFlight.length > 0 || files.length > 0) && (
        <ul className="fillo-files">
          {files.map((f) => (
            <li key={f.fileId} className="fillo-file fillo-file--done">
              <FileStateIcon state="done" />
              <span className="fillo-file-content">
                <span className="fillo-file-name">{f.name}</span>
                <span className="fillo-file-meta">{strings.uploadedFile(formatBytes(f.size))}</span>
              </span>
              <span className="fillo-file-actions">
                <button
                  type="button"
                  className="fillo-file-remove"
                  aria-label={`${strings.uploadRemove} ${f.name}`}
                  onClick={() => removeFile(f.fileId)}
                >
                  <CloseIcon />
                </button>
              </span>
            </li>
          ))}
          {inFlight.map((f) => (
            <li key={f.key} className={`fillo-file${f.error ? " fillo-file--failed" : ""}`}>
              <FileStateIcon state={f.error ? "failed" : "uploading"} />
              {f.error ? (
                <>
                  <span className="fillo-file-content">
                    <span className="fillo-file-name">{f.name}</span>
                    <span className="fillo-file-error" role="alert">
                      {f.error}
                    </span>
                  </span>
                  {/* Retry re-runs the upload (resuming an interrupted session
                      where the provider supports it). Suppressed for a local
                      size rejection (retrying can't help) and when the field is
                      already full (the retry would upload then be sliced off —
                      only Dismiss makes sense then). */}
                  <span className="fillo-file-actions">
                    {f.file && !f.tooLarge && remaining > 0 && (
                      <button
                        type="button"
                        className="fillo-file-retry"
                        aria-label={`${strings.uploadRetry} ${f.name}`}
                        onClick={() => {
                          const retryFile = f.file;
                          if (!retryFile) return;
                          setInFlight((prev) => prev.filter((x) => x.key !== f.key));
                          void startUpload(retryFile);
                        }}
                      >
                        {strings.uploadRetry}
                      </button>
                    )}
                    <button
                      type="button"
                      className="fillo-file-remove"
                      aria-label={`${strings.uploadDismiss} ${f.name}`}
                      onClick={() => setInFlight((prev) => prev.filter((x) => x.key !== f.key))}
                    >
                      <CloseIcon />
                    </button>
                  </span>
                </>
              ) : (
                <>
                  <span className="fillo-file-content">
                    <span className="fillo-file-name">{f.name}</span>
                    <span className="fillo-file-meta">
                      {strings.uploadingFile(Math.round(f.fraction * 100), formatBytes(f.size))}
                    </span>
                  </span>
                  <span className="fillo-file-actions">
                    <button
                      type="button"
                      className="fillo-file-remove"
                      aria-label={`${strings.uploadCancel} ${f.name}`}
                      onClick={() => cancelUpload(f.key)}
                    >
                      <CloseIcon />
                    </button>
                  </span>
                  <span
                    className="fillo-progress"
                    role="progressbar"
                    aria-label={`Uploading ${f.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(f.fraction * 100)}
                  >
                    <span
                      className="fillo-progress-bar"
                      style={{ width: `${f.fraction * 100}%` }}
                    />
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className={slots.error} data-fillo="error" id={ids.errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
