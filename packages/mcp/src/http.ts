import { CLIENT_VERSION, REQUEST_TIMEOUT_MS, apiOrigin } from "./config.js";

/** A parsed HTTP response from the Fillo API. `json` is the parsed body when it
 *  was JSON (undefined for Markdown/HTML/empty), `text` is always the raw body. */
export interface FilloResponse {
  status: number;
  ok: boolean;
  text: string;
  // Arbitrary JSON from a public API route; the caller narrows it per endpoint.
  // biome-ignore lint/suspicious/noExplicitAny: untyped public-API JSON.
  json: any;
}

export interface FilloRequest {
  method?: string;
  /** JSON request body — serialized and sent with `Content-Type: application/json`. */
  body?: unknown;
  /** Bearer credential (`fcli_…` login token or `fsk_…` API key). Never a `pk_`. */
  token?: string;
  searchParams?: URLSearchParams;
}

/**
 * The one place the server talks to Fillo. Every request carries the
 * `X-Fillo-Client` observability header and a hard timeout. A gateway can answer
 * with a non-JSON error page, so JSON parsing is best-effort and never throws.
 */
export async function filloFetch(path: string, init: FilloRequest = {}): Promise<FilloResponse> {
  const query = init.searchParams?.toString();
  const url = `${apiOrigin()}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = { "X-Fillo-Client": CLIENT_VERSION };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, text, json };
}

/** The stable `{ error }` message a Fillo route returns, or a status fallback. */
export function apiErrorMessage(res: FilloResponse, fallback: string): string {
  const message = res.json && typeof res.json === "object" ? res.json.error : undefined;
  return typeof message === "string" && message ? message : `${fallback} (HTTP ${res.status}).`;
}
