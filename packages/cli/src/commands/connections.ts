import { callApi, failed } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import type { Flags } from "../lib/flags.js";
import { type ConnectionsView, fetchConnections } from "../lib/integration-client.js";
import {
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
 * `fillo connections` — the workspace's reusable provider accounts, which one
 * this project uses, and how to change or remove them.
 *
 * Accounts are owned by the workspace and selected per project, so one Slack
 * install or HubSpot account can serve several projects. Nothing here ever
 * prints a credential: the server returns display labels and usage counts only.
 *
 * `remove` is Tier C (docs/engineering/agent-parity.md): it revokes a stored
 * credential and cascades away every form destination pinned to it, so the
 * caller types the account's exact label. `--yes` never substitutes.
 */

const PROVIDERS = ["notion", "slack", "hubspot", "discord"] as const;

function assertProvider(value: string | undefined): (typeof PROVIDERS)[number] {
  if (!value || !(PROVIDERS as readonly string[]).includes(value)) {
    die(`Choose a provider: ${PROVIDERS.join(", ")}.`);
  }
  return value as (typeof PROVIDERS)[number];
}

function printConnections(body: ConnectionsView) {
  const accounts = body.accounts ?? [];
  if (accounts.length === 0) {
    console.log(
      "  No integration accounts yet. Connect one with `fillo slack connect`, " +
        "`fillo notion connect`, `fillo hubspot connect`, or `fillo discord connect`.",
    );
    return;
  }
  console.log("");
  printTable(
    ["PROVIDER", "ACCOUNT", "ID", "THIS PROJECT", "FORMS"],
    accounts.map((account) => [
      account.provider,
      terminalText(account.label),
      account.id,
      account.selected ? "selected" : "",
      String(account.formDestinationCount),
    ]),
  );
  console.log(`\n  ${dim("Switch: fillo connections use <provider> <accountId>")}`);
  const servers = body.discordServers ?? [];
  if (servers.length > 0) {
    console.log("");
    printTable(
      ["DISCORD SERVER", "GUILD ID"],
      servers.map((server) => [terminalText(server.name ?? "(name unavailable)"), server.guildId]),
    );
  }
}

async function list(flags: Flags) {
  const body = await fetchConnections();
  if (jsonMode(flags)) return emitResult(body);
  printConnections(body);
}

async function use(args: string[], flags: Flags) {
  const json = jsonMode(flags);
  const provider = assertProvider(args[0]);
  const accountId = args[1]?.trim();
  if (!accountId) die("Usage: fillo connections use <provider> <accountId>");
  const body = await callApi<ConnectionsView>(
    `/cli/integrations/connections/${provider}`,
    { method: "PUT", body: JSON.stringify({ connectionId: accountId }) },
    {
      fallback: failed("connections use"),
      on: (res) => {
        if (res.status === 404) {
          die(
            "No such integration account in this workspace. Run `fillo connections` to list them.",
          );
        }
      },
    },
  );
  if (json) return emitResult(body);
  const chosen = (body.accounts ?? []).find((account) => account.id === accountId);
  console.log(
    `  ${okMark()} This project now uses ${terminalText(chosen?.label ?? accountId)} for ${provider}.`,
  );
}

async function remove(args: string[], flags: Flags) {
  const json = jsonMode(flags);
  const provider = assertProvider(args[0]);
  const accountId = args[1]?.trim();
  if (!accountId) {
    die('Usage: fillo connections remove <provider> <accountId> --confirm "<exact account name>"');
  }
  // The server judges the typed name, so the flag travels verbatim; only a
  // human at a terminal needs the account looked up to be prompted for it.
  const confirm = await requireConfirm(flags, {
    tier: "C",
    resolveTarget: async () => {
      const view = await fetchConnections();
      const account = view.accounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        die("No such integration account in this workspace. Run `fillo connections` to list them.");
      }
      return account.label;
    },
    notice:
      "Removing this account revokes the stored credential and stops every form pinned to it.",
    refusal:
      'Refusing to remove that integration account without confirmation. Re-run with --confirm "<exact account name>": ' +
      `\`fillo connections remove ${provider} ${accountId} --confirm "<exact account name>"\`. ` +
      "There is no confirmation-free removal (--yes never skips it).",
  });

  const body = await callApi<{ removed?: boolean; provider?: string; label?: string }>(
    `/cli/integrations/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE", body: JSON.stringify({ confirm }) },
    {
      fallback: failed("connections remove"),
      expect: (b) => b.removed === true,
      on: (res, b) => {
        if (res.status === 404) {
          die(
            "No such integration account in this workspace. Run `fillo connections` to list them.",
          );
        }
        if (res.status === 409) {
          die(b.error ?? "The confirm value did not match the account name — nothing was removed.");
        }
      },
    },
  );
  if (body.provider && body.provider !== provider) {
    // The id decided which account was removed; say so rather than letting a
    // mistyped provider read as a successful removal of the one meant.
    die(
      `That account is a ${terminalText(body.provider)} account, not ${provider}. ` +
        "It has been removed — re-run `fillo connections` to see what's left.",
    );
  }
  if (json) return emitResult(body);
  console.log(
    `  ${okMark()} Removed the ${provider} account ${terminalText(body.label ?? accountId)}. ` +
      "Forms that used it have stopped sending.",
  );
}

async function connections(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === "help") return connectionsHelp();
  if (subcommand === undefined || subcommand === "list") return list(flags);
  if (subcommand === "use") return use(args, flags);
  if (subcommand === "remove") return remove(args, flags);
  die(`Unknown connections command: ${terminalText(subcommand)} (expected list, use, or remove).`);
}

function connectionsHelp() {
  console.log(`
  ${boldRaw("fillo connections")} — the workspace's integration accounts

  ${boldRaw("Commands")}
    connections                          List every account and which one this project uses
    connections use <provider> <id>      Point this project at one of them
    connections remove <provider> <id>   Remove the account from the workspace
                       ${dimRaw('--confirm "<exact account name>"   required; --yes never skips it')}

  ${dimRaw(`Providers: ${PROVIDERS.join(", ")}. Accounts belong to the workspace and are`)}
  ${dimRaw("selected per project, so one install can serve several projects.")}
  ${dimRaw("Removing an account revokes the stored credential and stops every form")}
  ${dimRaw("pinned to it — that is why it needs the typed confirmation.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const connectionsCommand: Command = {
  name: "connections",
  flags: ["confirm", "yes"],
  run: (args, flags) => connections(args[0], args.slice(1), flags),
  help: connectionsHelp,
};
