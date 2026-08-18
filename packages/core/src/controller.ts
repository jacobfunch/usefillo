import {
  isField,
  type Block,
  type FieldValue,
  type FormPage,
  type FormSchema,
  type ResponseData,
} from "./types.js";
import {
  isTerminalPage,
  reachablePageSequence,
  responseScopeValue,
  visiblePageBlocks,
} from "./logic.js";
import { computeCalculated } from "./calc.js";
import { prefillFromParams } from "./prefill.js";
import { validateField, validateResponse } from "./validation.js";
import { normalizeFormSchema } from "./schema-validation.js";
import {
  isFilloError,
  type FilloClient,
  type FilloRespondent,
  type SubmitResult,
} from "./client.js";
import { DEFAULT_RESPONDENT_ERROR_STRINGS, type RespondentErrorStrings } from "./strings.js";

export type FormStatus = "idle" | "submitting" | "submitted" | "error";

export interface FormControllerOptions {
  form: FormSchema;
  /** Target form id — required for client submission and funnel tracking. */
  formId?: string;
  /**
   * Collect responses into a Fillo workspace. Without a client the form is
   * render-only (previews/tests); to also deliver responses to your own
   * backend, use webhooks.
   */
  client?: FilloClient;
  initialData?: ResponseData;
  onSubmitted?: (responseId: string | undefined, data: ResponseData) => void;
  onChange?: (data: ResponseData) => void;
  /** Honeypot value, supplied by your renderer; must be empty for a human. */
  getHoneypot?: () => string;
  /**
   * @internal Let preview page navigation move forward without validating the
   * current page. Submission still validates every answerable field; a
   * transportless preview ignores required file-upload fields because its
   * disabled picker cannot possibly satisfy them. Renderers must not use this
   * option to change visitor-facing behavior such as branding.
   */
  skipValidation?: boolean;
  /**
   * Embedding surface, recorded per response for measurement. "headless" = a
   * bare engine with no Fillo-rendered layout (createFormController /
   * <FilloProvider>); the framed renderers (<FilloForm>, renderForm) pass
   * "default" explicitly. Defaults to "headless" — a bare createFormController
   * is itself headless.
   */
  surface?: "default" | "headless";
  /**
   * Resolve/verify the submission target immediately before submit. Code-form
   * renderers use this to recover a missing target and to detect a live schema
   * change after a cached mount. Answers are held (never dropped) while it
   * runs; failure sets `submitError` and the respondent can retry.
   */
  resolveFormId?: () => Promise<string>;
  /**
   * Surface the REAL {@link resolveFormId} failure (message + machine code)
   * in `submitError` instead of the respondent-safe "This form is
   * unavailable." fallback. Dev chrome only: renderers set it from the same
   * gate as their other developer surfaces (preview prop / dev environment),
   * so production visitors never see integration details such as keys,
   * origins, or deployment commands.
   */
  verboseResolutionErrors?: boolean;
  /** Safe respondent-facing fallbacks used when an API or transport error is
   * intentionally hidden. Renderers pass their resolved `strings` overrides so
   * this boundary never replaces localized copy with the English defaults. */
  respondentErrorStrings?: Partial<RespondentErrorStrings>;
  /**
   * Host-app account context (identify()): who is filling this form, by your
   * own user id. Sent with the submission and recorded as an unverified
   * claim — it changes what the dashboard/webhooks can tell you, never what
   * the respondent can do.
   */
  respondent?: FilloRespondent;
  /**
   * True when the form requires a human-verification challenge (Turnstile).
   * When set, submit refuses to send until a token is available and always
   * attaches the token from {@link getChallengeToken}. The server is the real
   * gate — this only avoids firing a submit the server would reject.
   */
  challengeRequired?: boolean;
  /**
   * Read the current challenge token (from the rendered widget) at submit time.
   * Returns undefined until the challenge is solved. Read lazily so an expired
   * token that was refreshed just before submit is picked up fresh.
   */
  getChallengeToken?: () => string | undefined;
  /**
   * The server rejected the submission's challenge (stale/replayed/invalid
   * token). The renderer resets the widget so the human can solve a fresh one.
   */
  onChallengeFailed?: () => void;
}

export interface FormControllerState {
  data: ResponseData;
  errors: Record<string, string>;
  status: FormStatus;
  pageIndex: number;
  pageCount: number;
  /** The current page (after clamping). */
  page: FormPage;
  /** Blocks visible on the current page, after conditional logic. */
  blocks: Block[];
  isFirstPage: boolean;
  isLastPage: boolean;
  /** True while any file field is uploading. */
  uploading: boolean;
  /** Human-readable message for the last failed submit; cleared on edit/retry. */
  submitError?: string;
  /**
   * True when `status` is "submitted" because the once-per-visitor gate
   * restored a previous visit's response, not because a submit happened in
   * this controller instance. Renderers use it to skip one-time "just
   * submitted" reactions (moving focus to the success screen, redirecting) —
   * otherwise every remount of an already-answered form replays them.
   */
  restoredSubmission: boolean;
  /**
   * True when a saved-progress draft (settings.saveProgress) was restored
   * into this fill — answers and/or page position came from a previous
   * visit. Renderers use it to show a "continuing where you left off"
   * notice with a Start over action (resetDraft).
   */
  resumedDraft: boolean;
  /**
   * True when an update-in-place limit prefilled the VERIFIED respondent's own
   * previous answers — submitting updates that response in place. Renderers
   * show an "updating your earlier response" notice.
   */
  editingPrevious: boolean;
  /**
   * True when the last submit was accepted as an already-recorded response
   * rather than a new one (the server returns this only for a VERIFIED
   * identify() repeat on a keep-mode form). Renderers show an "already
   * answered" message on the success screen instead of implying a fresh
   * submission — otherwise a repeat visitor's new answers look saved when the
   * server kept the original.
   */
  duplicateSubmission: boolean;
  /**
   * True when the last submit UPDATED the person's existing response in place
   * (responseLimit onRepeat "update"), rather than creating a new one.
   */
  updatedSubmission: boolean;
  /**
   * True when a resume link (#fillo-draft=…) could not be adopted because it
   * was expired, already used, or not this browser's — so no progress was
   * restored. Renderers surface a "that link expired — start again" notice
   * instead of showing a silently blank form.
   */
  resumeLinkFailed: boolean;
}

function browserAttribution():
  | { pageUri?: string; pageName?: string; hubspotutk?: string }
  | undefined {
  if (typeof document === "undefined" || typeof window === "undefined") return undefined;
  try {
    const page = new URL(window.location.href);
    page.hash = "";
    const hubspotutk = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("hubspotutk="))
      ?.slice("hubspotutk=".length);
    const attribution = {
      pageUri: page.href.slice(0, 2_048),
      pageName: document.title.trim().slice(0, 200) || undefined,
      hubspotutk: hubspotutk && /^[a-f0-9]{32}$/i.test(hubspotutk) ? hubspotutk : undefined,
    };
    return Object.values(attribution).some(Boolean) ? attribution : undefined;
  } catch {
    return undefined;
  }
}

export interface FormController {
  /** Stable snapshot — same reference until something changes (safe for useSyncExternalStore). */
  getState(): FormControllerState;
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  setValue(fieldId: string, value: FieldValue): void;
  /** Mark a file field busy/idle so `state.uploading` reflects it. */
  setUploading(fieldId: string, busy: boolean): void;
  /** Validate the current page, then advance. No-op on the last page or with errors. */
  next(): void;
  back(): void;
  submit(): Promise<void>;
  /**
   * Late-bind inputs after creation, keeping current answers/page/status:
   * - `form` updates the rendered schema in place (a builder live preview being
   *   edited), recomputing visible blocks and re-notifying.
   * - `formId`/`client` set the submission target (e.g. a code-defined form id
   *   that resolves asynchronously).
   */
  setContext(ctx: {
    form?: FormSchema;
    formId?: string;
    client?: FilloClient;
    /** Late-bind identify() context — host sessions often resolve after mount. */
    respondent?: FilloRespondent;
    /** Replace localized respondent-safe error copy after a locale change. */
    respondentErrorStrings?: Partial<RespondentErrorStrings>;
  }): void;
  /**
   * Persist any unsaved draft progress right now (settings.saveProgress
   * forms). Renderers call this on pagehide/visibility-hidden so the last
   * keystrokes survive a tab close; a no-op when there's nothing to save.
   */
  flushDraft(): void;
  /**
   * Discard the saved draft and reset to a fresh fill: answers back to
   * initialData + URL prefill, first page, errors cleared. The "Start over"
   * action next to the resume notice.
   */
  resetDraft(): void;
  /** Drop all listeners. */
  destroy(): void;
}

const EMPTY_PAGE: FormPage = { id: "empty", blocks: [] };

/**
 * Framework-agnostic form engine: validation, conditional logic, pages, spam
 * signals, and submission as a subscribable store — with no rendering. Drive it
 * from vanilla JS, Vue, Svelte, or any framework and lay the fields out
 * yourself. (In React, `<FilloProvider>` / `useFillo()` wrap this same engine.)
 */
/** One-time console warning when a real embed has no client to submit through. */
let warnedNoClient = false;
let warnedNoFormId = false;
function warnNoFormId() {
  if (warnedNoFormId) return;
  warnedNoFormId = true;
  console.warn(
    "[fillo] This form has a client but no submission target — a bare schema can't sync. " +
      "Wrap it in defineForm({ id, pages }) (or author it with <Fillo.Form id=…>) so it gets " +
      "a project handle, or pass formId for a dashboard-built form: https://fillo.so/docs",
  );
}

function warnNoClient() {
  if (warnedNoClient) return;
  warnedNoClient = true;
  console.warn(
    "[fillo] This form has no `client`, so responses can't be submitted — it's render-only. " +
      "Pass a client (createClient) to collect responses in Fillo, or forward them to your own " +
      "backend with webhooks: https://fillo.so/docs",
  );
}

type StoredSubmission = {
  key: string;
  submittedAt?: string;
  responseId?: string;
};

const memorySubmissionKeys = new Map<string, StoredSubmission>();

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function submissionStorageKey(formId: string): string {
  return `fillo:submission:${formId}`;
}

function randomSubmissionKey(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** localStorage JSON with an in-memory fallback (disabled/private storage
 * still covers the current page load). Corrupt state reads as absent. */
function readStoredJson<T>(
  memory: Map<string, T>,
  storageKey: string,
  memoryKey: string,
  isValid: (parsed: NonNullable<unknown>) => boolean,
): T | null {
  const store = browserStorage();
  if (!store) return memory.get(memoryKey) ?? null;
  try {
    const parsed = JSON.parse(store.getItem(storageKey) ?? "null") as T | null;
    if (parsed && isValid(parsed)) return parsed;
  } catch {
    // Corrupt state — treated as absent; the next write replaces it.
  }
  return null;
}

function writeStoredJson<T>(
  memory: Map<string, T>,
  storageKey: string,
  memoryKey: string,
  value: T,
): void {
  memory.set(memoryKey, value);
  const store = browserStorage();
  if (!store) return;
  try {
    store.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage disabled/full — the in-memory copy still covers this page load.
  }
}

function readStoredSubmission(formId: string): StoredSubmission | null {
  return readStoredJson(
    memorySubmissionKeys,
    submissionStorageKey(formId),
    formId,
    (p) => typeof (p as Partial<StoredSubmission>).key === "string",
  );
}

function writeStoredSubmission(formId: string, value: StoredSubmission): void {
  writeStoredJson(memorySubmissionKeys, submissionStorageKey(formId), formId, value);
}

function ensureSubmissionKey(formId: string): string {
  const existing = readStoredSubmission(formId);
  if (existing?.key) return existing.key;
  const next = { key: randomSubmissionKey() };
  writeStoredSubmission(formId, next);
  return next.key;
}

function markSubmitted(formId: string, responseId: string | undefined): void {
  const existing = readStoredSubmission(formId);
  writeStoredSubmission(formId, {
    key: existing?.key ?? randomSubmissionKey(),
    submittedAt: new Date().toISOString(),
    responseId,
  });
}

/** The key under which this browser's single-submission record lives. Plain
 *  formId for a whole-form browser limit; formId + the scope field's current
 *  answer when responseLimit.scopeField splits the limit per article/product. */
function visitorSubmissionKeyId(form: FormSchema, formId: string, data: ResponseData): string {
  const scope = responseScopeValue(form.settings, data);
  return scope === null ? formId : `${formId}::${scope}`;
}

function hasSubmittedOnce(
  form: FormSchema,
  formId: string | undefined,
  data: ResponseData,
): boolean {
  if (form.settings.responseLimit?.by !== "browser" || !formId) return false;
  return Boolean(readStoredSubmission(visitorSubmissionKeyId(form, formId, data))?.submittedAt);
}

// ---------- Saved-progress drafts (settings.saveProgress) ----------

/** Local pointer to this browser's server-side draft for a form. */
type StoredDraftRef = { id: string; token: string };

const memoryDraftRefs = new Map<string, StoredDraftRef>();

function draftStorageKey(formId: string): string {
  return `fillo:draft:${formId}`;
}

function readDraftRef(formId: string): StoredDraftRef | null {
  return readStoredJson(memoryDraftRefs, draftStorageKey(formId), formId, (p) => {
    const ref = p as Partial<StoredDraftRef>;
    return typeof ref.id === "string" && typeof ref.token === "string";
  });
}

function writeDraftRef(formId: string, ref: StoredDraftRef): void {
  writeStoredJson(memoryDraftRefs, draftStorageKey(formId), formId, ref);
}

function clearDraftRef(formId: string): void {
  memoryDraftRefs.delete(formId);
  const store = browserStorage();
  if (!store) return;
  try {
    store.removeItem(draftStorageKey(formId));
  } catch {
    // Ignore — worst case a stale ref 404s and gets cleared on the next read.
  }
}

/** The server says this draft no longer exists or was never ours. */
function isDraftGone(err: unknown): boolean {
  return isFilloError(err) && (err.status === 401 || err.status === 403 || err.status === 404);
}

const DRAFT_DEBOUNCE_MS = 1500;

/**
 * Respondent-facing message for a failed submit. Stable API codes select local
 * Fillo-authored copy; provider/server prose is never reflected. The original
 * thrown FilloError remains available to the host for diagnostics.
 */
function submitFailureMessage(err: unknown, strings: RespondentErrorStrings): string {
  if (isFilloError(err)) {
    const status = err.status ?? 0;
    if (status === 404) return strings.loadFailedNotFound;
    switch (err.code) {
      case "submit_rate_limited":
        return strings.submitRateLimited;
      case "workspace_unavailable":
      case "provision_closed":
        return strings.formClosed;
      case "respondent_unrecognized":
        return strings.respondentUnrecognized;
      case "invalid_file_reference":
        return strings.fileUnavailable;
      case "response_scope_missing":
        return strings.scopeMissing;
    }
    if (status > 0) return strings.submitFailed;
  }
  return strings.loadFailedNetwork;
}

/**
 * Resolving a code-defined form can expose integration instructions (keys,
 * origins, deployment commands). Keep those details on the thrown FilloError
 * for the host while respondents only see a safe fallback. Dev chrome opts
 * into `verbose` (verboseResolutionErrors): a developer's failed test submit
 * then says WHY — the real message plus its machine code — instead of
 * "unavailable". Status-0 failures keep the transport explanation either way,
 * since "Request failed" helps nobody diagnose a blocked request.
 */
function syncResolutionFailureMessage(
  err: unknown,
  verbose: boolean,
  strings: RespondentErrorStrings,
): string {
  if (isFilloError(err)) {
    const status = err.status ?? 0;
    if (verbose && status > 0 && err.message) {
      return err.code ? `${err.message} (${err.code})` : err.message;
    }
    const definitive = status > 0 && status < 500 && status !== 408 && status !== 429;
    if (definitive) return strings.formUnavailable;
    if (status > 0) return strings.submitFailed;
  }
  return submitFailureMessage(err, strings);
}

export function createFormController(options: FormControllerOptions): FormController {
  const { onChange, onSubmitted } = options;
  let respondentErrorStrings: RespondentErrorStrings = {
    ...DEFAULT_RESPONDENT_ERROR_STRINGS,
    ...options.respondentErrorStrings,
  };
  const initial = normalizeFormSchema(options.form);
  if (!initial.ok) throw new Error(`Invalid form schema: ${initial.error}`);
  // Mutable so setContext can late-bind them: the form can change in place (e.g.
  // a builder's live preview being edited), and the id/client can resolve async.
  let form = initial.schema!;
  let formId = options.formId;
  let client = options.client;
  let respondent = options.respondent;

  // EVERY data assembly below runs through computeCalculated before notify():
  // calculated values live IN `data`, so piping, conditions, terminal-page
  // detection, and the display row all see them in the same tick — and any
  // stale/forged value under a calculated id is dropped at the same time.
  let data: ResponseData = computeCalculated(form, { ...(options.initialData ?? {}) });
  let errors: Record<string, string> = {};
  let pageIndex = 0;
  // The "already submitted" gate reads localStorage, which SSR can't see —
  // checking it during creation makes server HTML (the form) disagree with the
  // client's first render (the success screen) and React logs a hydration
  // mismatch. Start idle and flip right after creation, once hydration matched.
  let status: FormStatus = "idle";
  let restoredSubmission = false;
  // Set when a resume link (#fillo-draft=…) can't be adopted (expired/spent/
  // foreign), so the renderer can explain the blank form instead of hiding it.
  let resumeLinkFailed = false;
  queueMicrotask(() => {
    // URL prefill (hidden-field paramName + Tally-style ?fieldId=…) works in
    // EMBEDS too, not just the hosted page — without this, hidden campaign
    // fields silently store nothing. Deferred past hydration (SSR can't see
    // the query string); explicit initialData/typed answers win. Runs BEFORE
    // the already-answered gate below: a scoped browser limit keys on
    // a field (e.g. an article id) whose value often arrives via ?param=…, so
    // it must be merged into `data` before the gate computes its scope key.
    if (typeof location !== "undefined" && location.search) {
      const params = Object.fromEntries(new URLSearchParams(location.search));
      let merged: ResponseData | null = null;
      for (const [key, value] of Object.entries(prefillFromParams(form, params))) {
        if (data[key] === undefined) {
          merged = merged ?? { ...data };
          merged[key] = value;
        }
      }
      if (merged && status === "idle") {
        data = computeCalculated(form, merged);
        notify();
      }
    }
    if (status === "idle" && hasSubmittedOnce(form, formId, data)) {
      status = "submitted";
      restoredSubmission = true;
      notify();
    }
    // Resume link: an abandonment email lands on #fillo-draft=<id>.<token>.
    // Adopt it as this browser's draft ref, then restore. The adopt call
    // rotates the bearer server-side (the URL token is single-use), so a
    // shared/leaked link can't be used to read what this person then types.
    let adopting = false;
    if (
      form.settings.saveProgress &&
      formId &&
      client &&
      typeof location !== "undefined" &&
      location.hash.includes("fillo-draft=")
    ) {
      const match = /fillo-draft=([^&]+)/.exec(location.hash);
      const raw = match?.[1] ? decodeURIComponent(match[1]) : "";
      const dot = raw.indexOf(".");
      if (dot > 0) {
        adopting = true;
        const did = raw.slice(0, dot);
        const dtok = raw.slice(dot + 1);
        client
          .getDraft(did, dtok, true)
          .then((d) => {
            writeDraftRef(formId!, { id: did, token: d.token ?? dtok });
            // Strip the fragment AFTER the adopt round-trip — a synchronous
            // strip in the boot microtask races host-framework hydration
            // (e.g. Next restoring the URL from router state), so it wouldn't
            // stick. Post-network is safely past hydration.
            try {
              history.replaceState(null, "", location.pathname + location.search);
            } catch {
              // History API unavailable — the token is single-use regardless.
            }
          })
          .catch((err) => {
            // Bad/expired/spent/foreign link — fall back to any local draft,
            // but flag it so the renderer can explain the otherwise-blank form
            // ("that link expired — start again") instead of silently dropping
            // the visitor onto an empty fill.
            if (isDraftGone(err)) {
              resumeLinkFailed = true;
              notify();
            }
          })
          .finally(() => maybeRestoreDraft());
      }
    }
    // Saved-progress restore, after the gate and prefill so their values win.
    // Deferred past hydration for the same SSR reason as both of the above.
    if (!adopting) maybeRestoreDraft();
  });
  let submitError: string | undefined;
  const uploadingFields = new Set<string>();

  const listeners = new Set<() => void>();
  // Bots submit in milliseconds; humans don't. Captured at creation.
  const mountedAt = Date.now();
  // Idempotency key for this fill: stable across submit retries of the same
  // answers (a lost ack after the server committed can't create a duplicate),
  // but unique per controller instance so a genuine re-fill is a new response.
  const idempotencyKey = randomSubmissionKey();
  let sessionId: string | null = null;
  let sessionStarted = false;

  // Saved-progress drafts (settings.saveProgress). All best-effort: a failed
  // save must never block typing, page nav, or submit.
  let resumedDraft = false;
  let editingPrevious = false;
  // How the server classified the last successful submit. "duplicate" (a
  // verified identify() repeat the server kept) and "updated" (an in-place
  // upsert) drive the success-screen copy so a repeat visitor isn't told a
  // discarded/updated answer was recorded fresh.
  let submissionKind: "created" | "duplicate" | "updated" = "created";
  let editAttempted = false;
  let draftRef: StoredDraftRef | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let draftChain: Promise<void> = Promise.resolve();
  let draftDirty = false;
  /** Server said drafts can't happen here (setting off, form closed) — stop trying. */
  let draftDisabled = false;
  let draftRestoreAttempted = false;
  let draftAffinityAttempted = false;

  function computeSnapshot(): FormControllerState {
    const pageCount = form.pages.length;
    const clamped = Math.min(pageIndex, Math.max(pageCount - 1, 0));
    const page = form.pages[clamped] ?? EMPTY_PAGE;
    return {
      data,
      errors,
      status,
      pageIndex: clamped,
      pageCount,
      page,
      // Whole-form visibility fixpoint (not just this page's fields) so a field
      // gated by a cross-page answer renders/validates exactly when the server
      // keeps it — never a field whose answer submit would silently drop.
      blocks: visiblePageBlocks(form, page, data),
      isFirstPage: clamped === 0,
      // Terminal-aware: true when the current page is the last reachable page OR
      // a matched jump rule ends the form here — so the footer reads Submit and
      // its handler submits. Same shared engine the validator reaches with.
      isLastPage: isTerminalPage(form, page.id, data),
      uploading: uploadingFields.size > 0,
      submitError,
      restoredSubmission,
      resumedDraft,
      editingPrevious,
      duplicateSubmission: submissionKind === "duplicate",
      updatedSubmission: submissionKind === "updated",
      resumeLinkFailed,
    };
  }

  let snapshot = computeSnapshot();

  function notify() {
    snapshot = computeSnapshot();
    for (const listener of listeners) listener();
  }

  // Fillo has already collected the response when this runs. `onSubmitted` is
  // the caller's "do something afterward" hook (provision, analytics, redirect,
  // their own API) — its errors are theirs to handle and must never revert the
  // submitted state, so they're caught here rather than bubbling into submit().
  function emitSubmitted(responseId: string | undefined, submitted: ResponseData) {
    try {
      onSubmitted?.(responseId, submitted);
    } catch (err) {
      console.error("[fillo] onSubmitted handler threw:", err);
    }
  }

  function validatePage(index: number): Record<string, string> {
    const target = form.pages[index];
    if (!target) return {};
    const pageErrors: Record<string, string> = {};
    for (const block of visiblePageBlocks(form, target, data)) {
      if (!isField(block)) continue;
      const error = validateField(block, data[block.id]);
      if (error) pageErrors[block.id] = error;
    }
    return pageErrors;
  }

  function draftsEnabled(): boolean {
    return Boolean(form.settings.saveProgress && client && formId && !draftDisabled);
  }

  function knownFieldIds(): Set<string> {
    const ids = new Set<string>();
    for (const page of form.pages) {
      for (const block of page.blocks) if (isField(block)) ids.add(block.id);
    }
    return ids;
  }

  /** Merge a fetched draft into the fill — restore-only keys, clamped page.
   *  No-op once the respondent started typing (their fresh answers win; the
   *  next autosave overwrites the server draft through the same ref). */
  function applyDraftSnapshot(draft: { data?: ResponseData; page?: number }): void {
    if (status !== "idle" || sessionStarted) return;
    const ids = knownFieldIds();
    let merged: ResponseData | null = null;
    for (const [key, value] of Object.entries(draft.data ?? {})) {
      if (data[key] === undefined && ids.has(key)) {
        merged = merged ?? { ...data };
        merged[key] = value as FieldValue;
      }
    }
    const target =
      typeof draft.page === "number" && Number.isFinite(draft.page)
        ? Math.max(0, Math.min(Math.floor(draft.page), form.pages.length - 1))
        : 0;
    const movePage = target > 0 && pageIndex === 0;
    if (!merged && !movePage) return;
    // Persisted drafts (and prefilled previous responses) may carry stale
    // calculated values — restore recomputes them from the merged answers.
    if (merged) data = computeCalculated(form, merged);
    if (movePage) pageIndex = target;
    // Navigation is stateless (recomputed from the reachable sequence), so a
    // resumed draft only sets the page — back()/next() re-derive from here.
    resumedDraft = true;
    notify();
  }

  function maybeRestoreDraft() {
    if (status !== "idle") return;
    if (!draftsEnabled()) {
      // Drafts off (or unavailable): upsert prefill still applies.
      maybePrefillOwnResponse();
      return;
    }
    const fid = formId!;
    const c = client!;
    const ref = draftRef ?? readDraftRef(fid);
    if (ref && !draftRestoreAttempted) {
      draftRestoreAttempted = true;
      draftRef = ref;
      void c
        .getDraft(ref.id, ref.token)
        .then(applyDraftSnapshot)
        .catch((err) => {
          // Gone (expired/consumed/deleted) or not ours — drop the ref; the
          // next save creates a fresh draft. Transport blips skip the restore.
          if (isDraftGone(err)) {
            clearDraftRef(fid);
            draftRef = null;
          }
        });
      return;
    }
    // No local pointer, but a hashed identity: a VERIFIED respondent can pick
    // up their draft from another device. The server validates the hash and
    // returns the existing draft with a rotated bearer — or a fresh empty one
    // this device fills from here on. Unverifiable hashes get a fresh draft.
    if (!ref && !draftAffinityAttempted && respondent?.hash) {
      draftAffinityAttempted = true;
      void c
        .createDraft(fid, { data: {}, page: 0, respondent })
        .then((created) => {
          if (draftRef) return; // an autosave raced us — keep its ref
          draftRef = { id: created.id, token: created.token };
          writeDraftRef(fid, draftRef);
          if (created.existing) {
            return c.getDraft(created.id, created.token).then(applyDraftSnapshot);
          }
          // No in-progress draft anywhere — on an upsert form, prefill the
          // person's LIVING response for editing instead.
          maybePrefillOwnResponse();
        })
        .catch((err) => {
          // A standing 4xx (setting off, closed) won't change — stay stopped.
          // Transport blips may retry on the next context change.
          if (
            !(
              isFilloError(err) &&
              err.status !== undefined &&
              err.status >= 400 &&
              err.status < 500
            )
          ) {
            draftAffinityAttempted = false;
          }
        });
    }
  }

  /**
   * onRepeat "update" + verified identity: load the person's own living
   * response and prefill it for editing (draft snapshots win — they're the
   * newer unsaved edits — so this only runs when no draft applied). The
   * server 404s unverified identities; treated as "nothing to prefill".
   */
  function maybePrefillOwnResponse() {
    if (editAttempted || form.settings.responseLimit?.onRepeat !== "update") return;
    if (!client || !formId || !respondent?.hash || status !== "idle") return;
    editAttempted = true;
    const c = client;
    // For a field-scoped limit (one response per article/product), fetch only
    // THIS scope's response — same key the server dedups on. The scope value
    // usually arrives via ?param before prefill runs; if it's absent the server
    // 404s (nothing to prefill) rather than returning another scope's answers.
    const scopeValue = responseScopeValue(form.settings, data) ?? undefined;
    void c
      .fetchOwnResponse(formId, respondent, scopeValue)
      .then((own) => {
        if (!own || status !== "idle" || sessionStarted || resumedDraft) return;
        applyDraftSnapshot({ data: own.data, page: 0 });
        if (resumedDraft) {
          // applyDraftSnapshot flags resumedDraft; reclassify — this is a
          // previous SUBMISSION being edited, not an in-progress draft.
          resumedDraft = false;
          editingPrevious = true;
          notify();
        }
      })
      .catch(() => {
        // Best-effort prefill — a blip just means a blank form.
      });
  }

  function persistDraft(keepalive = false) {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    if (!draftsEnabled() || status !== "idle" || !draftDirty) return;
    const fid = formId!;
    const c = client!;
    draftDirty = false;
    // Serialized: saves run one at a time, each reading the freshest answers
    // at send time, so a slow earlier request can't overwrite a newer save.
    draftChain = draftChain.then(async () => {
      const payload = {
        data,
        page: Math.max(0, Math.min(pageIndex, form.pages.length - 1)),
      };
      const ref = draftRef ?? readDraftRef(fid);
      try {
        if (ref) {
          try {
            await c.saveDraft(
              ref.id,
              ref.token,
              payload,
              keepalive ? { keepalive: true } : undefined,
            );
            draftRef = ref;
            return;
          } catch (err) {
            // Expired, consumed, or foreign ref — recreate below; anything
            // else rethrows to the outer catch (transient: retry next change).
            if (!isDraftGone(err)) throw err;
            clearDraftRef(fid);
            draftRef = null;
          }
        }
        // A hashed identity also stamps the draft for cross-device pickup. If
        // the server returns the person's EXISTING draft instead (created on
        // another device), it left that data untouched — mark dirty so this
        // device's answers persist over it on the next pass.
        const created = await c.createDraft(
          fid,
          respondent?.hash ? { ...payload, respondent } : payload,
        );
        draftRef = { id: created.id, token: created.token };
        writeDraftRef(fid, draftRef);
        if (created.existing) draftDirty = true;
      } catch (err) {
        // A 4xx at create is a standing "no" (setting off, form closed, bad
        // payload) — stop trying this fill. 429 and transport errors are
        // transient: stay dirty and retry on the next change.
        if (
          isFilloError(err) &&
          err.status !== undefined &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 429
        ) {
          draftDisabled = true;
        } else {
          draftDirty = true;
        }
      }
    });
  }

  function scheduleDraftSave() {
    if (!draftsEnabled() || status !== "idle") return;
    draftDirty = true;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      persistDraft();
    }, DRAFT_DEBOUNCE_MS);
  }

  /** Immediate save at a meaningful checkpoint (page transition). */
  function checkpointDraft() {
    if (!draftsEnabled() || (!sessionStarted && !draftRef)) return;
    draftDirty = true;
    persistDraft();
  }

  function discardDraftState() {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    draftDirty = false;
    if (formId) clearDraftRef(formId);
    draftRef = null;
  }

  function setValue(fieldId: string, value: FieldValue) {
    // Open a funnel session on first interaction (Fillo-backed forms only).
    if (!sessionStarted && client && formId) {
      sessionStarted = true;
      void client.startSession(formId, form.pages.length).then((id) => (sessionId = id));
    }
    data = computeCalculated(form, { ...data, [fieldId]: value });
    onChange?.(data);
    submitError = undefined;
    // Clear this field's error as soon as it changes — re-checked on next/submit.
    // A repeating group's child errors live under compound keys
    // ("groupId.index.childId") while every child edit writes through the
    // group's own id, so the prefix must clear with it or a fixed child's
    // error lingers until an unrelated validation pass.
    const prefix = `${fieldId}.`;
    if (fieldId in errors || Object.keys(errors).some((k) => k.startsWith(prefix))) {
      errors = Object.fromEntries(
        Object.entries(errors).filter(([k]) => k !== fieldId && !k.startsWith(prefix)),
      );
    }
    notify();
    scheduleDraftSave();
  }

  function setUploading(fieldId: string, busy: boolean) {
    if (busy) {
      uploadingFields.add(fieldId);
      // Starting a valid upload is the file field's correction gesture. Drop
      // its stale validation immediately instead of showing "required" beside
      // live progress; the field is re-checked on the next submit.
      if (fieldId in errors) {
        errors = Object.fromEntries(Object.entries(errors).filter(([k]) => k !== fieldId));
      }
    } else {
      uploadingFields.delete(fieldId);
    }
    notify();
  }

  /**
   * The current page's position in the reachable sequence. Navigation is
   * STATELESS — there is no visited stack to desync; back()/next() re-derive
   * from this walk every time (a resume, a failed-submit reposition, or a
   * changed answer just moves pageIndex, and the flow recomputes). When the
   * current page is OFF the sequence (e.g. answers changed after a draft
   * resumed onto a now-skipped page), snap deterministically to the nearest
   * reachable page: the LAST sequence entry whose form index is <= the current
   * index, else the first reachable page — so the respondent is never stranded
   * on, or navigated toward, a page the server would drop.
   */
  function currentSeqPosition(seq: string[]): number {
    if (seq.length === 0) return -1;
    const pageCount = form.pages.length;
    const clamped = Math.min(pageIndex, Math.max(pageCount - 1, 0));
    const currentId = form.pages[clamped]?.id;
    const exact = currentId === undefined ? -1 : seq.indexOf(currentId);
    if (exact >= 0) return exact;
    let fallback = 0;
    for (let i = 0; i < seq.length; i++) {
      const idx = form.pages.findIndex((p) => p.id === seq[i]);
      if (idx >= 0 && idx <= clamped) fallback = i;
    }
    return fallback;
  }

  function next() {
    const pageCount = form.pages.length;
    const clamped = Math.min(pageIndex, Math.max(pageCount - 1, 0));
    if (!options.skipValidation) {
      const pageErrors = validatePage(clamped);
      errors = pageErrors;
      if (Object.keys(pageErrors).length > 0) {
        notify();
        return;
      }
    }
    // Advance over the shared reachable sequence — the SAME walk the server
    // validates with, so render and validate never disagree about flow. The
    // sequence is finite and deduped, so this is inherently cycle-safe: a
    // backward jump is broken at the revisit, leaving the pre-revisit page as
    // the last (terminal) entry. Terminal → submit, exactly as pressing Submit
    // on the last page would (an "end" outcome and auto-submit both flow here).
    const current = form.pages[clamped];
    const seq = reachablePageSequence(form, data);
    const pos = currentSeqPosition(seq);
    const terminal =
      (current ? isTerminalPage(form, current.id, data) : true) || pos < 0 || pos + 1 >= seq.length;
    if (terminal) {
      void submit();
      return;
    }
    const nextIndex = form.pages.findIndex((p) => p.id === seq[pos + 1]);
    pageIndex = nextIndex >= 0 ? nextIndex : Math.min(clamped + 1, pageCount - 1);
    if (sessionId && client) client.reportProgress(sessionId, { furthestPage: pageIndex });
    notify();
    checkpointDraft();
  }

  function back() {
    errors = {};
    // Step to the previous page in the reachable sequence — for a no-jump form
    // that is exactly index-1 (seq is [p0…pN]); across a forward jump it returns
    // to the page actually visited (the source), not the skipped one. Stateless:
    // recomputed from the walk, so it can never desync from a repositioned page.
    const seq = reachablePageSequence(form, data);
    const pos = currentSeqPosition(seq);
    if (pos > 0) {
      const prevIndex = form.pages.findIndex((p) => p.id === seq[pos - 1]);
      pageIndex =
        prevIndex >= 0 ? prevIndex : Math.max(Math.min(pageIndex, form.pages.length - 1) - 1, 0);
    } else if (seq.length > 0) {
      // At (or before) the first reachable page → clamp to it (no-op back).
      const firstIndex = form.pages.findIndex((p) => p.id === seq[0]);
      pageIndex = firstIndex >= 0 ? firstIndex : 0;
    }
    notify();
    checkpointDraft();
  }

  async function submit() {
    if (status === "submitting" || status === "submitted") return;
    const result = validateResponse(form, data);
    if (!result.ok) {
      const transportlessPreview = options.skipValidation && !(client && formId);
      const previewErrors = transportlessPreview
        ? Object.fromEntries(
            Object.entries(result.errors).filter(([fieldId]) =>
              form.pages.every((page) =>
                page.blocks.every(
                  (block) =>
                    !(isField(block) && block.id === fieldId && block.kind === "file_upload"),
                ),
              ),
            ),
          )
        : result.errors;
      if (transportlessPreview && Object.keys(previewErrors).length === 0) {
        errors = {};
        status = "submitted";
        notify();
        emitSubmitted(undefined, data);
        return;
      }
      errors = previewErrors;
      // Jump to the first page with a *visible* erroring field — never to a page
      // where the error is on a field currently hidden by conditional logic
      // (that would show the user a page with no visible error). If none is
      // visible on any page, stay put; the errors are still surfaced via notify.
      const firstBad = form.pages.findIndex((p) =>
        visiblePageBlocks(form, p, data).some((b) => b.id in previewErrors),
      );
      if (firstBad >= 0) pageIndex = firstBad;
      notify();
      return;
    }

    // Re-resolve code-defined forms immediately before every submit. Besides
    // recovering from a mount-time failure, this prevents a previously cached
    // schema from submitting after a different live version was published.
    // Answers are validated and held while the bounded resolver runs.
    if (client && options.resolveFormId) {
      status = "submitting";
      submitError = undefined;
      notify();
      try {
        formId = await options.resolveFormId();
      } catch (err) {
        status = "idle";
        // Read the flag at submit time (not captured at creation) so a
        // renderer whose dev-chrome gate settles after mount is honored.
        submitError = syncResolutionFailureMessage(
          err,
          options.verboseResolutionErrors === true,
          respondentErrorStrings,
        );
        notify();
        throw err;
      }
    }

    if (client && formId) {
      // A browser-scoped limit uses a persistent per-visitor key (which also
      // gates the form to a single response); every other form sends the per-fill
      // idempotency key so a retry after a lost ack can't duplicate the response.
      const visitorKey =
        form.settings.responseLimit?.by === "browser"
          ? ensureSubmissionKey(visitorSubmissionKeyId(form, formId, result.data))
          : undefined;
      const submissionKey = visitorKey ?? idempotencyKey;
      // Completing a saved-progress fill deletes the draft with the response
      // commit, so it can't be resumed after submitting.
      const submitDraft = form.settings.saveProgress ? (draftRef ?? readDraftRef(formId)) : null;
      // Human-verification challenge (Turnstile). Read the token lazily so a
      // just-refreshed token is picked up. If the form requires a challenge but
      // it hasn't been solved yet, don't fire a submit the server will reject —
      // hold and prompt. (The renderer also keeps the submit button disabled
      // until solved; this covers headless/auto-submit paths.)
      const challengeToken = options.challengeRequired ? options.getChallengeToken?.() : undefined;
      if (options.challengeRequired && !challengeToken) {
        status = "idle";
        submitError = respondentErrorStrings.challengeIncomplete;
        notify();
        return;
      }
      status = "submitting";
      submitError = undefined;
      notify();
      let res: SubmitResult;
      try {
        res = await client.submit(formId, result.data, {
          hp: options.getHoneypot?.() ?? "",
          elapsedMs: Date.now() - mountedAt,
          surface: options.surface ?? "headless",
          attribution: browserAttribution(),
          submissionKey,
          draft: submitDraft ? { id: submitDraft.id, token: submitDraft.token } : undefined,
          respondent,
          challengeToken,
        });
      } catch (err) {
        status = "idle";
        // A failed human-verification challenge (stale/replayed/invalid token) is
        // a distinct, recoverable state: reset the widget for a fresh token and
        // ask the person to retry, rather than showing a generic transport error.
        // Handled (not rethrown) so it doesn't surface as an unhandled rejection.
        if (isFilloError(err) && err.code === "challenge_failed") {
          submitError = respondentErrorStrings.challengeRetry;
          options.onChallengeFailed?.();
          notify();
          return;
        }
        // Transport failure — Fillo did NOT collect. Revert so the form can retry.
        submitError = submitFailureMessage(err, respondentErrorStrings);
        notify();
        throw err;
      }
      if (!res.ok) {
        errors = res.errors ?? {};
        // The server rejected a field that may live on another page. Mirror the
        // local path: jump to the first page showing an erroring field so the
        // respondent sees what to fix. If every erroring field is currently
        // hidden by logic (no page can display it), the submit button would
        // otherwise be a silent no-op — surface a generic error instead.
        const firstBad = form.pages.findIndex((p) =>
          visiblePageBlocks(form, p, data).some((b) => b.id in errors),
        );
        if (firstBad >= 0) pageIndex = firstBad;
        else submitError = respondentErrorStrings.reviewAnswers;
        status = "idle";
        notify();
        return;
      }
      // Classify the accepted submit so the success screen tells the truth. The
      // server marks `duplicate` ONLY for a verified identify() repeat it kept,
      // and `updated` for an in-place upsert; a fresh submit stays "created".
      submissionKind = res.duplicate ? "duplicate" : res.updated ? "updated" : "created";
      if (sessionId) client.reportProgress(sessionId, { completed: true });
      // Persist only for a browser limit (to gate the form); a plain form keeps
      // no local record, so it stays re-fillable after success.
      if (visitorKey)
        markSubmitted(visitorSubmissionKeyId(form, formId, result.data), res.responseId);
      // The server deleted the draft with the commit; drop the local pointer
      // (and any pending autosave) so a re-fill starts clean.
      discardDraftState();
      status = "submitted";
      notify();
      emitSubmitted(res.responseId, result.data);
      return;
    }

    if (options.skipValidation) {
      // Builder/preview with no transport — complete locally so the owner can
      // see the success screen.
      status = "submitted";
      notify();
      emitSubmitted(undefined, result.data);
      return;
    }

    // Real embed that can't submit: never fake success — that would silently
    // drop the respondent's answers. Stay un-submitted and surface it loudly,
    // with the right diagnosis (missing client vs missing sync target).
    if (client && !formId) warnNoFormId();
    else warnNoClient();
    status = "error";
    notify();
  }

  return {
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setValue,
    setUploading,
    next,
    back,
    submit,
    setContext(ctx) {
      if ("formId" in ctx) formId = ctx.formId;
      if ("client" in ctx) client = ctx.client;
      if ("respondent" in ctx) respondent = ctx.respondent;
      if (ctx.respondentErrorStrings) {
        respondentErrorStrings = {
          ...DEFAULT_RESPONDENT_ERROR_STRINGS,
          ...ctx.respondentErrorStrings,
        };
      }
      if (ctx.form && ctx.form !== form) {
        const next = normalizeFormSchema(ctx.form);
        if (!next.ok) throw new Error(`Invalid form schema: ${next.error}`);
        form = next.schema!;
        // A schema edit can add/change/remove calculations — recompute so the
        // next snapshot's data agrees with the new form (same-tick rule above).
        data = computeCalculated(form, data);
      }
      if (status === "idle" && hasSubmittedOnce(form, formId, data)) {
        status = "submitted";
        restoredSubmission = true;
      }
      // Code-defined forms bind formId after an async sync — the creation-time
      // restore couldn't run then, so try again now that the target is known.
      maybeRestoreDraft();
      notify(); // context/schema changed → recompute blocks/page and re-render
    },
    flushDraft() {
      // Pending debounced changes are dirty already; a no-op otherwise.
      persistDraft(true);
    },
    resetDraft() {
      if (status === "submitting") return;
      const ref = draftRef ?? (formId ? readDraftRef(formId) : null);
      discardDraftState();
      if (ref && client) void client.deleteDraft(ref.id, ref.token).catch(() => {});
      data = { ...(options.initialData ?? {}) };
      // Re-apply URL prefill under the same "explicit values win" rule as init.
      if (typeof location !== "undefined" && location.search) {
        const params = Object.fromEntries(new URLSearchParams(location.search));
        for (const [key, value] of Object.entries(prefillFromParams(form, params))) {
          if (data[key] === undefined) data[key] = value;
        }
      }
      data = computeCalculated(form, data); // fresh fill, same same-tick rule

      errors = {};
      pageIndex = 0;
      submitError = undefined;
      resumedDraft = false;
      editingPrevious = false;
      notify();
    },
    destroy() {
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      listeners.clear();
    },
  };
}
