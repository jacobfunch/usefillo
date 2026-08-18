import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".fillo");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type Config = {
  token?: string;
  tokenApi?: string;
  pk?: string;
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
    return {
      ...(typeof record.token === "string" ? { token: record.token } : {}),
      ...(typeof record.tokenApi === "string" ? { tokenApi: record.tokenApi } : {}),
      ...(typeof record.pk === "string" ? { pk: record.pk } : {}),
      ...(typeof record.claimUrl === "string" ? { claimUrl: record.claimUrl } : {}),
      ...(typeof record.email === "string" ? { email: record.email } : {}),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.claimToken === "string" ? { claimToken: record.claimToken } : {}),
    };
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
