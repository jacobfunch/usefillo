import { readConfig } from "./config.js";
import { clientTelemetryHeaders } from "./client-telemetry.js";
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
        ...clientTelemetryHeaders(),
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

/**
 * Every authenticated CLI call ends in the same four lines: look the token up,
 * refuse a rejected one, read the JSON, and die with the server's `error` (or a
 * command-specific fallback) when the status is not ok. `callApi` IS that
 * epilogue, so a command body is its request plus only the statuses it words
 * itself.
 *
 * `init.token` reuses a token the caller already holds; without it the lookup
 * happens here, at the same point in the command it used to. `opts.on` runs
 * after the 401 check and the JSON read but before the generic failure — that
 * is where a command's own 404/409/410 wording goes, and returning from it
 * falls through to the generic die.
 */
export type CallOptions<T> = {
  /** Die with this when the failing response carries no `error` of its own. As
   *  a function it receives the status — `failed("responses list")` is the
   *  house sentence, and a plain string is for the few that read differently. */
  fallback: string | ((status: number) => string);
  /** Call a non-default deployment (the login flows target one by URL). */
  apiBase?: string;
  /** A 2xx shaped wrong is a failure too, and gets the same message. Declaring
   *  the fields this call needs as REQUIRED in `T` and asserting them here is
   *  the guarantee the old `if (!res.ok || !body.x) die(…)` gave, minus the
   *  copy — so the command reads them without re-checking. */
  expect?: (body: T) => boolean;
  /** The statuses this command words itself. Dies, or returns to fall through. */
  on?: (res: Response, body: T & { error?: string }) => void | Promise<void>;
};

/**
 * The CLI's house sentence for a request that failed without saying why:
 * `failed("responses list")` → "responses list failed (500)." Spelled once so
 * every command's last-resort message reads the same way.
 */
export const failed = (operation: string) => (status: number) => `${operation} failed (${status}).`;

export async function callApi<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
  opts: CallOptions<T>,
): Promise<T> {
  const apiBase = opts.apiBase ?? API;
  const res = await api(path, { ...init, token: init.token ?? requireTokenFor(apiBase) }, apiBase);
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  const body = (await readJson(res, apiBase)) as T & { error?: string };
  await opts.on?.(res, body);
  if (!res.ok || opts.expect?.(body) === false) {
    die(
      body.error ??
        (typeof opts.fallback === "function" ? opts.fallback(res.status) : opts.fallback),
    );
  }
  return body;
}

/**
 * A minted credential is printed in plaintext exactly once. Refuse anything
 * that does not look like the Fillo secret it claims to be, rather than echo
 * arbitrary server bytes into a terminal, a log, or an agent's context.
 */
export function assertMintedSecret(value: string, prefix: string, noun = "token"): void {
  if (!new RegExp(`^${prefix}[A-Za-z0-9._~-]{8,512}$`).test(value)) {
    die(`Fillo returned an unexpected ${noun} format.`);
  }
}
