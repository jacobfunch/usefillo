import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveApiKey, resolveToken } from "../config.js";
import { type FilloResponse, apiErrorMessage, filloFetch } from "../http.js";
import { fail } from "../result.js";

/**
 * Credential lanes for the management tools.
 *
 * Every workspace capability Fillo exposes has two HTTP mounts that take the
 * same body and mean the same thing: `/api/v1/cli/...` for a human's `fcli_`
 * login token, and `/api/v1/manage/...` for a scoped `fsk_` project API key.
 * A tool picks ONE and never mixes them:
 *
 *   1. `fcli_` first (FILLO_TOKEN, or `~/.fillo/config.json` from `fillo login`).
 *      It is the person's own authority — the same thing the CLI uses — so it
 *      carries every management capability without a scope negotiation.
 *   2. `fsk_` otherwise (FILLO_API_KEY). Narrower on purpose: the key holder
 *      chose its scopes at mint, and a missing one is a 403 that names it.
 *
 * Preferring the login token matters for more than convenience: an `fsk_` key
 * has no acting human, so the member and sync-token routes re-lock it against
 * whoever minted it. When both credentials are present the person is at the
 * keyboard, and their own token is the honest one to act with.
 */

export interface Lane {
  /** Which mount to call — also the path segment after `/api/v1/`. */
  readonly kind: "cli" | "manage";
  /** The bearer credential for that mount. Never logged, never returned. */
  readonly token: string;
}

export function resolveLane(): Lane | undefined {
  const token = resolveToken();
  if (token) return { kind: "cli", token };
  const apiKey = resolveApiKey();
  if (apiKey) return { kind: "manage", token: apiKey };
  return undefined;
}

/** The one "you have no credential" answer, naming the scope an `fsk_` key
 *  would need so the human can mint the right thing the first time. */
export function noCredential(scope: string): CallToolResult {
  return fail(
    "No workspace credential. Run `npx @usefillo/cli login` (or set FILLO_TOKEN) to manage this " +
      `workspace as yourself, or set FILLO_API_KEY to a project API key carrying the ${scope} ` +
      "scope — mint one in Settings → Connections.",
  );
}

export interface LaneRequest {
  /** Path after the mount, e.g. `/forms/abc/unpublish`. The two mounts agree on
   *  every path this server calls, so there is no per-lane override. */
  path: string;
  method?: string;
  body?: unknown;
  searchParams?: URLSearchParams;
}

export function laneFetch(lane: Lane, request: LaneRequest): Promise<FilloResponse> {
  return filloFetch(`/api/v1/${lane.kind}${request.path}`, {
    token: lane.token,
    ...(request.method ? { method: request.method } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.searchParams ? { searchParams: request.searchParams } : {}),
  });
}

export interface LaneProblem {
  /** The scope an `fsk_` key needs, named in the 403 hint. */
  scope: string;
  /** What to say when the API answered with no `{error}` of its own. */
  fallback: string;
  /** Replaces the API's 404 copy when the tool knows what was being addressed. */
  missing?: string;
}

/**
 * Map a failed API response to a tool error the model can act on, or return
 * undefined when the call succeeded. Fillo's routes already answer with stable,
 * already-safe `{error}` copy, so this passes that through and only adds the
 * next move — which credential to fix, which scope to mint.
 */
export function laneProblem(
  lane: Lane,
  res: FilloResponse,
  options: LaneProblem,
): CallToolResult | undefined {
  if (res.ok) return undefined;

  if (res.status === 401) {
    return fail(
      lane.kind === "cli"
        ? "Your Fillo login token is invalid or expired. Run `npx @usefillo/cli login`, or set a fresh FILLO_TOKEN."
        : "That project API key is invalid, revoked, or expired. Mint a new one in Settings → Connections and set FILLO_API_KEY.",
    );
  }
  if (res.status === 403) {
    return fail(
      `${apiErrorMessage(res, "This credential isn't allowed to do that")}` +
        (lane.kind === "manage"
          ? ` Mint a key carrying ${options.scope} in Settings → Connections, or use a login token (\`npx @usefillo/cli login\`) instead.`
          : ""),
    );
  }
  if (res.status === 404 && options.missing) return fail(options.missing);
  if (res.status === 413) return fail("That request body is too large for Fillo to accept.");

  // 400 (validation), 409 (conflict, including every confirm mismatch), 410,
  // 429, and 5xx all carry route-authored copy that already names the fix.
  return fail(apiErrorMessage(res, options.fallback), problemData(res));
}

/** The machine-readable extras Fillo attaches to some failures. Kept narrow so
 *  a route can never smuggle unexpected material into a tool result. */
function problemData(res: FilloResponse): Record<string, unknown> | undefined {
  const json = res.json;
  if (!json || typeof json !== "object") return undefined;
  const data: Record<string, unknown> = {};
  if (typeof json.code === "string") data.code = json.code;
  if (typeof json.warningCode === "string") data.warningCode = json.warningCode;
  if (typeof json.warningUrl === "string") data.warningUrl = json.warningUrl;
  if (Array.isArray(json.breakingFields)) data.breakingFields = json.breakingFields;
  return Object.keys(data).length ? data : undefined;
}

/** The form body both mounts return, bare on each. */
export function formBody(json: unknown): Record<string, unknown> | undefined {
  return json && typeof json === "object" && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : undefined;
}

/**
 * One credentialed round trip: pick the lane, call the mount, and turn a failed
 * response into the tool error it deserves. Every management tool opens this
 * way, so it lives here once rather than as a preamble each of them repeats.
 *
 * `{ ok: true }` carries the lane as well as the response, because a few tools
 * still have to know which mount answered them.
 */
export type LaneCall =
  | { ok: true; lane: Lane; res: FilloResponse }
  | { ok: false; result: CallToolResult };

export async function laneCall(request: LaneRequest, options: LaneProblem): Promise<LaneCall> {
  const lane = resolveLane();
  if (!lane) return { ok: false, result: noCredential(options.scope) };

  const res = await laneFetch(lane, request);
  const problem = laneProblem(lane, res, options);
  if (problem) return { ok: false, result: problem };

  return { ok: true, lane, res };
}

/** The form argument every per-form tool takes, described once so the twenty
 *  tools that accept it can never disagree about what resolves. */
export const FORM_ARG = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "Form id or hosted slug. A stable push handle also resolves on a login token; a project API key takes the id or slug.",
  );

/** The one "that form isn't here" answer, for the 404 a per-form route gives. */
export const noForm = (form: string): string =>
  `No form "${form}" in this project. Check the id with fillo_list_forms — it may belong to another project.`;

/** Everything the responses-grid filter grammar accepts, shared by the tools
 *  that read rows, held rows, and insights so the three spell it identically. */
export interface GridFilters {
  range?: string;
  q?: string;
  source?: string;
  respondent?: string;
  where?: string[];
  cursor?: string;
  limit?: number;
}

export function gridSearchParams(filters: GridFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.range) params.set("range", filters.range);
  if (filters.q) params.set("q", filters.q);
  if (filters.source) params.set("source", filters.source);
  if (filters.respondent) params.set("respondent", filters.respondent);
  for (const clause of filters.where ?? []) params.append("where", clause);
  if (filters.cursor) params.set("cursor", filters.cursor);
  if (filters.limit) params.set("limit", String(filters.limit));
  return params;
}

/** `Form "<name>"` for a summary line, falling back to whatever id we have. */
export function formLabel(form: Record<string, unknown> | undefined, fallback: string): string {
  const name = form?.name;
  if (typeof name === "string" && name) return name;
  const id = form?.id;
  return typeof id === "string" && id ? id : fallback;
}
