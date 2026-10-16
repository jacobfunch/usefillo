import { assertMintedSecret, callApi, failed } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
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
 * `fillo sync-tokens` — the project's stage-only deployment credentials
 * (`fsync_…`). A sync token can register and stage a code-defined schema from
 * your server or CI; it can never publish, read responses, or manage anything.
 * That is why creating one is Tier A while revoking one is Tier C.
 *
 * The plaintext is printed EXACTLY ONCE, at mint. Fillo stores only its hash,
 * so `list` shows names and usage and never token material — there is no way
 * to read a token back, from here or from the dashboard.
 */

type SyncToken = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

async function list(flags: Flags) {
  const body = await callApi<{ tokens: SyncToken[] }>(
    "/cli/sync-tokens",
    {},
    { fallback: failed("sync-tokens list"), expect: (b) => Array.isArray(b.tokens) },
  );
  if (jsonMode(flags)) return emitResult(body);
  if (body.tokens.length === 0) {
    console.log(
      "  No form sync tokens yet. Create one with `fillo sync-tokens create --name deploy`.",
    );
    return;
  }
  console.log("");
  printTable(
    ["ID", "NAME", "CREATED", "LAST USED"],
    body.tokens.map((row) => [
      terminalText(row.id),
      terminalText(row.name ?? ""),
      dateOnly(row.createdAt ?? ""),
      row.lastUsedAt ? dateOnly(row.lastUsedAt) : "never",
    ]),
  );
  console.log(
    `\n  ${dim("Fillo stores only a hash — a token's value is shown once, at create.")}\n`,
  );
}

async function create(args: string[], flags: Flags) {
  const json = jsonMode(flags);
  const name = flagString(flags, "name") ?? (args.join(" ").trim() || "Form sync");
  const body = await callApi<{ token: string; name?: string }>(
    "/cli/sync-tokens",
    { method: "POST", body: JSON.stringify({ name }) },
    {
      fallback: failed("sync-tokens create"),
      expect: (b) => Boolean(b.token),
    },
  );
  assertMintedSecret(body.token, "fsync_");

  if (json) return emitResult(body);
  console.log(`\n  ${okMark()} Created form sync token ${bold(terminalText(body.name ?? name))}`);
  console.log(`\n  ${body.token}\n`);
  console.log(`  ${bold("Store it now")} — Fillo cannot show this token again.`);
  console.log("  Set it as FILLO_SYNC_TOKEN where your app or CI stages schemas.");
  console.log("  It can stage schema changes only — never publish, read responses, or manage.\n");
}

async function revoke(id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  // No implicit target, ever: revocation must name its token.
  if (!id) {
    die(
      'Usage: fillo sync-tokens revoke <id> --confirm "<id>" — find the id with `fillo sync-tokens list`.',
    );
  }

  // Tier C: a deployment that still holds this token starts failing the moment
  // it is revoked, so the confirmation is TYPED — a bare --confirm never
  // substitutes. The server re-checks the typed value, so it travels verbatim.
  const confirm = await requireConfirm(flags, {
    tier: "C",
    resolveTarget: async () => id,
    notice: `This permanently revokes ${terminalText(id)}; any deployment still using it stops syncing.`,
    refusal:
      `Refusing to revoke a form sync token without confirmation. Re-run with --confirm "${id}". ` +
      "A bare --confirm never substitutes for the typed id.",
  });

  const body = await callApi<{ id?: string; revoked?: boolean; code?: string }>(
    `/cli/sync-tokens/${encodeURIComponent(id)}`,
    { method: "DELETE", body: JSON.stringify({ confirm }) },
    {
      fallback: failed("sync-tokens revoke"),
      expect: (b) => b.revoked === true,
      on: (res, b) => {
        if (res.status === 404) {
          die(b.error ?? "Form sync token not found in the selected project");
        }
        if (res.status === 409 && b.code === "confirm_mismatch") {
          die(b.error ?? "The confirm value did not match the token id — nothing was revoked.");
        }
      },
    },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Revoked ${terminalText(id)}. Syncs using it now fail.`);
}

async function syncTokens(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return syncTokensHelp();
  if (subcommand === "list" || subcommand === "ls") return list(flags);
  if (subcommand === "create") return create(args, flags);
  if (subcommand === "revoke") return revoke(args[0], flags);
  die(
    `Unknown sync-tokens command: ${terminalText(subcommand)} (expected list, create, or revoke).`,
  );
}

function syncTokensHelp() {
  console.log(`
  ${boldRaw("fillo sync-tokens")} — stage-only deployment credentials (fsync_)

  ${boldRaw("Commands")}
    sync-tokens list             List the project's sync tokens (never the value)
    sync-tokens create           Mint one — the value is shown once, store it
                       ${dimRaw("--name <name>   what it's for, e.g. deploy or ci (default Form sync)")}
    sync-tokens revoke <id>      Revoke one by id — deployments using it stop syncing
                       ${dimRaw('--confirm "<id>"   required; a bare --confirm never substitutes')}

  ${dimRaw("A sync token stages code-defined schema changes and nothing else: it can")}
  ${dimRaw("never publish, read responses, or manage the workspace. Set it as")}
  ${dimRaw("FILLO_SYNC_TOKEN in your app or CI. Non-expiring by design, so an")}
  ${dimRaw("unattended deploy never breaks without warning — revoke it here instead.")}
  ${dimRaw("--json prints the raw server response on stdout, token included.")}
`);
}

export const syncTokensCommand: Command = {
  name: "sync-tokens",
  aliases: ["sync-token"],
  flags: ["name", "confirm"],
  run: (args, flags) => syncTokens(args[0], args.slice(1), flags),
  help: syncTokensHelp,
};
