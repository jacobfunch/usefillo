import { die } from "./output.js";

export type Flags = Record<string, string | boolean>;

const BOOLEAN_FLAGS = new Set([
  "account",
  "allow-breaking",
  "allow-code",
  "draft",
  "stage",
  "force",
  "global",
  "help",
  "h",
  "json",
  "project",
  "version",
  "v",
  // `fillo login`: force the device-code flow instead of the loopback lane
  // (`--device` is the alias). Presence-only.
  "headless",
  "device",
  // Workspace commands (storage/slack/discord/delete): presence-only switches.
  "force-path-style",
  "channels",
  "refresh",
  // `discord enable --auto-join`: widens a role grant so a non-member can be
  // added to the server. Presence-only — it is never "=false".
  "auto-join",
  // `hubspot enable --marketable`: new Contacts become marketing contacts
  // (a billing-visible choice in HubSpot). Presence-only.
  "marketable",
  "yes",
  "also-unpublish",
  "cancel",
  // `storage folder`: presence-only switches for the list/reset lanes.
  "list",
  "reset",
  // Response/delivery operations: presence-only switches. `--held` lists
  // withheld submissions instead of accepted ones; `--all` widens an operation
  // from named ids to the whole form; `--also-responses` deletes a forgotten
  // person's answers (and file bytes) too.
  "held",
  "all",
  "also-responses",
  // `fillo developers origins --clear`: presence-only "empty the allow-list".
  "clear",
]);
// Boolean-VALUED flags: may be written bare (presence ⇒ true) OR with an
// explicit `=true`/`=false`. `webhooks add` uses the bare form to opt in;
// `webhooks set` flips it either way with `--include-abandoned=true|false`.
// Distinct from BOOLEAN_FLAGS, which reject any value at all.
const BOOLISH_FLAGS = new Set(["include-abandoned"]);
// The human-layer flag (lib/confirm.ts): bare `--confirm` acknowledges a
// Tier B outward action; `--confirm "<exact target>"` is the typed Tier C
// confirmation. Both shapes are valid at parse time — the tier decides, and a
// bare flag never satisfies a typed confirmation (flagString ignores `true`),
// so this cannot loosen a delete.
const CONFIRM_FLAGS = new Set(["confirm"]);
// --json is accepted everywhere: commands with machine output honor it, the
// rest keep their human output (documented in `fillo --help`).
const GLOBAL_FLAGS = new Set(["help", "h", "json", "version", "v"]);

export function validateFlags(
  command: string | undefined,
  flags: Flags,
  commandFlags: readonly string[] | undefined,
): void {
  const allowed = new Set([...GLOBAL_FLAGS, ...(commandFlags ?? [])]);
  for (const [key, value] of Object.entries(flags)) {
    if (!allowed.has(key)) die(`Unknown flag for ${command ?? "fillo"}: --${key}`);
    if (BOOLEAN_FLAGS.has(key)) {
      if (value !== true) die(`--${key} does not take a value.`);
    } else if (BOOLISH_FLAGS.has(key)) {
      if (value !== true && value !== "true" && value !== "false") {
        die(`--${key} must be true or false.`);
      }
    } else if (CONFIRM_FLAGS.has(key)) {
      if (value !== true && (typeof value !== "string" || value.length === 0)) {
        die(`--${key} takes an optional value.`);
      }
    } else if (typeof value !== "string" || value.length === 0) {
      die(`--${key} requires a value.`);
    }
  }
}

/**
 * Read a boolean-valued flag (see BOOLISH_FLAGS): bare presence and `=true`
 * both mean true, `=false` means false, absent means undefined. Assumes
 * validateFlags has already rejected any other value.
 */
export function boolishFlag(flags: Flags, key: string): boolean | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  return value === true || value === "true";
}

/**
 * How `--confirm` was written: "typed" carries the exact target a Tier C
 * command must name, "bare" is the Tier B agreement flag, "absent" is neither.
 * The one reader is `requireConfirm` (lib/confirm.ts), which is the only place
 * the human-layer gates are implemented.
 */
export function confirmFlag(
  flags: Flags,
): { kind: "typed"; value: string } | { kind: "bare" } | { kind: "absent" } {
  const value = flags.confirm;
  if (typeof value === "string" && value.length > 0) return { kind: "typed", value };
  if (value === true) return { kind: "bare" };
  return { kind: "absent" };
}

export function flagString(flags: Flags, key: string) {
  const value = flags[key];
  return typeof value === "string" && value ? value : undefined;
}

export function enumFlag<T extends string>(
  flags: Flags,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    die(`--${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalStringFlag(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) die(`--${key} requires a value.`);
  return value;
}

export function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "-v") {
      flags[a.slice(1)] = true;
      continue;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    // A bare boolean or boolish flag is presence-only ⇒ true. An explicit
    // `--boolish=false` took the `=` branch above and never reaches here.
    if (BOOLEAN_FLAGS.has(key) || BOOLISH_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    // `--confirm` may carry a value or stand alone; the value-consuming branch
    // below already yields `true` when nothing follows it.
    const next = args[i + 1];
    // A following --flag is not this flag's value; validation reports the
    // missing value for non-boolean flags below.
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { positional, flags };
}
