import { api, readJson, requireToken } from "../lib/api.js";
import { enumFlag, type Flags } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  die,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
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
  // The plaintext is printed exactly once below — refuse anything that isn't a
  // Fillo CLI token rather than echo arbitrary server bytes.
  if (!/^fcli_[A-Za-z0-9._~-]{8,512}$/.test(body.token)) {
    die("Fillo returned an unexpected token format.");
  }

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

async function tokens(subcommand: string | undefined, flags: Flags) {
  if (subcommand === undefined || subcommand === "help") return tokensHelp();
  if (subcommand === "create-connector") return createConnector(flags);
  die(`Unknown tokens command: ${terminalText(subcommand)} (expected create-connector).`);
}

function tokensHelp() {
  console.log(`
  ${boldRaw("fillo tokens")} — credentials for no-code connectors

  ${boldRaw("Commands")}
    tokens create-connector --tool ${TOOLS.join("|")}
                       Mint the connector's API token — shown once, store it

  ${dimRaw("The token is non-expiring so a live automation doesn't break silently, and")}
  ${dimRaw("stays revocable in Settings → Connections. For coding agents and your own")}
  ${dimRaw("integrations use `fillo keys create` instead — those are scoped.")}
  ${dimRaw("--json prints the raw server response on stdout, token included.")}
`);
}

export const tokensCommand: Command = {
  name: "tokens",
  flags: ["tool"],
  run: (args, flags) => tokens(args[0], flags),
  help: tokensHelp,
};
