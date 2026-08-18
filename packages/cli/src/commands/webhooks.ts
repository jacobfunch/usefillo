import { api, readJson, requireToken } from "../lib/api.js";
import { boolishFlag, type Flags, flagString } from "../lib/flags.js";
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
import type { Command } from "../lib/registry.js";

/**
 * `fillo webhooks` — a form's generic signed webhooks over the human's `fcli_`
 * credential. `add` returns the signing secret exactly once (Fillo stores only
 * a hash), so the CLI prints it with a store-it-now warning and never lists it
 * again. `[form]` is an id, slug, or push handle; Zapier REST Hook
 * subscriptions are invisible here (the server excludes them).
 */

const dateTime = (iso: string) => iso.slice(0, 16).replace("T", " ");

type WebhookRow = { id: string; url: string; events: string[]; createdAt: string };

async function list(handle: string | undefined, flags: Flags) {
  if (!handle) die("Usage: fillo webhooks list <form>");
  const token = requireToken();
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}/webhooks`, { token });
  const body = (await readJson(res)) as { webhooks?: WebhookRow[]; error?: string };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok || !Array.isArray(body.webhooks)) {
    die(body.error ?? `webhooks list failed (${res.status}).`);
  }
  if (jsonMode(flags)) return emitResult(body);
  if (body.webhooks.length === 0) {
    console.log("  No webhooks yet. Add one with `fillo webhooks add <form> --url https://…`.");
    return;
  }
  const rows = body.webhooks.map((w) => [
    w.id,
    terminalText(w.url),
    terminalText((w.events ?? []).join(", ")),
    dateTime(w.createdAt ?? ""),
  ]);
  console.log("");
  printTable(["ID", "URL", "EVENTS", "CREATED"], rows);
}

async function add(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) die("Usage: fillo webhooks add <form> --url <url> [--include-abandoned]");
  const url = flagString(flags, "url");
  if (!url) die("Usage: fillo webhooks add <form> --url <url> [--include-abandoned]");
  const includeAbandoned = boolishFlag(flags, "include-abandoned");
  const token = requireToken();
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}/webhooks`, {
    method: "POST",
    token,
    body: JSON.stringify({ url, ...(includeAbandoned !== undefined ? { includeAbandoned } : {}) }),
  });
  const body = (await readJson(res)) as {
    id?: string;
    url?: string;
    events?: string[];
    secret?: string;
    error?: string;
  };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok || !body.id || !body.secret)
    die(body.error ?? `webhooks add failed (${res.status}).`);

  if (json) return emitResult(body);
  console.log(`\n  ${okMark()} Added webhook ${bold(terminalText(body.id))}`);
  console.log(`  URL:     ${terminalText(body.url ?? url)}`);
  console.log(`  Events:  ${terminalText((body.events ?? []).join(", "))}`);
  console.log(
    `\n  ${bold("Signing secret")} (store it — Fillo signs deliveries with it, shown only now):`,
  );
  console.log(`\n    ${body.secret}\n`);
}

async function set(handle: string | undefined, id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  const includeAbandoned = boolishFlag(flags, "include-abandoned");
  if (!handle || !id || includeAbandoned === undefined) {
    die("Usage: fillo webhooks set <form> <id> --include-abandoned=true|false");
  }
  const token = requireToken();
  const res = await api(
    `/cli/forms/${encodeURIComponent(handle)}/webhooks/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      token,
      body: JSON.stringify({ includeAbandoned }),
    },
  );
  const body = (await readJson(res)) as { id?: string; events?: string[]; error?: string };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok || !body.id) die(body.error ?? `webhooks set failed (${res.status}).`);
  if (json) return emitResult(body);
  console.log(
    `  ${okMark()} Updated ${terminalText(body.id)} — events: ${terminalText((body.events ?? []).join(", "))}`,
  );
}

async function remove(handle: string | undefined, id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  // Removal must name the webhook — never guess an implicit target.
  if (!handle || !id)
    die("Usage: fillo webhooks remove <form> <id> — find the id with `fillo webhooks list`.");
  const token = requireToken();
  const res = await api(
    `/cli/forms/${encodeURIComponent(handle)}/webhooks/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      token,
    },
  );
  const body = (await readJson(res)) as { id?: string; deleted?: boolean; error?: string };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok || body.deleted !== true)
    die(body.error ?? `webhooks remove failed (${res.status}).`);
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
    webhooks set <form> <id> --include-abandoned=true|false
                                      Toggle abandoned-draft delivery
    webhooks remove <form> <id>       Delete a webhook by id

  ${dimRaw("<form> is a form id, slug, or push handle. The secret is shown only at add")}
  ${dimRaw("time — store it then. --json prints the raw server response on stdout.")}
`);
}

export const webhooksCommand: Command = {
  name: "webhooks",
  aliases: ["webhook"],
  flags: ["url", "include-abandoned"],
  run: (args, flags) => webhooks(args[0], args.slice(1), flags),
  help: webhooksHelp,
};
