import { type ChallengeConfig, type FilloClient, isFilloError } from "./client.js";
import { allFields } from "./logic.js";
import type { FormBranding, FormPage, FormSchema, FormTheme } from "./types.js";

/** Result of syncing a code-defined form: its canonical id, slug, and branding. */
export interface SyncedForm {
  formId: string;
  slug: string;
  /** Absolute Fillo dashboard URL for reviewing and publishing this form. */
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
  /** Whether a submission would be accepted right now. Absent on older
   *  servers — renderers must then keep the status-based behavior. */
  accepting?: boolean;
  /**
   * Companion to `accepting` — present only when it is false. `draft`: not
   * published yet; `expired`/`capped`: the unclaimed preview workspace hit its
   * time window or response cap; `storage_required`: the form needs a
   * connected storage destination before it can go live; `storage_full`:
   * Fillo's temporary upload allowance is exhausted.
   */
  acceptingReason?: "draft" | "expired" | "capped" | "storage_required" | "storage_full";
  /** Whether new file uploads can start right now. Independent from response
   * acceptance; absent on older servers means available. */
  uploadsAvailable?: boolean;
  /** Server-owned per-file ceiling for the active storage lane. Renderers use
   * the lower of this and the field's configured maxFileSizeMb. */
  uploadFileSizeLimitMb?: number;
  /** Server-authoritative live snapshot when local code is not live yet. */
  resolvedSchema?: FormSchema;
  resolvedTheme?: FormTheme | null;
  /** Non-fatal integration problem; resolvedSchema remains safe to render. */
  syncError?: { code: string; message: string };
  warning?: string;
  /**
   * Machine-readable owner advisory for `warning`. Hard unavailability uses
   * `"storage_required"`; advisory thresholds use distinct codes. Use
   * `uploadsAvailable`, not this field, to decide whether an upload may start.
   */
  warningCode?: string;
  /** Absolute dashboard URL where a human connects a storage destination.
   *  Present whenever `warningCode` is. */
  warningUrl?: string;
}

/**
 * A form whose structure lives in user code. Development and explicit
 * render-only usage can show it immediately; production renderers with a
 * publishable key first resolve the canonical form from Fillo so responses,
 * uploads, webhooks, and exports stay bound to the published version.
 */
export interface CodeForm {
  /** Stable handle, unique in the workspace. */
  id: string;
  schema: FormSchema;
  theme?: FormTheme;
  readonly __filloCodeForm: true;
}

export function defineForm(def: {
  id: string;
  title?: string;
  description?: string;
  pages: FormPage[];
  settings?: FormSchema["settings"];
  theme?: FormTheme;
}): CodeForm {
  return {
    id: def.id,
    theme: def.theme,
    schema: {
      version: 1,
      title: def.title ?? "",
      description: def.description,
      pages: def.pages,
      settings: def.settings ?? {},
    },
    __filloCodeForm: true,
  };
}

export function isCodeForm(form: unknown): form is CodeForm {
  return typeof form === "object" && form !== null && "__filloCodeForm" in form;
}

interface SyncCacheEntry {
  promise: Promise<SyncedForm>;
  /** null while the request is in flight; finite once a stable result settles. */
  expiresAt: number | null;
}

const syncCache = new Map<string, SyncCacheEntry>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a sync failure can plausibly succeed without changing integration
 * configuration. Unknown/transport failures stay retryable; ordinary 4xx
 * responses are definitive configuration or lifecycle failures.
 */
function isRetryableSyncError(error: unknown): boolean {
  if (!isFilloError(error)) return true;
  const status = error.status ?? 0;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Retry transient sync failures (rate limit, server hiccup, network) with
 * jittered backoff, honoring the server's Retry-After. A rate-limited
 * mount-time sync used to leave the form without a submission target — and
 * the respondent's answers were dropped at submit.
 */
async function syncWithRetry(client: FilloClient, form: CodeForm): Promise<SyncedForm> {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.syncForm(form.id, form.schema, form.theme ?? null);
    } catch (err) {
      if (!isRetryableSyncError(err) || attempt >= 2) throw err;
      const hinted = isFilloError(err) ? err.retryAfterSec : undefined;
      await sleep(Math.min(hinted ? hinted * 1000 : delay * (1 + Math.random() * 0.5), 15_000));
      delay *= 2;
    }
  }
}

/** Stable djb2 hash of a string — used to key code-form sync by content. */
export function contentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Compare normalized schema JSON while ignoring object-key order (Postgres
 * jsonb and custom API proxies may reorder keys). Array order remains part of
 * the form definition because it controls pages, blocks, and options.
 */
export function formSchemasEqual(left: FormSchema, right: FormSchema): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonicalize(record[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

/**
 * Cross-session sync cache in localStorage for forms without file uploads:
 * returning visitors whose content hash matches skip the network entirely, so
 * steady traffic stops re-POSTing /forms/sync on every page load. Upload forms
 * always revalidate because their storage connection or temporary allowance
 * can change independently of the schema. Values are PII-free (documented in
 * the privacy docs): form id, slug, dashboard URL, lifecycle status, content
 * hash, timestamp.
 * TTLs: published forms 1h (bounds staleness after deletes/renames), drafts
 * 60s (publishing must flip visitors quickly).
 */
interface StoredSync {
  formId: string;
  slug: string;
  manageUrl?: string;
  status?: "draft" | "published";
  uploadFileSizeLimitMb?: number;
  hash: string;
  ts: number;
}

const syncTtlMs = (status: SyncedForm["status"]): number =>
  status === "published" ? 3_600_000 : 60_000;

// Not-accepting and upload-unavailable verdicts are volatile too: publishing,
// claiming, cleanup, or connecting storage must flip visitors quickly, and the
// stored subset below would otherwise drop the verdict and reopen the UI.
const isVolatileSync = (result: SyncedForm): boolean =>
  Boolean(
    result.staged ||
      result.resolvedSchema ||
      result.syncError ||
      result.accepting === false ||
      result.uploadsAvailable === false,
  );

function storageKey(client: FilloClient, handle: string): string {
  // v2 invalidates older entries that discarded staged/fallback metadata and
  // could therefore render local draft content against live validation. v3
  // invalidates entries that predate challenge delivery and would render a
  // challenge-enabled form without its widget against a server that enforces it.
  // v4 keeps the active storage lane's upload limit truthful across visits.
  // v5 adds the server-owned dashboard URL without deriving it from a proxy.
  return `fillo:sync:v5:${client.baseUrl}|${client.key}|${handle}`;
}

function readStoredSync(client: FilloClient, handle: string, hash: string): StoredSync | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(client, handle));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSync>;
    if (
      typeof parsed.formId !== "string" ||
      typeof parsed.slug !== "string" ||
      parsed.hash !== hash ||
      typeof parsed.ts !== "number" ||
      (parsed.uploadFileSizeLimitMb !== undefined &&
        (typeof parsed.uploadFileSizeLimitMb !== "number" ||
          !Number.isFinite(parsed.uploadFileSizeLimitMb) ||
          parsed.uploadFileSizeLimitMb <= 0)) ||
      (parsed.manageUrl !== undefined && typeof parsed.manageUrl !== "string") ||
      (parsed.status !== undefined && parsed.status !== "draft" && parsed.status !== "published")
    )
      return null;
    const ttl = syncTtlMs(parsed.status);
    if (Date.now() - parsed.ts > ttl) return null;
    return parsed as StoredSync;
  } catch {
    return null; // Storage disabled/corrupt — fall through to the network.
  }
}

function writeStoredSync(client: FilloClient, handle: string, hash: string, r: SyncedForm): void {
  // A fallback/staged response is safe only together with its authoritative
  // live snapshot. It gets in-flight dedupe only; never persist schema payloads
  // (or accidentally discard the safety metadata) cross-page. A not-accepting
  // verdict must not persist either — the stored subset drops it, so a cached
  // hit would render a refused form as open.
  if (r.staged || r.resolvedSchema || r.syncError || r.accepting === false) return;
  // A challenge-required result must re-resolve each visit: the stored subset
  // drops the challenge config, and rendering without the widget means the
  // server rejects every submit. Always-fresh also survives site-key rotation.
  if (r.challenge) return;
  try {
    globalThis.localStorage?.setItem(
      storageKey(client, handle),
      JSON.stringify({
        formId: r.formId,
        slug: r.slug,
        manageUrl: r.manageUrl,
        status: r.status,
        uploadFileSizeLimitMb: r.uploadFileSizeLimitMb,
        hash,
        ts: Date.now(),
      } satisfies StoredSync),
    );
  } catch {
    // Private mode / quota — the bounded in-memory cache still dedupes requests.
  }
}

/**
 * Resolve a code-defined form with in-flight dedupe and bounded stable-result
 * caching (published 1h, draft 60s). Staged/live-fallback results are evicted
 * once settled so an SPA can observe publication without a hard reload.
 * `bypassCache` forces the network for submit-time compatibility checks.
 */
export function syncCodeForm(
  client: FilloClient,
  form: CodeForm,
  opts?: { bypassCache?: boolean },
): Promise<SyncedForm> {
  const content = JSON.stringify(form.schema) + JSON.stringify(form.theme ?? null);
  const hash = contentHash(content);
  const key = `${client.baseUrl}:${client.key}:${form.id}:${hash}`;
  const revalidateUploadState = allFields(form.schema).some(
    (field) => field.kind === "file_upload",
  );
  const cached = syncCache.get(key);
  if (cached && !opts?.bypassCache) {
    // Upload forms still dedupe one in-flight request, but never reuse a
    // settled verdict: storage can be disconnected or exhaust its allowance
    // without changing the form schema.
    if (cached.expiresAt === null || (!revalidateUploadState && cached.expiresAt > Date.now()))
      return cached.promise;
    syncCache.delete(key);
  }
  if (!opts?.bypassCache && !revalidateUploadState) {
    const stored = readStoredSync(client, form.id, hash);
    if (stored) {
      const promise = Promise.resolve({
        formId: stored.formId,
        slug: stored.slug,
        manageUrl: stored.manageUrl,
        status: stored.status,
        uploadFileSizeLimitMb: stored.uploadFileSizeLimitMb,
      });
      syncCache.set(key, {
        promise,
        expiresAt: stored.ts + syncTtlMs(stored.status),
      });
      return promise;
    }
  }
  const promise = syncWithRetry(client, form);
  const entry: SyncCacheEntry = { promise, expiresAt: null };
  syncCache.set(key, entry);
  promise.then(
    (result) => {
      if (syncCache.get(key) !== entry) return;
      if (revalidateUploadState || isVolatileSync(result)) {
        syncCache.delete(key);
        return;
      }
      entry.expiresAt = Date.now() + syncTtlMs(result.status);
      writeStoredSync(client, form.id, hash, result);
    },
    () => {
      if (syncCache.get(key) === entry) syncCache.delete(key);
    },
  );
  return promise;
}
