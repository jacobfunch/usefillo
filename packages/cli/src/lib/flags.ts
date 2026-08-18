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
  "yes",
  "also-unpublish",
  "cancel",
]);
// Boolean-VALUED flags: may be written bare (presence ⇒ true) OR with an
// explicit `=true`/`=false`. `webhooks add` uses the bare form to opt in;
// `webhooks set` flips it either way with `--include-abandoned=true|false`.
// Distinct from BOOLEAN_FLAGS, which reject any value at all.
const BOOLISH_FLAGS = new Set(["include-abandoned"]);
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
