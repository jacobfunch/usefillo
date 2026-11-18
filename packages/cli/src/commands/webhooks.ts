import { callApi, failed } from "../lib/api.js";
import { promptsBlocked, requireConfirm } from "../lib/confirm.js";
import { boolishFlag, enumFlag, type Flags, flagString } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  die,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  printTable,
  terminalText,
} from "../lib/output.js";
import { readSecret } from "../lib/prompt.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo webhooks` — a form's generic signed webhooks over the human's `fcli_`
 * credential. `add` returns the signing secret exactly once (Fillo stores only
 * a hash), so the CLI prints it with a store-it-now warning and never lists it
 * again. `[form]` is an id, slug, or push handle; Zapier REST Hook
 * subscriptions are invisible here (the server excludes them).
 *
 * `--auth` configures the credential Fillo sends TO the receiving endpoint
 * (separate from Fillo's own signature, which is always applied). The secret is
 * never an argument: arguments land in shell history, `ps` output, and CI logs.
 * It comes from a hidden prompt or FILLO_WEBHOOK_AUTH_SECRET, the same rule the
 * Discord webhook URL follows in commands/discord.ts, and it is never echoed
 * back — not on success, not on failure.
 */

const dateTime = (iso: string) => iso.slice(0, 16).replace("T", " ");
const AUTH_MODES = ["none", "bearer", "x-api-key"] as const;

/** The consent notice names the HOST, not the URL: a path can carry a token,
 *  and the host is the part a person can recognize or fail to recognize. */
function receivingHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
const AUTH_SECRET_ENV = "FILLO_WEBHOOK_AUTH_SECRET";

type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  authentication?: string;
  createdAt: string;
};

type Authentication = { type: "none" } | { type: "bearer" | "x-api-key"; secret: string };

/**
 * Resolve `--auth` into the request's `authentication` object, reading the
 * secret from the environment or a hidden prompt. Returns undefined when the
 * flag is absent, so an untouched webhook keeps whatever it already had.
 */
async function resolveAuthentication(flags: Flags): Promise<Authentication | undefined> {
  const mode = enumFlag(flags, "auth", AUTH_MODES);
  if (!mode) return undefined;
  if (mode === "none") return { type: "none" };

  const fromEnv = process.env[AUTH_SECRET_ENV]?.trim() ?? "";
  if (fromEnv) return { type: mode, secret: fromEnv };
  if (promptsBlocked(flags)) {
    die(
      `Set ${AUTH_SECRET_ENV} to the receiving endpoint's credential and re-run. ` +
        "It is never accepted as an argument — arguments land in shell history and `ps` output.",
    );
  }
  const typed = await readSecret(`  ${mode} secret for the receiving endpoint (hidden): `).catch(
    () => "",
  );
  if (!typed) {
    die(`No secret entered. Type it at the prompt, or set ${AUTH_SECRET_ENV} and re-run.`);
  }
  return { type: mode, secret: typed };
}

/** How a listed webhook authenticates to its receiver (never the secret). */
function authLabel(value: string | undefined): string {
  return !value || value === "none" ? "—" : value;
}

async function list(handle: string | undefined, flags: Flags) {
  if (!handle) die("Usage: fillo webhooks list <form>");
  const body = await callApi<{ webhooks: WebhookRow[] }>(
    `/cli/forms/${encodeURIComponent(handle)}/webhooks`,
    {},
    { fallback: failed("webhooks list"), expect: (b) => Array.isArray(b.webhooks) },
  );
  if (jsonMode(flags)) return emitResult(body);
  if (body.webhooks.length === 0) {
    console.log("  No webhooks yet. Add one with `fillo webhooks add <form> --url https://…`.");
    return;
  }
  const rows = body.webhooks.map((w) => [
    w.id,
    terminalText(w.url),
    terminalText((w.events ?? []).join(", ")),
    // The mode only — a stored receiver credential is write-only and is never
    // read back, by this command or any other.
    authLabel(w.authentication),
    dateTime(w.createdAt ?? ""),
  ]);
  console.log("");
  printTable(["ID", "URL", "EVENTS", "AUTH", "CREATED"], rows);
}

async function add(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  const usage =
    "Usage: fillo webhooks add <form> --url <url> [--include-abandoned] [--auth none|bearer|x-api-key]";
  if (!handle) die(usage);
  const url = flagString(flags, "url");
  if (!url) die(usage);
  const includeAbandoned = boolishFlag(flags, "include-abandoned");
  const authentication = await resolveAuthentication(flags);

  // Tier B: from here on, every response this form takes is sent to a host
  // Fillo does not control. Name that host in the notice — it is the part a
  // person can actually check, and the part a mistyped URL gets wrong.
  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    command: `fillo webhooks add ${handle} --url ${url}`,
    notice:
      `Every response to this form will be posted to ${receivingHost(url)}. ` +
      "Respondent answers leave Fillo for that endpoint.",
  });

  const body = await callApi<{
    id: string;
    url?: string;
    events?: string[];
    authentication?: string;
    secret: string;
  }>(
    `/cli/forms/${encodeURIComponent(handle)}/webhooks`,
    {
      method: "POST",
      // The receiver credential goes straight into the request body and is
      // never printed back, not even in --json (the server echoes the MODE).
      body: JSON.stringify({
        url,
        ...(includeAbandoned !== undefined ? { includeAbandoned } : {}),
        ...(authentication ? { authentication } : {}),
      }),
    },
    {
      fallback: failed("webhooks add"),
      expect: (b) => Boolean(b.id) && Boolean(b.secret),
    },
  );

  if (json) return emitResult(body);
  console.log(`\n  ${okMark()} Added webhook ${bold(terminalText(body.id))}`);
  console.log(`  URL:     ${terminalText(body.url ?? url)}`);
  console.log(`  Events:  ${terminalText((body.events ?? []).join(", "))}`);
  console.log(`  Auth:    ${terminalText(authLabel(body.authentication))}`);
  console.log(
    `\n  ${bold("Signing secret")} (store it — Fillo signs deliveries with it, shown only now):`,
  );
  console.log(`\n    ${body.secret}\n`);
}

async function set(handle: string | undefined, id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  const includeAbandoned = boolishFlag(flags, "include-abandoned");
  const authentication = await resolveAuthentication(flags);
  if (!handle || !id || (includeAbandoned === undefined && authentication === undefined)) {
    die(
      "Usage: fillo webhooks set <form> <id> [--include-abandoned=true|false] [--auth none|bearer|x-api-key]",
    );
  }
  const body = await callApi<{ id: string; events?: string[]; authentication?: string }>(
    `/cli/forms/${encodeURIComponent(handle)}/webhooks/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      // `authentication` replaces the stored credential wholesale; omitting it
      // leaves whatever the webhook already had untouched.
      body: JSON.stringify({
        ...(includeAbandoned !== undefined ? { includeAbandoned } : {}),
        ...(authentication ? { authentication } : {}),
      }),
    },
    {
      fallback: failed("webhooks set"),
      expect: (b) => Boolean(b.id),
      on: (res, b) => {
        if (res.status === 404) die(b.error ?? "Webhook not found");
      },
    },
  );
  if (json) return emitResult(body);
  console.log(
    `  ${okMark()} Updated ${terminalText(body.id)} — events: ${terminalText((body.events ?? []).join(", "))}, auth: ${terminalText(authLabel(body.authentication))}`,
  );
}

async function remove(handle: string | undefined, id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  // Removal must name the webhook — never guess an implicit target.
  if (!handle || !id)
    die("Usage: fillo webhooks remove <form> <id> — find the id with `fillo webhooks list`.");
  const body = await callApi<{ id?: string; deleted?: boolean }>(
    `/cli/forms/${encodeURIComponent(handle)}/webhooks/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    { fallback: failed("webhooks remove"), expect: (b) => b.deleted === true },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Removed webhook ${terminalText(id)}.`);
}

async function webhooks(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return webhooksHelp();
  if (subcommand === "list" || subcommand === "ls") return list(args[0], flags);
  if (subcommand === "add") return add(args[0], flags);
  if (subcommand === "set") return set(args[0], args[1], flags);
  if (subcommand === "remove" || subcommand === "rm") return remove(args[0], args[1], flags);
  die(
    `Unknown webhooks command: ${terminalText(subcommand)} (expected list, add, set, or remove).`,
  );
}

function webhooksHelp() {
  console.log(`
  ${boldRaw("fillo webhooks")} — a form's signed webhooks

  ${boldRaw("Commands")}
    webhooks list <form>              List the form's webhooks (never the secret)
    webhooks add <form> --url <url>   Add a webhook — the signing secret prints once
                       ${dimRaw("--include-abandoned   also deliver abandoned-draft events")}
                       ${dimRaw("--auth none|bearer|x-api-key   how Fillo authenticates TO your endpoint")}
                       ${dimRaw("--confirm   required in agent mode (answers leave Fillo)")}
    webhooks set <form> <id>          Change delivery settings
                       ${dimRaw("--include-abandoned=true|false   toggle abandoned-draft delivery")}
                       ${dimRaw("--auth none|bearer|x-api-key     replace the receiver credential")}
    webhooks remove <form> <id>       Delete a webhook by id

  ${dimRaw("<form> is a form id, slug, or push handle. The signing secret is shown only")}
  ${dimRaw("at add time — store it then.")}
  ${dimRaw(`--auth reads its secret from ${AUTH_SECRET_ENV} or a hidden prompt; it is`)}
  ${dimRaw("never an argument (arguments land in shell history and `ps` output) and is")}
  ${dimRaw("never printed back. Listing shows the mode only. --auth none clears it.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const webhooksCommand: Command = {
  name: "webhooks",
  aliases: ["webhook"],
  flags: ["url", "include-abandoned", "auth", "confirm"],
  run: (args, flags) => webhooks(args[0], args.slice(1), flags),
  help: webhooksHelp,
};
