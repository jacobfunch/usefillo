import { API, api, readJson, requireToken } from "../lib/api.js";
import { type Flags, flagString } from "../lib/flags.js";
import { boldRaw, die, dimRaw, emitResult, jsonMode, okMark, terminalText } from "../lib/output.js";
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
 */

const dateOnly = (iso: string) => iso.slice(0, 10);

/** Interactive prompting is refused for agents/JSON: they must name --confirm. */
function promptsBlocked(json: boolean): boolean {
  return json || process.env.FILLO_AGENT === "1";
}

async function fetchForm(handle: string, token: string): Promise<{ name: string; status: string }> {
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}`, { token });
  const body = (await readJson(res)) as {
    form?: { name?: string; status?: string };
    error?: string;
  };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 410) die("This form is already being deleted.");
  if (res.status === 404) {
    die(
      `No form matches "${terminalText(handle)}" in this workspace. Run \`fillo list\` to see its forms.`,
    );
  }
  if (!res.ok || !body.form?.name) die(body.error ?? `No form matches "${terminalText(handle)}".`);
  return { name: body.form.name, status: body.form.status ?? "" };
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
  } else if (promptsBlocked(json)) {
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

  const res = await api(`/cli/forms/${encodeURIComponent(target)}`, {
    method: "DELETE",
    token,
    body: JSON.stringify({ confirm, ...(alsoUnpublish ? { alsoUnpublish: true } : {}) }),
  });
  const body = (await readJson(res)) as {
    id?: string;
    deleted?: boolean;
    code?: string;
    error?: string;
  };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 410) die(body.error ?? "This form is already being deleted.");
  if (res.status === 409 && body.code === "published") {
    die("This form is published. Re-run with --also-unpublish to take it offline and delete it.");
  }
  if (res.status === 409 && body.code === "confirm_mismatch") {
    die(body.error ?? "The confirm value did not match the form title — nothing was deleted.");
  }
  if (res.status === 404) {
    die(
      `No form matches "${terminalText(target)}" in this workspace. Run \`fillo list\` to see its forms.`,
    );
  }
  if (!res.ok || body.deleted !== true) die(body.error ?? `delete failed (${res.status}).`);

  if (json) return emitResult(body);
  console.log(`  ${okMark()} Deleted form ${terminalText(body.id ?? target)}.`);
}

async function deleteWorkspace(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();

  // --cancel calls off a not-yet-purging schedule; no confirmation needed.
  if (flags.cancel === true) {
    const res = await api("/cli/workspace/delete-request", { method: "DELETE", token });
    const body = (await readJson(res)) as { ok?: boolean; error?: string };
    if (res.status === 401) die("Token invalid — run `fillo login` again.");
    if (res.status === 403) {
      die(body.error ?? "Only the workspace owner can cancel workspace deletion.");
    }
    if (!res.ok || body.ok !== true)
      die(body.error ?? `workspace delete cancel failed (${res.status}).`);
    if (json) return emitResult(body);
    console.log(`  ${okMark()} Scheduled workspace deletion cancelled.`);
    return;
  }

  const confirmFlag = flagString(flags, "confirm");
  let confirm: string;
  if (confirmFlag !== undefined) {
    confirm = confirmFlag;
  } else if (promptsBlocked(json)) {
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

  const res = await api("/cli/workspace/delete-request", {
    method: "POST",
    token,
    body: JSON.stringify({ confirm }),
  });
  const body = (await readJson(res)) as { scheduledPurgeAt?: string; error?: string };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 403) {
    die(body.error ?? "Only the workspace owner can schedule workspace deletion.");
  }
  if (res.status === 409) {
    // The server's mismatch message doesn't name the workspace (the form path
    // does). Read the real name and compare locally: if the typed value simply
    // doesn't match it, say so and name the exact expected value — consistent
    // with the form mismatch and the interactive prompt. Otherwise surface the
    // server's reason (a storage block or an already-started purge). The lookup
    // is best-effort — a failed whoami falls back to the server's message.
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
    die(body.error ?? `workspace delete failed (${res.status}).`);
  }
  if (!res.ok || !body.scheduledPurgeAt)
    die(body.error ?? `workspace delete failed (${res.status}).`);

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
