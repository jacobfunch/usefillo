import { api, callApi, failed, readJson, requireToken } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import { enumFlag, type Flags } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  dateOnly,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  printTable,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo members` — the workspace's members, roles, and pending invitations
 * over the human's `fcli_` credential. Inviting reuses the dashboard's
 * anti-escalation and rate-limit guards, so a forbidden or throttled invite
 * surfaces the server's stable message.
 *
 * Two operations here reach into the human layer
 * (docs/engineering/agent-parity.md):
 *
 *   - `members role` is Tier B — it changes who can act inside the workspace.
 *     A human at a terminal runs it directly; an agent must pass a bare
 *     --confirm, and either way a one-line notice says what was agreed to.
 *   - `members remove` is Tier C — it is irreversible. Confirmation is typed:
 *     a human is prompted for the member's exact email, an agent must pass
 *     --confirm "<email>". The server re-checks the match.
 *
 * Both go through `requireConfirm` (lib/confirm.ts), the one implementation of
 * those gates.
 */

const ROLES = ["member", "admin"] as const;
const ASSIGNABLE_ROLES = ["member", "admin", "owner"] as const;

type Member = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
};
type Invitation = { id: string; email: string; role: string; expiresAt: string };

async function listMembers(flags: Flags) {
  const body = await callApi<{ members: Member[]; invitations?: Invitation[] }>(
    "/cli/members",
    {},
    { fallback: failed("members list"), expect: (b) => Array.isArray(b.members) },
  );
  if (jsonMode(flags)) return emitResult(body);

  console.log(`\n  ${bold("Members")}`);
  const memberRows = body.members.map((m) => [
    terminalText(m.email),
    terminalText(m.name ?? ""),
    terminalText(m.role),
    dateOnly(m.createdAt ?? ""),
  ]);
  printTable(["EMAIL", "NAME", "ROLE", "JOINED"], memberRows);

  const invites = body.invitations ?? [];
  console.log(`\n  ${bold("Pending invitations")}`);
  if (invites.length === 0) {
    console.log(`  ${dim("None. Invite someone with `fillo members invite you@company.com`.")}`);
  } else {
    const inviteRows = invites.map((i) => [
      terminalText(i.email),
      terminalText(i.role),
      dateOnly(i.expiresAt ?? ""),
      i.id,
    ]);
    printTable(["EMAIL", "ROLE", "EXPIRES", "ID"], inviteRows);
  }
  console.log("");
}

async function invite(email: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!email) die("Usage: fillo members invite <email> [--role member|admin]");
  const role = enumFlag(flags, "role", ROLES);
  const body = await callApi<{ invitation: Invitation & { status?: string } }>(
    "/cli/members/invites",
    { method: "POST", body: JSON.stringify({ email, ...(role ? { role } : {}) }) },
    {
      // 403 = anti-escalation (can't grant a role above your own); 429 = rate cap.
      fallback: failed("members invite"),
      expect: (b) => Boolean(b.invitation),
    },
  );
  if (json) return emitResult(body);
  const inv = body.invitation;
  console.log(
    `  ${okMark()} Invited ${terminalText(inv.email)} as ${terminalText(inv.role)} — expires ${dateOnly(inv.expiresAt)}.`,
  );
  console.log(`  ${dim(`Cancel with \`fillo members cancel-invite ${inv.id}\`.`)}`);
}

async function cancelInvite(id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  // Cancellation must name the invitation — never guess an implicit target.
  if (!id) die("Usage: fillo members cancel-invite <id> — find the id with `fillo members`.");
  const body = await callApi<{ id?: string; cancelled?: boolean }>(
    `/cli/members/invites/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    {
      fallback: failed("cancel-invite"),
      expect: (b) => b.cancelled === true,
      on: (res, b) => {
        if (res.status === 404) die(b.error ?? "Invitation not found");
      },
    },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Cancelled invitation ${terminalText(id)}.`);
}

/** The one "who?" answer, whether the lookup or the write is what missed. */
function missingMember(target: string, serverError?: string): never {
  die(
    serverError ??
      `No member matches "${terminalText(target)}" in this workspace. Run \`fillo members\` to see them.`,
  );
}

/** Look one member up so a prompt or a mismatch can name their exact email. */
async function fetchMember(target: string, token: string): Promise<Member | null> {
  const res = await api("/cli/members", { token });
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  const body = (await readJson(res)) as { members?: Member[] };
  if (!res.ok || !Array.isArray(body.members)) return null;
  const needle = target.trim().toLowerCase();
  return (
    body.members.find((m) => m.id === target.trim() || m.email.toLowerCase() === needle) ?? null
  );
}

async function removeMember(target: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!target) {
    die('Usage: fillo members remove <email|id> --confirm "<their exact email>"');
  }
  const token = requireToken();

  // A typed flag is sent verbatim — the server verifies it against the real
  // email — so only the prompt needs the address, read from the server then.
  const confirm = await requireConfirm(flags, {
    tier: "C",
    resolveTarget: async () => {
      const member = await fetchMember(target, token);
      if (!member) missingMember(target);
      return member.email;
    },
    notice: "This removes that person from the workspace and revokes their access.",
    refusal:
      'Refusing to remove a member without confirmation. Re-run with --confirm "<their exact email>". ' +
      "A bare --confirm never substitutes for the typed email.",
  });

  const body = await callApi<{ id?: string; email?: string; removed?: boolean; code?: string }>(
    `/cli/members/${encodeURIComponent(target)}`,
    { token, method: "DELETE", body: JSON.stringify({ confirm }) },
    {
      fallback: failed("members remove"),
      expect: (b) => b.removed === true,
      on: (res, b) => {
        if (res.status === 404) missingMember(target, b.error);
        if (res.status === 409 && b.code === "confirm_mismatch") {
          die(
            b.error ?? "The confirm value did not match that member's email — nothing was changed.",
          );
        }
      },
    },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Removed ${terminalText(body.email ?? target)} from the workspace.`);
}

async function setMemberRole(target: string | undefined, role: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!target || !role) {
    die(`Usage: fillo members role <email|id> <${ASSIGNABLE_ROLES.join("|")}>`);
  }
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    die(`Unknown role: ${terminalText(role)} (expected ${ASSIGNABLE_ROLES.join(", ")}).`);
  }

  // Tier B consent, printed before the write so it is visible even if the
  // server refuses.
  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    notice:
      "Changing a role changes what that person can do in this workspace — an admin or owner can publish forms, manage members, and revoke credentials.",
  });

  const body = await callApi<{ id?: string; email?: string; role: string }>(
    `/cli/members/${encodeURIComponent(target)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
    {
      // 403 = anti-escalation (can't grant, or act on, a role above your own).
      fallback: failed("members role"),
      expect: (b) => Boolean(b.role),
      on: (res, b) => {
        if (res.status === 404) missingMember(target, b.error);
      },
    },
  );
  if (json) return emitResult(body);
  console.log(
    `  ${okMark()} ${terminalText(body.email ?? target)} is now ${terminalText(body.role)}.`,
  );
}

async function members(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined) return listMembers(flags);
  if (subcommand === "help") return membersHelp();
  if (subcommand === "list" || subcommand === "ls") return listMembers(flags);
  if (subcommand === "invite") return invite(args[0], flags);
  if (subcommand === "cancel-invite" || subcommand === "cancel")
    return cancelInvite(args[0], flags);
  if (subcommand === "remove" || subcommand === "rm") return removeMember(args[0], flags);
  if (subcommand === "role") return setMemberRole(args[0], args[1], flags);
  die(
    `Unknown members command: ${terminalText(subcommand)} (expected invite, cancel-invite, remove, or role).`,
  );
}

function membersHelp() {
  console.log(`
  ${boldRaw("fillo members")} — workspace members and invitations

  ${boldRaw("Commands")}
    members                     List members and pending invitations
    members invite <email>      Invite someone to the workspace
                       ${dimRaw("--role member|admin   default member (can't exceed your own role)")}
    members cancel-invite <id>  Cancel a pending invitation by id
    members role <email|id> <member|admin|owner>
                                Change a member's role
                       ${dimRaw("--confirm             required for agents/pipes; the human agrees first")}
    members remove <email|id>   Remove a member from the workspace
                       ${dimRaw('--confirm "<their exact email>"   required for agents/pipes; humans are prompted')}

  ${dimRaw("You can never grant, or act on, a role above your own, and the workspace's")}
  ${dimRaw("last owner can't be removed or demoted. Removal is irreversible: the typed")}
  ${dimRaw("email is required and a bare --confirm never substitutes for it.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const membersCommand: Command = {
  name: "members",
  aliases: ["member"],
  flags: ["role", "confirm"],
  run: (args, flags) => members(args[0], args.slice(1), flags),
  help: membersHelp,
};
