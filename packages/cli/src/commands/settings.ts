import { api, readJson, requireToken } from "../lib/api.js";
import type { Flags } from "../lib/flags.js";
import {
  boldRaw,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo settings` — a form's operational settings over the human's `fcli_`
 * credential. `set` accepts exactly the dashboard patch keys and sends them as
 * one PATCH whose body IS the patch object; the server validates with the same
 * strict schema and writer the Settings page uses, so acceptance is identical.
 * `[form]` is an id, slug, or push handle.
 */

// The nine dashboard patch keys, grouped by how a `key=value` argument parses.
const BOOLEAN_KEYS = new Set([
  "sendReceipt",
  "saveProgress",
  "draftAnswersVisible",
  "resumeEmails",
  "draftDigest",
]);
const STRING_KEYS = new Set(["notifyEmail", "resumeUrl"]);
const JSON_KEYS = new Set(["responseLimit", "trust"]);
const ALLOWED_KEYS = [...BOOLEAN_KEYS, ...STRING_KEYS, ...JSON_KEYS].sort();

type SettingsBody = { settings?: Record<string, unknown>; error?: string };

function printSettings(settings: Record<string, unknown>) {
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    console.log("  (no settings)");
    return;
  }
  const width = Math.max(...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    const shown =
      value === null || value === undefined
        ? dim("(unset)")
        : typeof value === "object"
          ? terminalText(JSON.stringify(value))
          : terminalText(String(value));
    console.log(`  ${key.padEnd(width)}  ${shown}`);
  }
}

async function get(handle: string | undefined, flags: Flags) {
  if (!handle) die("Usage: fillo settings get <form>");
  const token = requireToken();
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}/settings`, { token });
  const body = (await readJson(res)) as SettingsBody;
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok || !body.settings) die(body.error ?? `settings get failed (${res.status}).`);
  if (jsonMode(flags)) return emitResult(body);
  console.log("");
  printSettings(body.settings);
  console.log("");
}

/** Turn one `key=value` argument into its typed patch entry (or die locally). */
function parsePair(pair: string): [string, unknown] {
  const eq = pair.indexOf("=");
  if (eq === -1) {
    die(`Settings are key=value pairs, e.g. sendReceipt=true. Got: ${terminalText(pair)}`);
  }
  const key = pair.slice(0, eq);
  const raw = pair.slice(eq + 1);
  if (!ALLOWED_KEYS.includes(key)) {
    die(`Unknown setting: ${terminalText(key)}. Valid keys: ${ALLOWED_KEYS.join(", ")}.`);
  }
  if (raw === "null") return [key, null];
  if (BOOLEAN_KEYS.has(key)) {
    if (raw === "true") return [key, true];
    if (raw === "false") return [key, false];
    die(`${key}=${terminalText(raw)} is not valid — ${key} takes true, false, or null.`);
  }
  if (JSON_KEYS.has(key)) {
    try {
      return [key, JSON.parse(raw)];
    } catch {
      die(
        `${key} must be valid JSON (or null). Example: ${key}='{"by":"browser","onRepeat":"update"}'.`,
      );
    }
  }
  // String keys (notifyEmail, resumeUrl): pass through; the server validates.
  return [key, raw];
}

async function set(handle: string | undefined, pairs: string[], flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) die("Usage: fillo settings set <form> key=value [key=value...]");
  if (pairs.length === 0) {
    die(`Usage: fillo settings set <form> key=value  (keys: ${ALLOWED_KEYS.join(", ")})`);
  }
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const [key, value] = parsePair(pair);
    patch[key] = value;
  }
  const sentKeys = Object.keys(patch);

  const token = requireToken();
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}/settings`, {
    method: "PATCH",
    token,
    body: JSON.stringify(patch),
  });
  const body = (await readJson(res)) as SettingsBody;
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 400) {
    die(`${body.error ?? "Invalid settings patch"} — keys sent: ${sentKeys.join(", ")}.`);
  }
  // Every form `fillo push` creates is code-managed, and the server rejects
  // saveProgress/responseLimit/trust on those (they live in the synced schema).
  // Pass the server's exact reason through, then name the fix — the same
  // next step the --help caveat gives.
  if (res.status === 409 && /controlled by the synced schema/i.test(body.error ?? "")) {
    die(`${body.error} Set them in the form schema you \`fillo push\`, then push again.`);
  }
  if (!res.ok || !body.settings) die(body.error ?? `settings set failed (${res.status}).`);

  if (json) return emitResult(body);
  console.log(`\n  ${okMark()} Updated ${sentKeys.join(", ")}\n`);
  printSettings(body.settings);
  console.log("");
}

async function settings(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return settingsHelp();
  if (subcommand === "get") return get(args[0], flags);
  if (subcommand === "set") return set(args[0], args.slice(1), flags);
  die(`Unknown settings command: ${terminalText(subcommand)} (expected get or set).`);
}

function settingsHelp() {
  console.log(`
  ${boldRaw("fillo settings")} — a form's operational settings

  ${boldRaw("Commands")}
    settings get <form>              Print the form's current settings
    settings set <form> key=value…   Patch one or more settings, then echo the result

  ${boldRaw("Keys")}
    ${dimRaw("booleans   sendReceipt, draftAnswersVisible, resumeEmails, draftDigest")}
    ${dimRaw("strings    notifyEmail, resumeUrl")}
    ${dimRaw("any key    =null clears it")}

  ${boldRaw("Controlled by your form schema")} ${dimRaw("(set them there and re-push, not here)")}
    ${dimRaw("saveProgress, responseLimit, trust")}
    ${dimRaw("Every form `fillo push` creates is code-managed, so the server rejects")}
    ${dimRaw("these here — edit them in the schema and run `fillo push` again. (Forms")}
    ${dimRaw("built in the dashboard still accept them — responseLimit/trust as JSON,")}
    ${dimRaw(`e.g. responseLimit='{"by":"browser","onRepeat":"update"}'.)`)}

  ${dimRaw("<form> is a form id, slug, or push handle. --json prints the raw server response on stdout.")}
`);
}

export const settingsCommand: Command = {
  name: "settings",
  flags: [],
  run: (args, flags) => settings(args[0], args.slice(1), flags),
  help: settingsHelp,
};
