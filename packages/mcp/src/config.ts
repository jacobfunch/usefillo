import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Credential + origin resolution for the Fillo MCP server.
 *
 * The server is a thin client over Fillo's public HTTP API. It authenticates
 * with exactly the credentials a human already has: the `~/.fillo/config.json`
 * the CLI writes (`fillo login` / `fillo init`), or environment variables. It
 * never touches the database and imports no app code.
 */

const DEFAULT_API = "https://fillo.so";
const REQUEST_TIMEOUT_MS = 30_000;

export { REQUEST_TIMEOUT_MS };

/** The observability header every request carries, e.g. `@usefillo/mcp@0.1.0`.
 *  Already CORS-allow-listed by the API. Read the version from the package next
 *  to dist/ so it can't drift from what npm published. */
export const CLIENT_VERSION = `@usefillo/mcp@${packageVersion()}`;

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Origin of the Fillo deployment to call. `FILLO_API` overrides it (mirrors the
 *  CLI) so the same server can target a staging/dev instance. */
export function apiOrigin(): string {
  return (process.env.FILLO_API ?? DEFAULT_API).replace(/\/$/, "");
}

function configDir(): string {
  // FILLO_CONFIG_DIR keeps the server's reads/writes off a shared home config
  // (used by the test/e2e suites), defaulting to the CLI's `~/.fillo`.
  return process.env.FILLO_CONFIG_DIR?.trim() || join(homedir(), ".fillo");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

/** What we persist locally. `token`/`pk`/`apiKey` mirror the CLI's config plus
 *  the 04-P1 `fsk_` key; `provision` caches the caps/claim state the provision
 *  response reported, since that state is not queryable with a `pk_` alone. */
export interface Config {
  /** Which saved credential the local MCP workflow intentionally selected. */
  activeContext?: "account" | "provisional";
  /** `fcli_…` login token from `fillo login`. */
  token?: string;
  /** Origin the login token belongs to (guards against cross-deployment reuse). */
  tokenApi?: string;
  /** `pk_…` publishable key from `fillo init` / `fillo_provision_workspace`. */
  pk?: string;
  /** `fsk_…` project API key for the response tools. */
  apiKey?: string;
  /** Caps + claim state cached from the last provision on this machine. */
  provision?: {
    organizationId?: string;
    email?: string;
    responseCap?: number;
    expiresAt?: string;
    api?: string;
  };
}

export function readConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const provision =
      record.provision && typeof record.provision === "object" && !Array.isArray(record.provision)
        ? (record.provision as Config["provision"])
        : undefined;
    return {
      ...(record.activeContext === "account" || record.activeContext === "provisional"
        ? { activeContext: record.activeContext }
        : {}),
      ...(typeof record.token === "string" ? { token: record.token } : {}),
      ...(typeof record.tokenApi === "string" ? { tokenApi: record.tokenApi } : {}),
      ...(typeof record.pk === "string" ? { pk: record.pk } : {}),
      ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
      ...(provision ? { provision } : {}),
    };
  } catch {
    return {};
  }
}

export function writeConfig(next: Config): void {
  // The config can hold the account token — keep it owner-only, like the CLI
  // (and gh/npm). writeFile's mode doesn't tighten an existing file's perms, so
  // enforce 0600 explicitly afterward.
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort (e.g. Windows) */
  }
  writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
}

/** The `fcli_…` login token for the current origin, or undefined. Env wins; a
 *  config token is only used when its bound origin matches (a token minted for
 *  fillo.so must never be sent to a different deployment). */
export function resolveToken(): string | undefined {
  const fromEnv = process.env.FILLO_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const cfg = readConfig();
  if (cfg.activeContext === "provisional") return undefined;
  return tokenFromConfig(cfg);
}

/** Account-management tools can deliberately leave a provisional context by
 * selecting a project. Environment credentials remain explicit overrides. */
export function resolveAccountToken(): string | undefined {
  const fromEnv = process.env.FILLO_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return tokenFromConfig(readConfig());
}

function tokenFromConfig(cfg: Config): string | undefined {
  if (!cfg.token) return undefined;
  const boundTo = cfg.tokenApi?.replace(/\/$/, "");
  // Older configs stored no origin; accept them for the default deployment only.
  if (!boundTo) return apiOrigin() === DEFAULT_API ? cfg.token : undefined;
  return boundTo === apiOrigin() ? cfg.token : undefined;
}

/** The `pk_…` publishable key, or undefined. Env wins over config. */
export function resolvePk(): string | undefined {
  return process.env.FILLO_PK?.trim() || readConfig().pk;
}

/** The `fsk_…` project API key for the response tools, or undefined. */
export function resolveApiKey(): string | undefined {
  return process.env.FILLO_API_KEY?.trim() || readConfig().apiKey;
}

/** The cached provision caps/claim state for the current origin, or undefined.
 *  Scoped to origin so a stale cache from another deployment is never reported. */
export function resolveProvision(): NonNullable<Config["provision"]> | undefined {
  const provision = readConfig().provision;
  if (!provision) return undefined;
  if (provision.api && provision.api.replace(/\/$/, "") !== apiOrigin()) return undefined;
  return provision;
}
