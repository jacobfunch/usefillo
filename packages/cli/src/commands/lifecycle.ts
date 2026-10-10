import { callApi, failed, requireToken } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  bold,
  dateOnly,
  die,
  dim,
  emitResult,
  jsonMode,
  okMark,
  printTable,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo unpublish` / `discard` / `duplicate` / `rename` / `versions` — the
 * form-lifecycle commands, each one call to its `/api/v1/cli/forms/<form>/…`
 * twin of the dashboard control. `<form>` is a form id, slug, or push handle
 * everywhere, and every command honors `--json`.
 *
 * Only `unpublish` reaches beyond the workspace (the live link stops accepting
 * responses), so it goes through the Tier B gate in lib/confirm.ts: it prints
 * what will happen and, in agent mode, refuses without a bare `--confirm`. The
 * human's yes belongs upstream of the command — there is no prompt, because an
 * agent runs non-interactively.
 */

/**
 * A lifecycle response IS the form — the `fcli_` and `fsk_` mounts return the
 * same bare object (docs/engineering/agent-parity.md). `--json` keeps printing
 * it under `form`, which is this CLI's own published output contract.
 */
type LifecycleForm = {
  id: string;
  name: string;
  slug: string;
  status: "draft" | "published";
  staged?: boolean;
  changed?: boolean;
  url?: string;
  source?: string;
};

type FormBody = LifecycleForm & { error?: string };

function missingFormMessage(handle: string): string {
  return `No form matches "${terminalText(handle)}" in this workspace. Run \`fillo list\` to see its forms.`;
}

function missingForm(handle: string): never {
  die(missingFormMessage(handle));
}

async function fetchForm(handle: string, token: string) {
  const body = await callApi<FormBody>(
    `/cli/forms/${encodeURIComponent(handle)}`,
    { token },
    {
      fallback: missingFormMessage(handle),
      on: (res, b) => {
        if (res.status === 410) die("This form is being deleted.");
        if (res.status === 404 || !b.id) missingForm(handle);
      },
    },
  );
  return body;
}

/* ---------- unpublish ---------- */

async function unpublish(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) die("Usage: fillo unpublish <form> [--confirm]");
  const token = requireToken();
  const current = await fetchForm(handle, token);

  // Nothing to take offline: report the state the caller asked for and stop.
  // No consent is needed for an action that changes nothing.
  if (current.status !== "published") {
    if (json) return emitResult({ form: { ...current, changed: false } });
    console.log(`  ${okMark()} ${bold(terminalText(current.name))} is already offline.`);
    return;
  }

  // The notice prints before the gate decides, so a refusal still says what
  // was at stake — the refusal itself stays short.
  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    noticeFirst: true,
    command: "fillo unpublish <form>",
    notice: `Unpublishing takes ${terminalText(current.name)} offline${
      current.url ? ` at ${terminalText(current.url)}` : ""
    } — the link stops accepting responses. Recorded responses and files are kept, and you can publish it again with \`fillo publish\`.`,
    refusal:
      "Refusing to unpublish without confirmation. Ask the person you are working for, then re-run with a bare --confirm.",
  });

  const body = await callApi<FormBody>(
    `/cli/forms/${encodeURIComponent(handle)}/unpublish`,
    { token, method: "POST", body: JSON.stringify({}) },
    {
      fallback: failed("unpublish"),
      expect: (b) => Boolean(b.id),
      on: (res, b) => {
        if (res.status === 410) die(b.error ?? "This form is being deleted.");
        if (res.status === 404) missingForm(handle);
      },
    },
  );

  if (json) return emitResult({ form: body });
  const form = body as LifecycleForm;
  console.log(
    `\n  ${okMark()} ${bold(terminalText(form.name))} is offline  ${dim(form.id)}\n` +
      `  ${dim(`Publish it again: fillo publish ${terminalText(form.id)}`)}\n`,
  );
}

/* ---------- discard ---------- */

async function discard(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) die("Usage: fillo discard <form>");
  const body = await callApi<{ id?: string; changed: boolean }>(
    `/cli/forms/${encodeURIComponent(handle)}/discard`,
    { method: "POST", body: JSON.stringify({}) },
    {
      // The live form is untouched either way; a 409 means the form is not
      // published, so there is no staged revision to drop.
      fallback: failed("discard"),
      expect: (b) => typeof b.changed === "boolean",
      on: (res) => {
        if (res.status === 404) missingForm(handle);
      },
    },
  );

  if (json) return emitResult({ id: body.id, changed: body.changed });
  console.log(
    body.changed
      ? `  ${okMark()} Discarded the staged changes. The live form is unchanged.`
      : `  ${okMark()} Nothing staged — the live form is already the latest revision.`,
  );
}

/* ---------- duplicate ---------- */

async function duplicate(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) die("Usage: fillo duplicate <form> [--name <name>]");
  const name = flagString(flags, "name");
  const body = await callApi<FormBody>(
    `/cli/forms/${encodeURIComponent(handle)}/duplicate`,
    { method: "POST", body: JSON.stringify(name ? { name } : {}) },
    {
      fallback: failed("duplicate"),
      expect: (b) => Boolean(b.id),
      on: (res, b) => {
        if (res.status === 404) missingForm(handle);
        if (res.status === 410) die(b.error ?? "This form is being deleted.");
      },
    },
  );

  if (json) return emitResult({ form: body });
  const copy = body as LifecycleForm;
  console.log(`\n  ${okMark()} Created ${bold(terminalText(copy.name))}  ${dim(copy.id)}`);
  console.log(`  ${dim("A draft copy of the latest saved revision — nothing is live yet.")}`);
  console.log(
    `  ${bold("Publish:")} fillo publish ${terminalText(copy.id)}   ${dim("(or edit it in the Fillo dashboard)")}\n`,
  );
}

/* ---------- rename ---------- */

async function rename(handle: string | undefined, name: string, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle || !name) die('Usage: fillo rename <form> "<new name>"');
  const body = await callApi<FormBody>(
    `/cli/forms/${encodeURIComponent(handle)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
    {
      fallback: failed("rename"),
      expect: (b) => Boolean(b.id),
      on: (res, b) => {
        if (res.status === 404) missingForm(handle);
        if (res.status === 410) die(b.error ?? "This form is being deleted.");
        if (res.status === 400) die(b.error ?? "A form name must be 1–120 characters.");
      },
    },
  );

  if (json) return emitResult({ form: body });
  const form = body as LifecycleForm;
  console.log(`\n  ${okMark()} Renamed to ${bold(terminalText(form.name))}  ${dim(form.id)}`);
  console.log(
    `  ${dim(`Its link is now /f/${terminalText(form.slug)} — links to the old one keep working.`)}\n`,
  );
}

/* ---------- versions ---------- */

async function versions(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) die("Usage: fillo versions <form>");
  const body = await callApi<{
    data: Array<{ id: string; version: number; schemaHash: string; createdAt: string }>;
  }>(
    `/cli/forms/${encodeURIComponent(handle)}/versions`,
    {},
    {
      fallback: failed("versions"),
      expect: (b) => Array.isArray(b.data),
      on: (res) => {
        if (res.status === 404) missingForm(handle);
      },
    },
  );
  const rows = body.data;

  if (json) return emitResult(body);
  if (rows.length === 0) {
    console.log("  No published versions yet — publish the form to record one.");
    return;
  }
  console.log("");
  printTable(
    ["VERSION", "PUBLISHED", "SCHEMA HASH"],
    rows.map((row) => [
      String(row.version),
      dateOnly(terminalText(row.createdAt)),
      terminalText(row.schemaHash).slice(0, 16),
    ]),
  );
  console.log("");
}

export const unpublishCommand: Command = {
  name: "unpublish",
  flags: ["confirm"],
  run: (args, flags) => unpublish(args[0], flags),
};

export const discardCommand: Command = {
  name: "discard",
  flags: [],
  run: (args, flags) => discard(args[0], flags),
};

export const duplicateCommand: Command = {
  name: "duplicate",
  flags: ["name"],
  run: (args, flags) => duplicate(args[0], flags),
};

export const renameCommand: Command = {
  name: "rename",
  flags: [],
  run: (args, flags) => rename(args[0], args.slice(1).join(" ").trim(), flags),
};

export const versionsCommand: Command = {
  name: "versions",
  flags: [],
  run: (args, flags) => versions(args[0], flags),
};
