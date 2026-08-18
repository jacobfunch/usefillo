import { api, readJson, requireToken } from "../lib/api.js";
import { enumFlag, type Flags, flagString } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  danger,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * Project API keys (`fsk_…`) — what a coding agent or integration holds.
 * Minting requires the human's `fcli_` login (the server refuses `fsk_`
 * bearers), so a leaked agent key can never mint more keys.
 */

const PRESETS = ["read", "agent", "full"] as const;
const EXPIRY_CHOICES = ["30d", "90d", "never"] as const;

// Display-only mirrors of the server's preset bundles (the server is the
// authority — an unrecognized set simply falls back to listing the scopes).
const READ_PRESET: readonly string[] = ["forms:read", "responses:read", "respondents:read"];
const AGENT_PRESET: readonly string[] = [
  ...READ_PRESET,
  "forms:write",
  "forms:publish",
  "responses:export",
];
const FULL_PRESET: readonly string[] = [
  ...AGENT_PRESET,
  "storage:manage",
  "webhooks:manage",
  "integrations:manage",
  "settings:manage",
  "members:manage",
];

/** Irreversible scopes all end in `:delete` (forms/workspace/responses). */
const isDangerScope = (scope: string) => scope.endsWith(":delete");

function sameScopeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((scope, index) => scope === sorted[index]);
}

function summarizeScopes(scopes: readonly string[]): string {
  if (sameScopeSet(scopes, READ_PRESET)) return "read preset";
  if (sameScopeSet(scopes, AGENT_PRESET)) return "agent preset";
  if (sameScopeSet(scopes, FULL_PRESET)) return "full preset";
  // Danger scopes must never hide behind a "+N more" truncation.
  const ordered = [...scopes.filter(isDangerScope), ...scopes.filter((s) => !isDangerScope(s))];
  const shown = ordered.slice(0, 4);
  const rest = ordered.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` +${rest} more` : "");
}

const dateOnly = (iso: string) => iso.slice(0, 10);

type KeyRow = {
  id: string;
  name: string;
  scopes: string[];
  createdAt?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdByEmail?: string | null;
};

function keyState(row: KeyRow): string {
  if (row.revokedAt) return `revoked ${dateOnly(row.revokedAt)}`;
  if (!row.expiresAt) return "never expires";
  if (Date.parse(row.expiresAt) <= Date.now()) return `expired ${dateOnly(row.expiresAt)}`;
  return `expires ${dateOnly(row.expiresAt)}`;
}

async function createKey(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();
  const name = flagString(flags, "name");
  if (!name)
    die(
      "Usage: fillo keys create --name <name> (--preset read|agent|full | --scopes a,b,c) [--expiry 30d|90d|never]",
    );
  const preset = enumFlag(flags, "preset", PRESETS);
  const rawScopes = flagString(flags, "scopes");
  if (preset && rawScopes) die("Provide either --scopes or --preset, not both.");
  const scopes = rawScopes
    ?.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!preset && (!scopes || scopes.length === 0)) {
    die(
      "Choose the key's access: --preset read|agent|full, or --scopes with explicit scopes " +
        "(the only way to grant forms:delete, responses:delete, or workspace:delete).",
    );
  }
  const expiry = enumFlag(flags, "expiry", EXPIRY_CHOICES);

  const res = await api("/cli/keys", {
    method: "POST",
    token,
    body: JSON.stringify({
      name,
      ...(preset ? { preset } : { scopes }),
      ...(expiry ? { expiresIn: expiry } : {}),
    }),
  });
  const body = (await readJson(res)) as {
    id?: string;
    key?: string;
    name?: string;
    scopes?: string[];
    expiresAt?: string | null;
    danger?: boolean;
    error?: string;
  };
  if (res.status === 401) die(body.error ?? "Invalid or missing CLI token — run `fillo login`");
  if (!res.ok || !body.id || !body.key) die(body.error ?? `keys create failed (${res.status}).`);
  // The plaintext is printed exactly once below — refuse anything that does not
  // look like a Fillo project key rather than echo arbitrary server bytes.
  if (!/^fsk_[A-Za-z0-9._~-]{8,512}$/.test(body.key)) {
    die("Fillo returned an unexpected key format.");
  }
  const grantedScopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === "string")
    : [];

  if (json) return emitResult(body);

  console.log(`\n  ${okMark()} Created API key ${bold(terminalText(name))}  ${dim(body.id)}`);
  console.log(`\n  ${body.key}\n`);
  console.log(`  ${bold("Store it now")} — Fillo cannot show this key again.`);
  console.log(`  Scopes:  ${terminalText(grantedScopes.join(", ") || "(none reported)")}`);
  console.log(`  Expiry:  ${body.expiresAt ? dateOnly(body.expiresAt) : "never"}`);
  if (body.danger === true) {
    const dangerScopes = grantedScopes.filter(isDangerScope);
    // The most dangerous line must read as the most dangerous: bold + red, the
    // same warning color the ✗ fail mark uses — stronger than the bold "Store
    // it now" above it.
    console.log(
      `\n  ${danger(
        `Warning: this key holds irreversible scopes: ${
          dangerScopes.join(", ") || grantedScopes.join(", ")
        }.`,
      )}`,
    );
    console.log("  Anyone holding it can permanently delete data. Revoke it when the job is done.");
  }
  console.log("");
}

async function listKeys(flags: Flags) {
  const json = jsonMode(flags);
  const res = await api("/cli/keys", { token: requireToken() });
  const body = (await readJson(res)) as { keys?: KeyRow[]; error?: string };
  if (!res.ok || !Array.isArray(body.keys)) die(body.error ?? `keys list failed (${res.status}).`);
  if (json) return emitResult(body);
  if (body.keys.length === 0) {
    console.log(
      "  No API keys yet. Mint one with `fillo keys create --name agent --preset agent`.",
    );
    return;
  }
  const rows = body.keys.map((row) => [
    row.id,
    terminalText(row.name ?? ""),
    summarizeScopes(Array.isArray(row.scopes) ? row.scopes : []),
    keyState(row),
    row.lastUsedAt ? `used ${dateOnly(row.lastUsedAt)}` : "never used",
  ]);
  const header = ["ID", "NAME", "SCOPES", "STATE", "LAST USED"];
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((cells) => (cells[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ")}`;
  // Plain header — bold/dim sanitize whitespace and would break the padding.
  console.log(line(header));
  for (const cells of rows) console.log(line(cells));
}

async function revokeKey(id: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  // No implicit target, ever: revocation must name its key.
  if (!id) die("Usage: fillo keys revoke <keyId> — find the id with `fillo keys list`.");
  const res = await api(`/cli/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token: requireToken(),
  });
  const body = (await readJson(res)) as { ok?: boolean; alreadyRevoked?: boolean; error?: string };
  if (res.status === 404) die(body.error ?? "API key not found");
  if (!res.ok || body.ok !== true) die(body.error ?? `keys revoke failed (${res.status}).`);
  if (json) return emitResult(body);
  if (body.alreadyRevoked === true) {
    console.log(`  ${okMark()} ${terminalText(id)} was already revoked — nothing to do.`);
    return;
  }
  console.log(`  ${okMark()} Revoked ${terminalText(id)}. Existing requests with it now fail.`);
}

async function keys(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return keysHelp();
  if (subcommand === "create") return createKey(flags);
  if (subcommand === "list" || subcommand === "ls") return listKeys(flags);
  if (subcommand === "revoke") return revokeKey(args[0], flags);
  die(`Unknown keys command: ${terminalText(subcommand)} (expected create, list, or revoke).`);
}

function keysHelp() {
  console.log(`
  ${boldRaw("fillo keys")} — project API keys (fsk_) for coding agents and integrations

  ${boldRaw("Commands")}
    keys create --name <name>   Mint a key — the plaintext is shown once, store it
                       ${dimRaw("--preset read|agent|full   scope bundle (never includes delete scopes)")}
                       ${dimRaw("--scopes a,b,c             explicit scopes; the only way to grant")}
                       ${dimRaw("                           forms:delete, responses:delete, workspace:delete")}
                       ${dimRaw("--expiry 30d|90d|never     default 90d")}
    keys list               List the workspace's keys, including revoked/expired
    keys revoke <id>        Revoke one key by id (ids come from keys list)

  ${dimRaw("Minting requires `fillo login` — a human's terminal credential creates keys.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const keysCommand: Command = {
  name: "keys",
  flags: ["name", "scopes", "preset", "expiry"],
  run: (args, flags) => keys(args[0], args.slice(1), flags),
  help: keysHelp,
};
