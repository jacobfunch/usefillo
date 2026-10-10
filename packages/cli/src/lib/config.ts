import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".fillo");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type Config = {
  /** Preserve fields owned by other Fillo tools during read/modify/write. */
  [key: string]: unknown;
  token?: string;
  tokenApi?: string;
  pk?: string;
  /** The deployment `pk` was provisioned on (`agent bootstrap --api` or
   *  FILLO_API at `fillo init`), so `fillo claim` asks the server that holds
   *  the preview. Absent on older configs, which fall back to the default. */
  pkApi?: string;
  claimUrl?: string;
  /** The address `fillo init` provisioned with — lets `fillo claim` say where
   *  the claim email went without asking again. */
  email?: string;
  /** The display name `fillo init` provisioned with (flag or git config
   *  user.name). Applied to the account at claim as a display default. */
  name?: string;
  /** The provision's claim-cookie value, captured at `fillo init`. `fillo
   *  claim` presents it to the cookie-keyed claim-email endpoints; it is
   *  single-use server-side and dropped from the config once the claim lands.
   *  Never print it. */
  claimToken?: string;
};

export function readConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const result: Config = { ...record };
    for (const key of [
      "token",
      "tokenApi",
      "pk",
      "pkApi",
      "claimUrl",
      "email",
      "name",
      "claimToken",
    ] as const) {
      if (typeof record[key] !== "string") delete result[key];
    }
    return result;
  } catch {
    return {};
  }
}

export function writeConfig(c: Config) {
  // The config holds the account token — keep it owner-only (like gh/npm).
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best effort (e.g. Windows) */
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  // writeFile's mode doesn't tighten an existing file's perms — enforce it.
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
}

/** Keep the selected project key, but retire the completed preview setup. */
export function saveAccountToken(token: string, tokenApi: string) {
  const {
    preview: _preview,
    provision: _provision,
    claimToken: _claimToken,
    claimUrl: _claimUrl,
    ...rest
  } = readConfig();
  writeConfig({ ...rest, token, tokenApi, activeContext: "account" });
}
