import { api, assertMintedSecret, callApi, failed, readJson, requireToken } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import { enumFlag, type Flags } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  danger,
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
 * `fillo tokens` — the project-bound credential a no-code connector
 * authenticates with (Zapier, n8n). Distinct from `fillo keys`: those are
 * scoped `fsk_` API keys for agents and integrations you write; this is the
 * single non-expiring `fcli_` bearer the connector apps expect, and it is
 * revocable from Settings → Connections like any other project token.
 *
 * `--tool` is an allowlist on both sides — the server names the token from it,
 * so a caller can never label a credential whatever it likes.
 */

const TOOLS = ["zapier", "n8n"] as const;

type ProjectToken = {
  id: string;
  name: string;
  current?: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

/** What a listed token is doing right now, in one column. */
function tokenState(row: ProjectToken): string {
  if (!row.expiresAt) return "never expires";
  return Date.parse(row.expiresAt) <= Date.now()
    ? `expired ${dateOnly(row.expiresAt)}`
    : `expires ${dateOnly(row.expiresAt)}`;
}

async function listTokens(flags: Flags) {
  const body = await callApi<{ tokens: ProjectToken[] }>(
    "/cli/tokens",
    {},
    { fallback: failed("tokens list"), expect: (b) => Array.isArray(b.tokens) },
  );
  if (jsonMode(flags)) return emitResult(body);
  if (body.tokens.length === 0) {
    console.log("  No project tokens yet. Mint one with `fillo tokens create-connector`.");
    return;
  }
  console.log("");
  printTable(
    ["ID", "NAME", "STATE", "LAST USED", ""],
    body.tokens.map((row) => [
      terminalText(row.id),
      terminalText(row.name ?? ""),
      tokenState(row),
      row.lastUsedAt ? `used ${dateOnly(row.lastUsedAt)}` : "never used",
      row.current ? "this login" : "",
    ]),
  );
  console.log(`\n  ${dim('Revoke one with `fillo tokens revoke <id> --confirm "<id>"`.')}\n`);
}

async function revokeToken(id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  // No implicit target, ever: revocation must name its token.
  if (!id) {
    die('Usage: fillo tokens revoke <id> --confirm "<id>" — find the id with `fillo tokens list`.');
  }
  // Tier C: revocation is irreversible and credential-destroying, so the
  // confirmation is TYPED — a bare --confirm never substitutes. The server
  // re-checks the typed value, so it travels verbatim.
  const confirm = await requireConfirm(flags, {
    tier: "C",
    resolveTarget: async () => id,
    notice: `This permanently revokes token ${terminalText(id)}; anything using it stops working immediately.`,
    refusal:
      `Refusing to revoke a token without confirmation. Re-run with --confirm "${id}". ` +
      "A bare --confirm never substitutes for the typed id.",
  });

  const body = await callApi<{ id?: string; revoked?: boolean; self?: boolean; code?: string }>(
    `/cli/tokens/${encodeURIComponent(id)}`,
    { method: "DELETE", body: JSON.stringify({ confirm }) },
    {
      fallback: failed("tokens revoke"),
      expect: (b) => b.revoked === true,
      on: (res, b) => {
        if (res.status === 404) die(b.error ?? "Token not found in the selected project");
        if (res.status === 409 && b.code === "confirm_mismatch") {
          die(b.error ?? "The confirm value did not match the token id — nothing was revoked.");
        }
      },
    },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Revoked ${terminalText(id)}. Anything using it now fails.`);
  if (body.self === true) {
    console.log(`  ${danger("That was this terminal's own login — run `fillo login` again.")}`);
  }
}

async function createConnector(flags: Flags) {
  const json = jsonMode(flags);
  const tool = enumFlag(flags, "tool", TOOLS);
  if (!tool) die(`Usage: fillo tokens create-connector --tool ${TOOLS.join("|")}`);
  const res = await api("/cli/tokens/connector", {
    method: "POST",
    token: requireToken(),
    body: JSON.stringify({ tool }),
  });
  const body = (await readJson(res)) as {
    token?: string;
    tool?: string;
    label?: string;
    error?: string;
  };
  if (res.status === 401) die(body.error ?? "Invalid or missing CLI token — run `fillo login`");
  if (!res.ok || !body.token) die(body.error ?? `tokens create-connector failed (${res.status}).`);
  assertMintedSecret(body.token, "fcli_");

  if (json) return emitResult(body);
  console.log(
    `\n  ${okMark()} Created a ${bold(terminalText(body.label ?? tool))} connector token`,
  );
  console.log(`\n  ${body.token}\n`);
  console.log(`  ${bold("Store it now")} — Fillo cannot show this token again.`);
  console.log(
    "  Treat it like a password: it can read and change this project's forms and responses.",
  );
  console.log("  Revoke it any time in Settings → Connections.\n");
}

async function tokens(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "help") return tokensHelp();
  if (subcommand === "create-connector") return createConnector(flags);
  if (subcommand === "list" || subcommand === "ls") return listTokens(flags);
  if (subcommand === "revoke") return revokeToken(args[0], flags);
  die(
    `Unknown tokens command: ${terminalText(subcommand)} (expected create-connector, list, or revoke).`,
  );
}

function tokensHelp() {
  console.log(`
  ${boldRaw("fillo tokens")} — credentials for no-code connectors

  ${boldRaw("Commands")}
    tokens create-connector --tool ${TOOLS.join("|")}
                       Mint the connector's API token — shown once, store it
    tokens list        Every project token: the CLI login, connectors, handoffs
    tokens revoke <id> Revoke one token by id — it stops working immediately
                       ${dimRaw('--confirm "<id>"   required; a bare --confirm never substitutes')}

  ${dimRaw("The token is non-expiring so a live automation doesn't break silently, and")}
  ${dimRaw("stays revocable here and in Settings → Connections. For coding agents and")}
  ${dimRaw("your own integrations use `fillo keys create` instead — those are scoped.")}
  ${dimRaw("Listing never shows token material: Fillo stores only a hash.")}
  ${dimRaw("--json prints the raw server response on stdout, token included.")}
`);
}

export const tokensCommand: Command = {
  name: "tokens",
  flags: ["tool", "confirm"],
  run: (args, flags) => tokens(args[0], args.slice(1), flags),
  help: tokensHelp,
};
