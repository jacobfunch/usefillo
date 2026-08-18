import { readConfig } from "./config.js";
import { die, terminalText } from "./output.js";

const DEFAULT_API = "https://fillo.so";
// `FILLO_API= fillo …` (empty or blank) must mean "unset", not "use an empty
// base URL" — that would turn every request into an unparseable relative URL.
const apiOverride = process.env.FILLO_API?.trim();
export const API = (apiOverride || DEFAULT_API).replace(/\/$/, "");
export const REQUEST_TIMEOUT_MS = 30_000;
export const SYNC_TOKEN_ENV = "FILLO_SYNC_TOKEN";

export function requireTokenFor(apiBase: string): string {
  const config = readConfig();
  if (typeof config.token !== "string" || !config.token) {
    die("Not logged in. Run `fillo login` first.");
  }
  if (typeof config.tokenApi !== "string" || !config.tokenApi) {
    die("This login cannot be used safely. Run `fillo login` again, then retry.");
  }
  const tokenApi = config.tokenApi.replace(/\/$/, "");
  if (apiBase.replace(/\/$/, "") !== tokenApi) {
    die(
      `This login belongs to ${terminalText(tokenApi)}. ` +
        "Log in to the requested Fillo deployment, then try again.",
    );
  }
  return config.token;
}

export function requireToken(): string {
  return requireTokenFor(API);
}

/**
 * Node's fetch reports every connection-level failure as a bare
 * "TypeError: fetch failed", with the actual reason (ECONNREFUSED, DNS,
 * timeout) buried in the cause chain and the target host never named. Rethrow
 * with both spelled out, so a stale FILLO_API/--api override is a one-glance
 * diagnosis instead of a dead end. Throws rather than die()s: pollers that
 * tolerate transient failures keep their catch semantics.
 */
export function networkFailure(apiBase: string, error: unknown): Error {
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const reason =
    causeCode(error) ?? (timedOut ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s` : undefined);
  const hint =
    apiBase === DEFAULT_API
      ? "Check your network connection and try again."
      : `The CLI is pointed there by FILLO_API or --api — unset the override to use ${DEFAULT_API}, or start that deployment.`;
  return new Error(
    `Couldn't reach ${terminalText(apiBase)}${reason ? ` (${reason})` : ""}. ${hint}`,
    {
      cause: error,
    },
  );
}

/** First error code in the cause chain (AggregateError branches included). */
function causeCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 8) return undefined;
  const { code, errors, cause } = error as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === "string" && code) return code;
  if (Array.isArray(errors)) {
    for (const nested of errors) {
      const found = causeCode(nested, depth + 1);
      if (found) return found;
    }
  }
  return causeCode(cause, depth + 1);
}

export async function api(
  path: string,
  init: RequestInit & { token?: string } = {},
  apiBase: string = API,
) {
  const { token, ...rest } = init;
  try {
    return await fetch(`${apiBase}/api/v1${path}`, {
      ...rest,
      signal: rest.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
  } catch (error) {
    throw networkFailure(apiBase, error);
  }
}

// A gateway/proxy can answer with an HTML error page — parsing that as JSON
// throws an opaque "Unexpected token <". Die with the status instead.
export async function readJson(res: Response, apiBase: string = API): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    die(`Unexpected non-JSON response from ${apiBase} (${res.status}).`);
  }
}
