import { callApi, failed } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import type { Flags } from "../lib/flags.js";
import {
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
 * `fillo mcp` — the MCP clients authorized against this project, and the kill
 * switch for one. These are the same connections Settings → Agents lists, with
 * the same ids, so a human and an agent name a connection the same way.
 *
 * Revoking is Tier C (docs/engineering/agent-parity.md): the client's bearer
 * stops working immediately and cannot be restored — the human re-authorizes
 * from scratch. Confirmation is therefore typed.
 */

type Grant = {
  id: string;
  client: string;
  scopes: string[];
  approvalPolicy: "ask" | "auto";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired?: boolean;
};

function grantState(grant: Grant): string {
  if (grant.expired) return `expired ${dateOnly(grant.expiresAt ?? "")}`;
  return grant.expiresAt ? `expires ${dateOnly(grant.expiresAt)}` : "never expires";
}

async function list(flags: Flags) {
  const body = await callApi<{ grants: Grant[] }>(
    "/cli/agents",
    {},
    { fallback: failed("mcp list"), expect: (b) => Array.isArray(b.grants) },
  );
  if (jsonMode(flags)) return emitResult(body);
  if (body.grants.length === 0) {
    console.log("  No MCP clients connected to this project yet.");
    return;
  }
  console.log("");
  printTable(
    ["ID", "CLIENT", "APPROVALS", "STATE", "LAST USED"],
    body.grants.map((grant) => [
      terminalText(grant.id),
      terminalText(grant.client ?? ""),
      grant.approvalPolicy === "ask" ? "ask each time" : "automatic",
      grantState(grant),
      grant.lastUsedAt ? dateOnly(grant.lastUsedAt) : "never",
    ]),
  );
  console.log(`\n  ${dim('Revoke one with `fillo mcp revoke <id> --confirm "<id>"`.')}\n`);
}

async function revoke(id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  // No implicit target, ever: revocation must name its client.
  if (!id) {
    die('Usage: fillo mcp revoke <id> --confirm "<id>" — find the id with `fillo mcp list`.');
  }

  // Tier C. The server re-checks the typed value, so it travels verbatim.
  const confirm = await requireConfirm(flags, {
    tier: "C",
    resolveTarget: async () => id,
    notice: `This disconnects ${terminalText(id)} immediately; the human has to authorize it again.`,
    refusal:
      `Refusing to revoke an MCP client without confirmation. Re-run with --confirm "${id}". ` +
      "A bare --confirm never substitutes for the typed id.",
  });

  const body = await callApi<{
    id?: string;
    revoked?: boolean;
    alreadyRevoked?: boolean;
    code?: string;
  }>(
    `/cli/agents/${encodeURIComponent(id)}`,
    { method: "DELETE", body: JSON.stringify({ confirm }) },
    {
      fallback: failed("mcp revoke"),
      expect: (b) => b.revoked === true,
      on: (res, b) => {
        if (res.status === 404) die(b.error ?? "MCP client not found in this project");
        if (res.status === 409 && b.code === "confirm_mismatch") {
          die(b.error ?? "The confirm value did not match the client id — nothing was revoked.");
        }
      },
    },
  );
  if (json) return emitResult(body);
  if (body.alreadyRevoked === true) {
    console.log(`  ${okMark()} ${terminalText(id)} was already revoked — nothing to do.`);
    return;
  }
  console.log(`  ${okMark()} Revoked ${terminalText(id)}. That client is disconnected.`);
}

async function mcp(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return mcpHelp();
  if (subcommand === "list" || subcommand === "ls") return list(flags);
  if (subcommand === "revoke") return revoke(args[0], flags);
  die(`Unknown mcp command: ${terminalText(subcommand)} (expected list or revoke).`);
}

function mcpHelp() {
  console.log(`
  ${boldRaw("fillo mcp")} — MCP clients authorized against this project

  ${boldRaw("Commands")}
    mcp list             List connected clients, their access, and last use
    mcp revoke <id>      Disconnect one client — its access ends immediately
                       ${dimRaw('--confirm "<id>"   required; a bare --confirm never substitutes')}

  ${dimRaw("These are the connections Settings → Agents shows, with the same ids.")}
  ${dimRaw("Revoking cannot be undone: the human authorizes the client again from")}
  ${dimRaw("their agent. Listing never returns key material.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const mcpCommand: Command = {
  name: "mcp",
  aliases: ["agents"],
  flags: ["confirm"],
  run: (args, flags) => mcp(args[0], args.slice(1), flags),
  help: mcpHelp,
};
