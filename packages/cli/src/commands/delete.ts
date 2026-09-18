import { API, api, callApi, failed, readJson, requireToken } from "../lib/api.js";
import { promptsBlocked } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  boldRaw,
  dateOnly,
  die,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import { readLine } from "../lib/prompt.js";
import type { Command } from "../lib/registry.js";
import { fetchWorkspaceName } from "./auth.js";

/**
 * `fillo delete form|workspace` — the CLI's irreversible flows. Confirmation is
 * mandatory and typed: an interactive human is prompted for the resource's
 * exact name; an agent (--json or FILLO_AGENT=1) and any non-interactive caller
 * MUST pass --confirm "<name>". --yes never skips confirmation (it exists only
 * for muscle memory) — there is no confirmation-free delete. The server also
 * enforces the typed match, so a local check is UX only.
 *
 * Who may be prompted is NOT decided here: `promptsBlocked` comes from
 * lib/confirm.ts, the single implementation of the human layer, so a pipeline
 * with no terminal is told to pass --confirm rather than handed a prompt that
 * would read whatever is on stdin.
 */

function missingForm(handle: string): never {
  die(
    `No form matches "${terminalText(handle)}" in this workspace. Run \`fillo list\` to see its forms.`,
  );
}

async function fetchForm(handle: string, token: string): Promise<{ name: string; status: string }> {
  const body = await callApi<{ name: string; status?: string }>(
    `/cli/forms/${encodeURIComponent(handle)}`,
    { token },
    {
      fallback: `No form matches "${terminalText(handle)}".`,
      expect: (b) => Boolean(b.name),
      on: (res) => {
        if (res.status === 410) die("This form is already being deleted.");
        if (res.status === 404) missingForm(handle);
      },
    },
  );
  return { name: body.name, status: body.status ?? "" };
}

async function deleteForm(target: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!target) die('Usage: fillo delete form <form> --confirm "<exact title>"');
  const token = requireToken();
  const alsoUnpublish = flags["also-unpublish"] === true;
  const confirmFlag = flagString(flags, "confirm");

  let confirm: string;
  if (confirmFlag !== undefined) {
    // Explicitly named target + typed confirmation — the server verifies it.
    confirm = confirmFlag;
  } else if (promptsBlocked(flags)) {
    die(
      'Refusing to delete without confirmation. Re-run with --confirm "<the form\'s exact title>". ' +
        "There is no confirmation-free delete (--yes never skips it).",
    );
  } else {
    const form = await fetchForm(target, token);
    const typed = await readLine(
      `  This permanently deletes the form "${terminalText(form.name)}". Type its exact title to confirm: `,
    );
    if (typed !== form.name) {
      die(`That does not match "${terminalText(form.name)}" — nothing was deleted.`);
    }
    confirm = form.name;
  }

  const body = await callApi<{ id?: string; deleted?: boolean; code?: string }>(
    `/cli/forms/${encodeURIComponent(target)}`,
    {
      token,
      method: "DELETE",
      body: JSON.stringify({ confirm, ...(alsoUnpublish ? { alsoUnpublish: true } : {}) }),
    },
    {
      fallback: failed("delete"),
      expect: (b) => b.deleted === true,
      on: (res, b) => {
        if (res.status === 410) die(b.error ?? "This form is already being deleted.");
        if (res.status === 409 && b.code === "published") {
          die(
            "This form is published. Re-run with --also-unpublish to take it offline and delete it.",
          );
        }
        if (res.status === 409 && b.code === "confirm_mismatch") {
          die(b.error ?? "The confirm value did not match the form title — nothing was deleted.");
        }
        if (res.status === 404) missingForm(target);
      },
    },
  );

  if (json) return emitResult(body);
  console.log(`  ${okMark()} Deleted form ${terminalText(body.id ?? target)}.`);
}

async function deleteWorkspace(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();

  // --cancel calls off a not-yet-purging schedule; no confirmation needed.
  if (flags.cancel === true) {
    const body = await callApi<{ ok?: boolean }>(
      "/cli/workspace/delete-request",
      { token, method: "DELETE" },
      {
        fallback: failed("workspace delete cancel"),
        expect: (b) => b.ok === true,
        on: (res, b) => {
          if (res.status === 403) {
            die(b.error ?? "Only the workspace owner can cancel workspace deletion.");
          }
        },
      },
    );
    if (json) return emitResult(body);
    console.log(`  ${okMark()} Scheduled workspace deletion cancelled.`);
    return;
  }

  const confirmFlag = flagString(flags, "confirm");
  let confirm: string;
  if (confirmFlag !== undefined) {
    confirm = confirmFlag;
  } else if (promptsBlocked(flags)) {
    die(
      'Refusing to schedule workspace deletion without confirmation. Re-run with --confirm "<the workspace\'s exact name>". ' +
        "There is no confirmation-free delete.",
    );
  } else {
    const workspace = await fetchWorkspaceName(API);
    const typed = await readLine(
      `  This schedules the workspace "${terminalText(workspace)}" for permanent deletion. Type its exact name to confirm: `,
    );
    if (typed !== workspace) {
      die(`That does not match "${terminalText(workspace)}" — nothing was scheduled.`);
    }
    confirm = workspace;
  }

  const body = await callApi<{ scheduledPurgeAt: string }>(
    "/cli/workspace/delete-request",
    { token, method: "POST", body: JSON.stringify({ confirm }) },
    {
      fallback: failed("workspace delete"),
      expect: (b) => Boolean(b.scheduledPurgeAt),
      on: async (res, b) => {
        if (res.status === 403) {
          die(b.error ?? "Only the workspace owner can schedule workspace deletion.");
        }
        if (res.status !== 409) return;
        // The server's mismatch message doesn't name the workspace (the form
        // path does). Read the real name and compare locally: if the typed
        // value simply doesn't match it, say so and name the exact expected
        // value — consistent with the form mismatch and the interactive prompt.
        // Otherwise surface the server's reason (a storage block or an
        // already-started purge). The lookup is best-effort — a failed whoami
        // falls back to the server's message.
        const nameRes = await api("/cli/whoami", { token }).catch(() => null);
        const nameBody =
          nameRes?.ok === true ? ((await readJson(nameRes)) as { workspace?: unknown }) : null;
        const name =
          typeof nameBody?.workspace === "string" ? terminalText(nameBody.workspace) : undefined;
        if (name && confirm !== name) {
          die(
            `That does not match "${name}" — nothing was scheduled. Re-run with --confirm "${name}".`,
          );
        }
        die(b.error ?? `workspace delete failed (${res.status}).`);
      },
    },
  );

  if (json) return emitResult(body);
  console.log(
    `  ${okMark()} Workspace scheduled for deletion on ${dateOnly(body.scheduledPurgeAt)}.`,
  );
  console.log("  Cancel anytime before then with `fillo delete workspace --cancel`.");
}

async function del(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return deleteHelp();
  if (subcommand === "form") return deleteForm(args[0], flags);
  if (subcommand === "workspace") return deleteWorkspace(flags);
  die(`Unknown delete command: ${terminalText(subcommand)} (expected form or workspace).`);
}

function deleteHelp() {
  console.log(`
  ${boldRaw("fillo delete")} — irreversible deletes (typed confirmation required)

  ${boldRaw("Commands")}
    delete form <form>       Permanently delete a form and its responses/files
                       ${dimRaw('--confirm "<exact title>"   required for agents/pipes; humans are prompted')}
                       ${dimRaw("--also-unpublish            take a live form offline as part of the delete")}
    delete workspace         Schedule the whole workspace for permanent deletion
                       ${dimRaw('--confirm "<exact name>"    required for agents/pipes; humans are prompted')}
                       ${dimRaw("--cancel                    call off a not-yet-purging schedule (owner only)")}

  ${dimRaw("A human at a terminal types the resource's exact name to confirm. Agents")}
  ${dimRaw("(--json or FILLO_AGENT=1) must pass --confirm; --yes never skips it —")}
  ${dimRaw("there is no confirmation-free delete. --json prints the raw server response on stdout.")}
`);
}

export const deleteCommand: Command = {
  name: "delete",
  flags: ["confirm", "yes", "also-unpublish", "cancel"],
  run: (args, flags) => del(args[0], args.slice(1), flags),
  help: deleteHelp,
};
