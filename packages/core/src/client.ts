import type {
  FileValue,
  FormBranding,
  FormSchema,
  FormTheme,
  ResponseData,
  UploadSession,
  UploadTransport,
} from "./types.js";
import { Sha1, bytesToBase64, sha1Base64 } from "./sha1.js";
import { createId } from "./ids.js";
import {
  FILLO_SCHEMA_VERSION,
  FILLO_SDK_VERSION,
  normalizeFormSchema,
  normalizeFormTheme,
} from "./schema-validation.js";

export interface FilloClientOptions {
  /**
   * Publishable project key (pk_…) — safe to ship in client code. Required
   * only for syncing code-defined forms into the workspace.
   */
  key?: string;
  /**
   * Internal: send requests to this page's own origin instead of the hosted
   * API. Used only by Fillo's own first-party pages (hosted forms, marketing)
   * so they hit localhost in dev and fillo.so in prod. Not for embedding.
   */
  sameOrigin?: boolean;
  /**
   * Target a different Fillo server (staging, tests, a proxy on your own
   * domain). Defaults to the hosted API; wins over sameOrigin.
   */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Public human-verification challenge config the SDK needs to render a widget.
 * Delivered as a TOP-LEVEL field on the form GET (never inside the schema): the
 * schema's trust policy is server-only and stripped, but the widget needs the
 * PUBLIC site key. Injected server-side from Fillo's env — the SECRET key never
 * leaves the server. Absent = no challenge (render nothing, load no script).
 */
export interface ChallengeConfig {
  provider: "turnstile";
  /** Cloudflare Turnstile PUBLIC site key. Safe to ship to the browser. */
  siteKey: string;
  /**
   * Absolute URL of the Fillo-hosted challenge bridge page. When present,
   * renderers embed this page in a small iframe and receive the solved token
   * over postMessage — the widget then runs on Fillo's own hostname, so the
   * check works on ANY host domain with zero Cloudflare configuration.
   * Absent (older server): renderers load the Turnstile script directly into
   * the host page, which Cloudflare only allows on allowlisted hostnames.
   */
  bridgeUrl?: string;
}

/** Theme for the human-verification widget. "auto" follows the visitor's OS
 *  preference; hosts with their own theme switch pass "light"/"dark". */
export type ChallengeTheme = "auto" | "light" | "dark";

export interface PublishedForm {
  id: string;
  slug: string;
  /** Wire contract version for server-provided schema data. */
  schemaVersion?: number;
  /** Lowest SDK version the server expects for this form payload. */
  minSdkVersion?: string;
  /** Data-only feature flags exposed by the server. */
  capabilities?: string[];
  schema: FormSchema;
  theme: FormTheme | null;
  /** True when the server says the form cannot accept responses. */
  closed?: boolean;
  /**
   * Whether a submission would be accepted right now. Absent on older servers
   * — renderers must then keep today's behavior. When false, the default
   * renderers show the not-open state instead of a fillable form.
   */
  accepting?: boolean;
  /**
   * Companion to `accepting` — present only when it is false.
   * `draft`: not published yet; `expired`/`capped`: the unclaimed preview
   * workspace hit its time window or response cap. Storage reasons may be
   * returned for drafts or by older servers; published upload readiness is
   * represented independently by `uploadsAvailable`.
   */
  acceptingReason?: "draft" | "expired" | "capped" | "storage_required" | "storage_full";
  /** Whether new file uploads can start right now. Absent on older servers is
   * treated as available; this never changes whether ordinary answers submit. */
  uploadsAvailable?: boolean;
  /** Server-owned per-file ceiling for the active storage lane. Renderers use
   * the lower of this and the field's configured maxFileSizeMb. */
  uploadFileSizeLimitMb?: number;
  /** Workspace branding state — absent means show the badge (default). */
  branding?: FormBranding;
  /** Human-verification challenge to render before submit, when the form
   *  requires one. Absent = no challenge. Carries only the PUBLIC site key. */
  challenge?: ChallengeConfig;
}

export type SubmitResult =
  | {
      ok: true;
      responseId: string;
      /** True when the API accepted the request as an already-recorded visitor response. */
      duplicate?: boolean;
      /** True when an update-in-place limit (responseLimit onRepeat "update") updated the person's living response. */
      updated?: boolean;
      errors?: undefined;
    }
  | {
      ok: false;
      /** fieldId -> message when the server rejects the submission. */
      errors: Record<string, string>;
      responseId?: undefined;
      duplicate?: undefined;
    };

/** Anti-spam signals collected by the renderer. */
export interface SubmitMeta {
  /** Honeypot value — must be empty for humans. */
  hp?: string;
  /** Time from first render to submit. */
  elapsedMs?: number;
  /** Embedding surface, recorded per response for measurement — never gated. */
  surface?: "default" | "headless";
  /**
   * Browser page context used by connected analytics/CRM destinations. Fillo
   * reads an existing HubSpot tracking cookie when present but never creates
   * one or loads tracking code.
   */
  attribution?: {
    pageUri?: string;
    pageName?: string;
    hubspotutk?: string;
  };
  /**
   * Browser-scoped de-duplication key sent when a form opts into
   * settings.responseLimit.by = "browser".
   */
  submissionKey?: string;
  /**
   * Saved-progress draft this submission completes (forms with
   * settings.saveProgress). The server deletes the draft with the response
   * commit so it can't be resumed after submitting.
   */
  draft?: { id: string; token: string };
  /**
   * Host-app account context for this respondent (identify()). Recorded with
   * the response and shown in the dashboard/webhooks as a CLAIM from the
   * embedding page — it is metadata, not authentication. `id` is your own
   * stable user/account id.
   */
  respondent?: FilloRespondent;
  /**
   * Human-verification challenge token (e.g. from the Cloudflare Turnstile
   * widget). Present only when the form requires a challenge; the server
   * verifies it and rejects the submit if it is missing or invalid. Never a
   * secret — it is a single-use, server-verifiable proof of the widget solve.
   */
  challengeToken?: string;
}

/**
 * The host app's account context for the person filling the form. Passed as
 * the `respondent` option on FilloForm / FilloProvider / renderForm /
 * createFormController; Fillo keys responses to it so the dashboard,
 * webhooks, and integrations can say WHO answered.
 */
export interface FilloRespondent {
  /** Your stable user/account id — the identity key within your project. */
  id: string;
  email?: string;
  name?: string;
  /** Small primitive facts (plan, role, region…) — not a data warehouse. */
  traits?: Record<string, string | number | boolean>;
  /**
   * Identity verification (optional): hex HMAC-SHA256 of `id`, computed on
   * YOUR server with the project identity secret from Fillo settings. Once
   * the project holds a secret, Fillo records identity only with a valid
   * hash — never compute this in the browser or the secret leaks.
   */
  hash?: string;
}

/** Wire shape of a saved-progress draft (settings.saveProgress forms). */
export interface ResponseDraft {
  id: string;
  formId: string;
  /** Partial answers exactly as last saved — validated only at submit. */
  data: ResponseData;
  /** 0-based page the respondent was on when the draft was last saved. */
  page: number;
  /** A freshly rotated bearer, returned only when adopting a resume link — the
   *  URL token is spent, so this is what future saves must use. */
  token?: string;
}

export interface CreatedDraft {
  id: string;
  /**
   * Per-draft bearer, returned once at creation; sent back as
   * X-Fillo-Draft-Token on every read/save/delete of this draft.
   */
  token: string;
  /** ISO timestamp; the server slides it forward on every save. */
  expiresAt?: string;
  /**
   * True when a VERIFIED identity picked up its existing draft from another
   * device — the token was rotated to this caller, and the draft's answers
   * were left untouched (fetch them with getDraft to restore).
   */
  existing?: boolean;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  /** 0..1 */
  fraction: number;
}

export interface UploadFileOptions {
  fieldId: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Resume an interrupted session instead of starting fresh. */
  sessionId?: string;
  /** Ownership token for the resumed session (from the original create call). */
  uploadToken?: string;
  /** Persist this handle if the host wants reload-safe resumability. */
  onSession?: (handle: { sessionId: string; uploadToken?: string }) => void;
}

export class FilloError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** Server-suggested wait (from a 429's Retry-After header), seconds. */
    public retryAfterSec?: number,
    /** Stable machine-readable API error code, when the server provides one. */
    public code?: string,
  ) {
    super(message);
    this.name = "FilloError";
  }
}

/** Duck-typed — `instanceof` breaks when two SDK copies end up in one bundle. */
export function isFilloError(err: unknown): err is FilloError {
  return err instanceof Error && err.name === "FilloError";
}

/** Extract the server's public message and stable code from a failed response. */
async function errorDetails(
  res: Response,
  fallback: string,
): Promise<{ message: string; code?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    return {
      message: typeof body.error === "string" && body.error ? body.error : fallback,
      code: typeof body.code === "string" && body.code ? body.code : undefined,
    };
  } catch {
    // Non-JSON body — keep the fallback.
  }
  return { message: fallback };
}

function retryAfterSec(res: Response): number | undefined {
  const raw = Number(res.headers.get("retry-after"));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

const MAX_CHUNK_RETRIES = 3;

/** Default per-request timeout — a hung connection must not wedge the form forever. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Large direct-to-S3 parts need more time than ordinary JSON/API requests. */
const S3_PART_TIMEOUT_MS = 5 * 60_000;

/** S3 activation/finalization performs bounded server-owned provider work. */
const UPLOAD_CONTROL_TIMEOUT_MS = 10 * 60_000;

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function isControlRetryable(error: unknown, includeBusy = false): boolean {
  const status = isFilloError(error) ? (error.status ?? 0) : 0;
  return (
    status === 0 ||
    status === 503 ||
    status === 504 ||
    (includeBusy && status === 409 && isFilloError(error) && error.retryAfterSec !== undefined)
  );
}

/** Transient HTTP statuses worth retrying (server/overload/timeout). */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** Turn an AbortSignal.timeout rejection into a clear FilloError instead of an opaque AbortError. */
function asRequestError(err: unknown): unknown {
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "TimeoutError"
  )
    return new FilloError("Request timed out", 0);
  return err;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function assertPublishedFormCompatible(form: PublishedForm): void {
  if (form.schemaVersion !== undefined && form.schemaVersion !== FILLO_SCHEMA_VERSION) {
    throw new FilloError(
      `This form uses schema version ${form.schemaVersion}; this SDK supports version ${FILLO_SCHEMA_VERSION}. Update @usefillo/* to render it.`,
      426,
    );
  }
  if (form.minSdkVersion && compareVersions(FILLO_SDK_VERSION, form.minSdkVersion) < 0) {
    throw new FilloError(
      `This form requires @usefillo/* ${form.minSdkVersion} or newer. Current SDK is ${FILLO_SDK_VERSION}.`,
      426,
    );
  }
}

function makeReporter(totalBytes: number, options: UploadFileOptions) {
  return (uploadedBytes: number) =>
    options.onProgress?.({
      uploadedBytes,
      totalBytes,
      fraction: totalBytes === 0 ? 1 : uploadedBytes / totalBytes,
    });
}

/** SHA-1 of one Box part, base64. Native (fast) where available, else vendored. */
async function digestPartBase64(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest("SHA-1", bytes as BufferSource);
    return bytesToBase64(new Uint8Array(buf));
  }
  return sha1Base64(bytes);
}

/** The hosted Fillo API — where every client sends requests. */
const DEFAULT_BASE_URL = "https://fillo.so";

export interface SyncFormResult {
  formId: string;
  slug: string;
  /** Absolute Fillo dashboard URL for reviewing and publishing this form.
   *  This is server-owned and intentionally independent of `client.baseUrl`,
   *  which may point at an app-owned API proxy. */
  manageUrl?: string;
  branding?: FormBranding;
  /** Human-verification challenge to render before submit, when the LIVE form
   *  requires one (staged changes don't gate until published). Absent = no
   *  challenge. Carries only the PUBLIC site key. */
  challenge?: ChallengeConfig;
  /** Lifecycle on newer servers: a draft can't accept public responses yet. */
  status?: "draft" | "published";
  /** Changes were staged as a draft for a human to publish. */
  staged?: boolean;
  /**
   * Whether a submission would be accepted right now. Absent on older servers
   * — renderers must then keep today's behavior. When false, the default
   * renderers show the not-open state instead of a fillable form.
   */
  accepting?: boolean;
  /**
   * Companion to `accepting` — present only when it is false.
   * `draft`: not published yet; `expired`/`capped`: the unclaimed preview
   * workspace hit its time window or response cap; `storage_required`: the
   * form needs a connected storage destination before it can go live;
   * `storage_full`: Fillo's temporary upload allowance is exhausted.
   */
  acceptingReason?: "draft" | "expired" | "capped" | "storage_required" | "storage_full";
  /** Whether new file uploads can start right now. This is independent from
   * response acceptance so a completed file can still be submitted after the
   * workspace reaches its upload cap. Absent on older servers means available. */
  uploadsAvailable?: boolean;
  /** Server-owned per-file ceiling for the active storage lane. Renderers use
   * the lower of this and the field's configured maxFileSizeMb. */
  uploadFileSizeLimitMb?: number;
  /**
   * Server-authoritative live snapshot. Present when the incoming code schema
   * is not the version respondents may submit against yet.
   */
  resolvedSchema?: FormSchema;
  resolvedTheme?: FormTheme | null;
  /** Non-fatal integration problem; the resolved live snapshot remains usable. */
  syncError?: { code: string; message: string };
  /**
   * Human-readable storage heads-up for the form owner. This can be advisory
   * while uploads and responses remain available; never use it to gate UI.
   */
  warning?: string;
  /**
   * Machine-readable owner advisory for `warning`. Hard unavailability uses
   * `"storage_required"`; transit threshold advisories use distinct codes.
   * Point the human at `warningUrl`; use `uploadsAvailable`, not this field,
   * to gate new file controls.
   */
  warningCode?: string;
  /**
   * Absolute dashboard URL where a human connects a storage destination.
   * Present whenever `warningCode` is.
   */
  warningUrl?: string;
}

/** SDK version for server observability. Sent only with JSON-body requests —
 * adding it to bare GETs would force a CORS preflight on every form load. */
const CLIENT_HEADER = { "X-Fillo-Client": `@usefillo/core@${FILLO_SDK_VERSION}` };

export class FilloClient {
  /** Server origin this client targets, normalized (no trailing slash). */
  readonly baseUrl: string;
  private fetch: typeof fetch;
  /** Publishable project key, when configured. */
  readonly key?: string;

  constructor(options: FilloClientOptions = {}) {
    this.baseUrl = options.baseUrl
      ? options.baseUrl.replace(/\/$/, "")
      : options.sameOrigin
        ? ""
        : DEFAULT_BASE_URL;
    this.key = options.key;
    // Bind to globalThis — passing window.fetch unbound throws in browsers.
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    // Only send Content-Type when there's a JSON body — a bare GET with the
    // header forces a CORS preflight on every form load.
    const headers =
      init?.body != null
        ? { "Content-Type": "application/json", ...CLIENT_HEADER, ...init?.headers }
        : init?.headers;
    let res: Response;
    try {
      res = await this.fetch(this.url(path), {
        ...init,
        headers,
        signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw asRequestError(err);
    }
    if (!res.ok) {
      const { message, code } = await errorDetails(res, `Request failed: ${res.status}`);
      throw new FilloError(message, res.status, retryAfterSec(res), code);
    }
    return (await res.json()) as T;
  }

  /** Fetch a published form definition by id or slug. */
  async getForm(idOrSlug: string): Promise<PublishedForm> {
    const form = await this.json<PublishedForm>(`/forms/${encodeURIComponent(idOrSlug)}`);
    assertPublishedFormCompatible(form);
    return form;
  }

  /**
   * Resolve a code-defined form through the workspace identified by the
   * client's publishable key. Depending on project policy, changed content
   * may be staged for review or resolved to the authoritative live snapshot.
   * Returns the canonical form id used for submissions.
   */
  syncForm(handle: string, schema: FormSchema, theme?: FormTheme | null): Promise<SyncFormResult> {
    if (!this.key) {
      return Promise.reject(
        new FilloError("createClient needs a `key` (pk_…) to sync code-defined forms", 401),
      );
    }
    const normalized = normalizeFormSchema(schema);
    if (!normalized.ok) {
      return Promise.reject(new FilloError(`Invalid form schema: ${normalized.error}`, 400));
    }
    return this.json<SyncFormResult>("/forms/sync", {
      method: "POST",
      body: JSON.stringify({
        key: this.key,
        id: handle,
        schema: normalized.schema,
        theme: normalizeFormTheme(theme),
      }),
    });
  }

  /** Submit a response. Returns per-field errors instead of throwing on validation failure. */
  async submit(formId: string, data: ResponseData, meta?: SubmitMeta): Promise<SubmitResult> {
    let res: Response;
    try {
      res = await this.fetch(this.url(`/forms/${encodeURIComponent(formId)}/responses`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
        body: JSON.stringify({ data, meta }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw asRequestError(err);
    }
    if (res.status === 422) {
      const body = (await res.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        errors?: unknown;
      } | null;
      if (body?.errors && typeof body.errors === "object" && !Array.isArray(body.errors)) {
        return { ok: false, errors: body.errors as Record<string, string> };
      }
      throw new FilloError(
        typeof body?.error === "string" && body.error ? body.error : "Submit failed: 422",
        422,
        retryAfterSec(res),
        typeof body?.code === "string" && body.code ? body.code : undefined,
      );
    }
    if (!res.ok) {
      // Surface the server's own message ("Form not found — …", workspace
      // closed, …) instead of a bare status the respondent can't act on.
      const { message, code } = await errorDetails(res, `Submit failed: ${res.status}`);
      throw new FilloError(message, res.status, retryAfterSec(res), code);
    }
    const body = (await res.json()) as { id: string; duplicate?: boolean; updated?: boolean };
    return { ok: true, responseId: body.id, duplicate: body.duplicate, updated: body.updated };
  }

  /**
   * The identified person's own living response on an upsert-mode form —
   * used to prefill their answers for editing. Requires a VERIFIED identity
   * ({id, hash}); anything else 404s (returned as null), because an
   * unverified read would hand anyone's answers to any page script.
   *
   * `scopeValue` scopes the lookup for forms whose response limit is keyed to
   * a field (responseLimit.scopeField) — e.g. one response per article. When
   * the form is scoped, the server returns 404 unless the matching scope value
   * is sent, so a page loaded for article B never prefills article A's answers.
   * Optional and back-compatible: omit it for unscoped forms.
   */
  async fetchOwnResponse(
    formId: string,
    respondent: FilloRespondent,
    scopeValue?: string,
  ): Promise<{ responseId: string; data: ResponseData } | null> {
    try {
      return await this.json<{ responseId: string; data: ResponseData }>(
        `/forms/${encodeURIComponent(formId)}/respondent-response`,
        { method: "POST", body: JSON.stringify({ respondent, scopeValue }) },
      );
    } catch (err) {
      if (isFilloError(err) && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  /**
   * Open a respondent session for funnel analysis. Fire-and-forget: returns the
   * session id, or null if tracking is unavailable (never blocks the form).
   */
  async startSession(formId: string, pageCount: number): Promise<string | null> {
    try {
      const res = await this.fetch(this.url(`/forms/${encodeURIComponent(formId)}/sessions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageCount }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { id: string };
      return body.id;
    } catch {
      return null;
    }
  }

  /** Report progress on a session (furthest page reached, or completion). */
  reportProgress(sessionId: string, data: { furthestPage?: number; completed?: boolean }): void {
    try {
      void this.fetch(this.url(`/sessions/${encodeURIComponent(sessionId)}/progress`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        keepalive: true,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      }).catch(() => {});
    } catch {
      // Never let analytics break the form.
    }
  }

  /**
   * Create a saved-progress draft (forms with settings.saveProgress). Returns
   * the draft id and its ownership token — the token is shown only once.
   */
  createDraft(
    formId: string,
    body: { data: ResponseData; page?: number; respondent?: FilloRespondent },
  ): Promise<CreatedDraft> {
    return this.json<CreatedDraft>(`/forms/${encodeURIComponent(formId)}/drafts`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Fetch a draft to restore. 404s once expired, consumed, or deleted. When
   *  `adopt` is set (resume-link adoption), the server rotates the bearer and
   *  returns the new `token` — the URL token becomes single-use. */
  getDraft(draftId: string, token: string, adopt?: boolean): Promise<ResponseDraft> {
    return this.json<ResponseDraft>(`/drafts/${encodeURIComponent(draftId)}`, {
      headers: adopt
        ? { "X-Fillo-Draft-Token": token, "X-Fillo-Draft-Adopt": "1" }
        : { "X-Fillo-Draft-Token": token },
    });
  }

  /**
   * Overwrite a draft's answers/page and slide its expiry. `keepalive` lets a
   * tab-close flush outlive the page; browsers reject keepalive bodies over
   * ~64KB, in which case this save is simply lost — the debounced autosaves
   * every few keystrokes are the real persistence, the flush is a bonus.
   */
  async saveDraft(
    draftId: string,
    token: string,
    body: { data: ResponseData; page?: number },
    opts?: { keepalive?: boolean },
  ): Promise<void> {
    await this.json<{ ok: true }>(`/drafts/${encodeURIComponent(draftId)}`, {
      method: "PATCH",
      headers: { "X-Fillo-Draft-Token": token },
      body: JSON.stringify(body),
      ...(opts?.keepalive ? { keepalive: true } : {}),
    });
  }

  /** Discard a draft (the "Start over" path). */
  async deleteDraft(draftId: string, token: string): Promise<void> {
    await this.json<{ ok: true }>(`/drafts/${encodeURIComponent(draftId)}`, {
      method: "DELETE",
      headers: { "X-Fillo-Draft-Token": token },
    });
  }

  /** Current state of an upload session — used to resume after interruption. */
  getUploadSession(
    sessionId: string,
    token?: string,
    signal: AbortSignal = AbortSignal.timeout(UPLOAD_CONTROL_TIMEOUT_MS),
  ): Promise<UploadSession> {
    return this.json<UploadSession>(`/uploads/${encodeURIComponent(sessionId)}`, {
      ...(token ? { headers: { "X-Fillo-Upload-Token": token } } : {}),
      signal,
    });
  }

  /**
   * Provider-aware browser-direct upload. Creates a session, uses the storage
   * transport selected by the server, reports progress, and finalizes into a
   * FileValue. Resumable providers can continue an existing session; one-shot
   * transports are retried according to their own safe semantics.
   *
   * Depending on the form's storage settings the server picks a transport:
   * direct-to-Google-Drive resumable
   * sessions — in which case the bytes go straight from this browser to the
   * form owner's Drive and never touch the Fillo server.
   */
  async uploadFile(
    formId: string,
    file: File | Blob,
    options: UploadFileOptions,
  ): Promise<FileValue> {
    // `File` is not global in every Node/SSR runtime even though `Blob` is.
    // Keep the documented Blob path usable without evaluating an absent global.
    const name = typeof File !== "undefined" && file instanceof File ? file.name : "upload.bin";
    const mime = (file.type || "application/octet-stream").trim().toLowerCase();

    let session: UploadSession;
    if (options.sessionId) {
      const resumed = await this.getUploadSession(
        options.sessionId,
        options.uploadToken,
        this.uploadSignal(options, UPLOAD_CONTROL_TIMEOUT_MS),
      );
      // File.type is lowercase per the File API; normalize the persisted value
      // so sessions opened by older/non-browser clients compare equivalently.
      if (
        resumed.formId !== formId ||
        resumed.fieldId !== options.fieldId ||
        resumed.fileName !== name ||
        resumed.size !== file.size ||
        resumed.mime.trim().toLowerCase() !== mime
      ) {
        throw new FilloError("File does not match this upload session", 400);
      }
      // Preserve the caller's bearer for API-compatible implementations that
      // authenticate the status read without echoing the token in its body.
      session = resumed;
      session.token ||= options.uploadToken;
    } else {
      const requestId = createId(24);
      const requestToken = createId(32);
      const createSession = () =>
        this.json<UploadSession>(`/forms/${encodeURIComponent(formId)}/uploads`, {
          method: "POST",
          body: JSON.stringify({
            requestId,
            uploadToken: requestToken,
            fieldId: options.fieldId,
            fileName: name,
            size: file.size,
            mime,
          }),
          signal: this.uploadSignal(options, UPLOAD_CONTROL_TIMEOUT_MS),
        });
      const deadline = Date.now() + UPLOAD_CONTROL_TIMEOUT_MS;
      let backoffMs = 250;
      for (;;) {
        try {
          session = await createSession();
          break;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (!isControlRetryable(error, true)) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw error;
          await waitForRetry(Math.min(backoffMs, remaining), options.signal);
          backoffMs = Math.min(backoffMs * 2, 5_000);
        }
      }
    }

    options.onSession?.({
      sessionId: session.id,
      uploadToken: session.token,
    });

    if (session.status === "complete" && session.file) return session.file;
    if (session.status === "aborted")
      throw new FilloError("This upload session was cancelled", 409);

    // Box commits/verifies server-side, so its loop returns the data the
    // /complete step needs (parts + digest, or the uploaded file id).
    let completeBody: unknown;
    if (session.transport?.type === "gdrive") {
      await this.driveUploadLoop(session, session.transport.uploadUrl, file, options);
    } else if (session.transport?.type === "s3-multipart") {
      await this.s3MultipartUploadLoop(session, file, options);
    } else if (session.transport?.type === "s3-put") {
      await this.s3PutUpload(session.transport.uploadUrl, file, options);
    } else if (session.transport?.type === "box") {
      completeBody = await this.boxUpload(session.transport, file, options);
    } else {
      throw new FilloError(
        "This form's storage doesn't support uploads — connect Drive, S3, or Box.",
      );
    }

    const finalize = () =>
      this.json<UploadSession>(`/uploads/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: session.token ? { "X-Fillo-Upload-Token": session.token } : undefined,
        ...(completeBody ? { body: JSON.stringify(completeBody) } : {}),
        signal: this.uploadSignal(options, UPLOAD_CONTROL_TIMEOUT_MS),
      });
    let done: UploadSession;
    try {
      done = await finalize();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!isControlRetryable(error)) throw error;

      // A timeout can lose only the response after provider + DB completion.
      // Poll/retry under one bounded window: the original server request may
      // still own its lease when the first status read arrives.
      const deadline = Date.now() + UPLOAD_CONTROL_TIMEOUT_MS;
      let backoffMs = 250;
      for (;;) {
        const reconciled = await this.getUploadSession(
          session.id,
          session.token,
          this.uploadSignal(options, Math.max(1, deadline - Date.now())),
        );
        if (reconciled.status === "complete" && reconciled.file) {
          return reconciled.file;
        }
        if (reconciled.status === "aborted") throw error;
        try {
          done = await finalize();
          break;
        } catch (retryError) {
          if (options.signal?.aborted) throw retryError;
          if (!isControlRetryable(retryError, true)) throw retryError;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        await waitForRetry(Math.min(backoffMs, remaining), options.signal);
        backoffMs = Math.min(backoffMs * 2, 5_000);
      }
    }
    if (!done.file) throw new FilloError("Upload completed but no file was returned");
    return done.file;
  }

  /**
   * Box direct upload with a folder-scoped token (Box UI Elements pattern).
   * Small files go up in one multipart POST; large files run Box's chunked
   * session entirely from the client — create session, PUT each part with a
   * SHA-1 `Digest`, then commit with the whole-file digest. Bytes go straight to
   * Box; we return the new file id for /complete to verify server-side.
   */
  private async boxUpload(
    transport: Extract<UploadTransport, { type: "box" }>,
    file: File | Blob,
    options: UploadFileOptions,
  ): Promise<{ providerFileId?: string }> {
    const report = makeReporter(file.size, options);
    report(0);
    const auth = { Authorization: `Bearer ${transport.token}` };

    if (transport.mode === "simple") {
      const form = new FormData();
      form.append(
        "attributes",
        JSON.stringify({ name: transport.fileName, parent: { id: transport.folderId } }),
      );
      form.append("file", file, transport.fileName);
      const res = await this.retry(options, async () => {
        const r = await this.fetch(transport.uploadUrl, {
          method: "POST",
          headers: auth,
          body: form,
          signal: this.uploadSignal(options),
        });
        // Retry transient 5xx/429/408 inside retry(); 4xx stays terminal below.
        if (!r.ok && isRetryableStatus(r.status))
          throw new FilloError(`Box upload failed: ${r.status}`, r.status);
        return r;
      });
      if (!res.ok) throw new FilloError(`Box upload failed: ${res.status}`, res.status);
      const body = (await res.json()) as { entries?: Array<{ id: string }> };
      report(file.size);
      return { providerFileId: body.entries?.[0]?.id };
    }

    // The session is declared with transport.size but every part below is sized
    // and range-stamped from the actual file — bail loudly if they disagree
    // (stale resume, or the File changed) rather than failing mid-upload.
    if (transport.size !== file.size) {
      throw new FilloError(
        `File size changed since the upload was requested (${file.size} vs ${transport.size}).`,
        400,
      );
    }

    // 1. Create the upload session — Box dictates the part size.
    const sessionRes = await this.retry(options, async () => {
      const r = await this.fetch(transport.sessionUrl, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          folder_id: transport.folderId,
          file_size: transport.size,
          file_name: transport.fileName,
        }),
        signal: this.uploadSignal(options),
      });
      if (!r.ok && isRetryableStatus(r.status))
        throw new FilloError(`Box session failed: ${r.status}`, r.status);
      return r;
    });
    if (!sessionRes.ok)
      throw new FilloError(`Box session failed: ${sessionRes.status}`, sessionRes.status);
    const session = (await sessionRes.json()) as {
      part_size: number;
      session_endpoints: { upload_part: string; commit: string };
    };

    // 2. PUT each part, accumulating the whole-file digest as we go.
    const whole = new Sha1();
    const parts: unknown[] = [];
    let offset = 0;
    while (offset < file.size) {
      options.signal?.throwIfAborted();
      const end = Math.min(offset + session.part_size, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      whole.update(bytes);
      const partDigest = await digestPartBase64(bytes);
      const res = await this.retry(options, async () => {
        const r = await this.fetch(session.session_endpoints.upload_part, {
          method: "PUT",
          headers: {
            ...auth,
            "Content-Type": "application/octet-stream",
            Digest: `sha=${partDigest}`,
            "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`,
          },
          body: bytes,
          signal: this.uploadSignal(options),
        });
        if (!r.ok && isRetryableStatus(r.status))
          throw new FilloError(`Box part failed: ${r.status}`, r.status);
        return r;
      });
      if (!res.ok) throw new FilloError(`Box part failed: ${res.status}`, res.status);
      parts.push(((await res.json()) as { part: unknown }).part);
      offset = end;
      report(offset);
    }

    // 3. Commit the session with the whole-file SHA-1.
    const commitRes = await this.retry(options, async () => {
      const r = await this.fetch(session.session_endpoints.commit, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json",
          Digest: `sha=${bytesToBase64(whole.digest())}`,
        },
        body: JSON.stringify({ parts }),
        signal: this.uploadSignal(options),
      });
      if (!r.ok && isRetryableStatus(r.status))
        throw new FilloError(`Box commit failed: ${r.status}`, r.status);
      return r;
    });
    if (!commitRes.ok)
      throw new FilloError(`Box commit failed: ${commitRes.status}`, commitRes.status);
    const committed = (await commitRes.json()) as { entries?: Array<{ id: string }> };
    return { providerFileId: committed.entries?.[0]?.id };
  }

  /**
   * Caller signal (if any) combined with a fresh per-request timeout. Created per
   * fetch so each retry attempt gets its own deadline; the caller's own abort
   * still drives upload cancellation across every provider transport.
   */
  private uploadSignal(
    options: UploadFileOptions,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  }

  /** Retry a request with exponential backoff; never retries an aborted upload. */
  private async retry(options: UploadFileOptions, fn: () => Promise<Response>): Promise<Response> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (options.signal?.aborted) throw err;
        attempt += 1;
        if (attempt >= MAX_CHUNK_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  /**
   * Google Drive resumable protocol: PUT chunks with Content-Range; Drive
   * answers 308 + a Range header while incomplete, 200/201 when done. On
   * repeated failure we re-sync through our session endpoint (the server
   * queries Drive for the authoritative offset).
   */
  private async driveUploadLoop(
    session: UploadSession,
    uploadUrl: string,
    file: File | Blob,
    options: UploadFileOptions,
  ): Promise<void> {
    let offset = session.uploadedBytes;
    const report = makeReporter(file.size, options);
    report(offset);

    // Per-chunk retries are bounded by MAX_CHUNK_RETRIES, but the outer loop is
    // not: a proxy returning a 308 whose Range never advances the offset would
    // re-PUT the same chunk forever (attempt resets each outer pass). Bail if the
    // offset fails to advance across this many consecutive iterations.
    let stalls = 0;
    while (offset < file.size) {
      options.signal?.throwIfAborted();
      const startedAt = offset;
      let end = Math.min(offset + session.chunkSize, file.size);
      let chunk = file.slice(offset, end);

      let attempt = 0;
      for (;;) {
        try {
          const res = await this.fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`,
            },
            body: chunk,
            signal: this.uploadSignal(options),
          });
          if (res.status === 308) {
            // Range: bytes=0-N (inclusive). Absent legitimately means nothing
            // received yet (offset 0); but a header that's *present and
            // unparseable* (a proxy rewrote it) must NOT reset to 0 — re-sync
            // the authoritative offset instead of re-uploading the whole file.
            const range = res.headers.get("Range") ?? res.headers.get("range");
            const match = range?.match(/bytes=0-(\d+)/);
            if (match) offset = Number(match[1]) + 1;
            else if (range == null) offset = 0;
            else {
              offset = (
                await this.getUploadSession(
                  session.id,
                  session.token,
                  this.uploadSignal(options, UPLOAD_CONTROL_TIMEOUT_MS),
                )
              ).uploadedBytes;
            }
            break;
          }
          if (res.ok) {
            offset = file.size;
            break;
          }
          throw new FilloError(`Drive chunk failed: ${res.status}`, res.status);
        } catch (err) {
          if (options.signal?.aborted) throw err;
          attempt += 1;
          if (attempt >= MAX_CHUNK_RETRIES) throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          // Drive may have persisted part of the failed chunk, advancing the
          // authoritative offset into the middle of it. Re-sync AND recompute
          // end/chunk from the new offset — re-PUTting the old chunk with a
          // shifted Content-Range makes body length and declared range disagree,
          // so Drive 400s every retry and the upload can never resume.
          const fresh = await this.getUploadSession(
            session.id,
            session.token,
            this.uploadSignal(options, UPLOAD_CONTROL_TIMEOUT_MS),
          );
          offset = fresh.uploadedBytes;
          if (offset >= file.size) break;
          end = Math.min(offset + session.chunkSize, file.size);
          chunk = file.slice(offset, end);
        }
      }
      report(offset);
      if (offset <= startedAt) {
        if (++stalls >= MAX_CHUNK_RETRIES) {
          throw new FilloError(
            "Drive upload stalled — the storage endpoint stopped accepting progress",
            0,
          );
        }
      } else {
        stalls = 0;
      }
    }
  }

  /**
   * S3-compatible multipart protocol. Fillo owns the provider upload id and is
   * the only party allowed to complete it; the browser receives only narrowly
   * scoped UploadPart URLs. That keeps uploads resumable and means an old or
   * slow browser request cannot materialize an object after server-side abort.
   */
  private async s3MultipartUploadLoop(
    session: UploadSession,
    file: File | Blob,
    options: UploadFileOptions,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(session.chunkSize) ||
      session.chunkSize <= 0 ||
      !Number.isSafeInteger(session.uploadedBytes) ||
      session.uploadedBytes < 0 ||
      session.uploadedBytes > file.size ||
      (session.uploadedBytes < file.size && session.uploadedBytes % session.chunkSize !== 0)
    ) {
      throw new FilloError("S3 upload session returned invalid progress", 502);
    }

    const report = makeReporter(file.size, options);
    let offset = session.uploadedBytes;
    report(offset);

    // A zero-byte upload intentionally skips part signing. The server creates
    // and verifies the empty object in /complete because an empty multipart
    // upload cannot be assembled portably across S3-compatible providers.
    while (offset < file.size) {
      options.signal?.throwIfAborted();
      const partNumber = Math.floor(offset / session.chunkSize) + 1;
      if (partNumber > 10_000) {
        throw new FilloError("S3 upload needs too many parts", 413);
      }
      const end = Math.min(offset + session.chunkSize, file.size);
      const chunk = file.slice(offset, end);
      let attempt = 0;

      for (;;) {
        let uploadUrl: string;
        try {
          const signed = await this.json<{ uploadUrl?: unknown }>(
            `/uploads/${encodeURIComponent(session.id)}/parts`,
            {
              method: "POST",
              headers: session.token ? { "X-Fillo-Upload-Token": session.token } : undefined,
              body: JSON.stringify({ partNumber }),
              signal: this.uploadSignal(options, UPLOAD_CONTROL_TIMEOUT_MS),
            },
          );
          if (typeof signed.uploadUrl !== "string" || !signed.uploadUrl) {
            throw new FilloError("S3 part URL was unavailable", 502);
          }
          uploadUrl = signed.uploadUrl;

          const res = await this.fetch(uploadUrl, {
            method: "PUT",
            body: chunk,
            signal: this.uploadSignal(options, S3_PART_TIMEOUT_MS),
          });
          if (!res.ok) {
            throw new FilloError(`S3 part upload failed: ${res.status}`, res.status);
          }
          offset = end;
          report(offset);
          break;
        } catch (err) {
          if (options.signal?.aborted) throw err;

          // A timeout/network error can happen after the provider committed the
          // part but before the browser received its response. Ask Fillo, which
          // queries ListParts server-side, before deciding to retry. Blindly
          // replacing the same part can destroy a previously accepted part on
          // some S3-compatible stores if the replacement attempt then fails.
          const fresh = await this.getUploadSession(
            session.id,
            session.token,
            this.uploadSignal(options, UPLOAD_CONTROL_TIMEOUT_MS),
          );
          if (fresh.status === "aborted") {
            throw new FilloError("This upload session was cancelled", 409);
          }
          if (
            !Number.isSafeInteger(fresh.uploadedBytes) ||
            fresh.uploadedBytes < offset ||
            fresh.uploadedBytes > file.size ||
            (fresh.uploadedBytes < file.size && fresh.uploadedBytes % session.chunkSize !== 0)
          ) {
            throw new FilloError("S3 upload session returned invalid progress", 502);
          }
          if (fresh.uploadedBytes > offset) {
            offset = fresh.uploadedBytes;
            report(offset);
            break;
          }

          attempt += 1;
          if (attempt >= MAX_CHUNK_RETRIES) throw err;
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
    }
  }

  /**
   * S3-compatible single PUT to a presigned URL — bytes go straight to the
   * bucket. Not resumable (S3 single PUT is atomic), but retried on failure.
   */
  private async s3PutUpload(
    uploadUrl: string,
    file: File | Blob,
    options: UploadFileOptions,
  ): Promise<void> {
    const report = makeReporter(file.size, options);
    report(0);
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
          signal: this.uploadSignal(options),
        });
        if (!res.ok) throw new FilloError(`S3 upload failed: ${res.status}`, res.status);
        report(file.size);
        return;
      } catch (err) {
        if (options.signal?.aborted) throw err;
        attempt += 1;
        if (attempt >= MAX_CHUNK_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
}

export function createClient(options: FilloClientOptions = {}): FilloClient {
  return new FilloClient(options);
}

export interface ProvisionWorkspaceResult {
  /** Publishable key (pk_…) for the new workspace's default project. Pass to createClient({ key }). */
  key: string;
  organizationId: string;
  /** The private workspace link is emailed directly; `url` stays null. */
  claim: { url: string | null; email: string | null; sent: boolean };
  /** Caps applied until the workspace is saved to an account. */
  limits: { responses: number; expiresAt: string };
}

/**
 * Provision a Fillo workspace from an email — no signup — and get a publishable
 * key back, so a form can collect real responses immediately. A private
 * workspace link is emailed to `email`; until someone saves it to an account,
 * the workspace runs as a capped preview (limited responses, for a limited time). Built for setup automation,
 * e.g. a coding agent wiring Fillo into an app during integration.
 *
 *   const { key } = await provisionWorkspace({ email: "you@co.com" });
 *   const client = createClient({ key });
 */
export async function provisionWorkspace(options: {
  email: string;
  /** Internal: hit this page's own origin (Fillo's own pages). */
  sameOrigin?: boolean;
  /** Free-form provenance label, e.g. "agent" | "cli". */
  source?: string;
  fetch?: typeof fetch;
}): Promise<ProvisionWorkspaceResult> {
  const base = options.sameOrigin ? "" : DEFAULT_BASE_URL;
  const doFetch =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const res = await doFetch(`${base}/api/v1/workspaces/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: options.email, source: options.source ?? "sdk" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new FilloError(body || `Provision failed: ${res.status}`, res.status);
  }
  return (await res.json()) as ProvisionWorkspaceResult;
}
