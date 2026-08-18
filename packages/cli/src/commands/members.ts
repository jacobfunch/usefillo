import { api, readJson, requireToken } from "../lib/api.js";
import { enumFlag, type Flags } from "../lib/flags.js";
import {
  bold,
  boldRaw,
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
 * `fillo members` — the workspace's members and pending invitations over the
 * human's `fcli_` credential. Inviting reuses the dashboard's anti-escalation
 * and rate-limit guards, so a forbidden or throttled invite surfaces the
 * server's stable message. There is deliberately no `fsk_`/agent members lane.
 */

const ROLES = ["member", "admin"] as const;
const dateOnly = (iso: string) => iso.slice(0, 10);

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
  const token = requireToken();
  const res = await api("/cli/members", { token });
  const body = (await readJson(res)) as {
    members?: Member[];
    invitations?: Invitation[];
    error?: string;
  };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok || !Array.isArray(body.members)) {
    die(body.error ?? `members list failed (${res.status}).`);
  }
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
  const token = requireToken();
  const res = await api("/cli/members/invites", {
    method: "POST",
    token,
    body: JSON.stringify({ email, ...(role ? { role } : {}) }),
  });
  const body = (await readJson(res)) as {
    invitation?: Invitation & { status?: string };
    error?: string;
  };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  // 403 = anti-escalation (can't grant a role above your own); 429 = rate cap.
  if (!res.ok || !body.invitation) die(body.error ?? `members invite failed (${res.status}).`);
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
  const token = requireToken();
  const res = await api(`/cli/members/invites/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
  const body = (await readJson(res)) as { id?: string; cancelled?: boolean; error?: string };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 404) die(body.error ?? "Invitation not found");
  if (!res.ok || body.cancelled !== true)
    die(body.error ?? `cancel-invite failed (${res.status}).`);
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Cancelled invitation ${terminalText(id)}.`);
}

async function members(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined) return listMembers(flags);
  if (subcommand === "help") return membersHelp();
  if (subcommand === "list" || subcommand === "ls") return listMembers(flags);
  if (subcommand === "invite") return invite(args[0], flags);
  if (subcommand === "cancel-invite" || subcommand === "cancel")
    return cancelInvite(args[0], flags);
  die(`Unknown members command: ${terminalText(subcommand)} (expected invite or cancel-invite).`);
}

function membersHelp() {
  console.log(`
  ${boldRaw("fillo members")} — workspace members and invitations

  ${boldRaw("Commands")}
    members                     List members and pending invitations
    members invite <email>      Invite someone to the workspace
                       ${dimRaw("--role member|admin   default member (can't exceed your own role)")}
    members cancel-invite <id>  Cancel a pending invitation by id

  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const membersCommand: Command = {
  name: "members",
  aliases: ["member"],
  flags: ["role"],
  run: (args, flags) => members(args[0], args.slice(1), flags),
  help: membersHelp,
};
