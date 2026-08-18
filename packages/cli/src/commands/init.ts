import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { API, api, readJson } from "../lib/api.js";
import { readConfig, writeConfig } from "../lib/config.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  bold,
  danger,
  die,
  dim,
  emitResult,
  isInteractive,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import { confirmYes, readLine } from "../lib/prompt.js";
import type { Command } from "../lib/registry.js";

const EMAIL_REQUIRED =
  'Usage: fillo init --email you@company.com [--name "Your Name"] ' +
  "(or run `fillo login` for an existing account).";

const execFileAsync = promisify(execFile);

export interface ProvisionedWorkspace {
  pk: string;
  email: string;
  name: string;
  /** The workspace (organization) display name — the server's authoritative
   *  value when it returns one, otherwise the name the CLI asked for. */
  workspace: string;
  limits?: { responses: number; expiresAt: string };
  /** Whether a `file_upload` field could publish in this fresh preview right
   *  now (a default upload destination — the transit allowance — resolves).
   *  The unclaimed-preview equivalent of `fillo whoami`'s signal, which needs a
   *  login: surfaced here so the pre-authoring check works before claiming.
   *  Absent on older servers. */
  canPublishFileFields?: boolean;
}

/**
 * What `fillo init`/`agent bootstrap` will actually operate on, resolved BEFORE
 * any work. `existing` means a stored `fillo login` already points this machine
 * at a real, connected workspace, so nothing was provisioned; `existing: false`
 * carries the freshly provisioned preview. Callers echo the identity (and, for
 * the existing case, an opt-out) so the run is never silently attached to the
 * wrong workspace.
 */
export type WorkspaceIdentity =
  | ({ existing: false } & ProvisionedWorkspace)
  | { existing: true; workspace: string };

/**
 * Resolve an email (git-identity confirm on a TTY, `--email` for agents/pipes —
 * anonymous provisioning is deliberately rejected server-side, so email is
 * always required), then provision a capped workspace and persist its pk +
 * claim cookie. Shared by `fillo init` and the self-contained
 * `fillo agent bootstrap`. Returns the result; the caller owns the output.
 * `usageHint` is the command-specific message shown when no email can be found.
 * `apiBase` lets `agent bootstrap --api` target a different deployment.
 */
export async function provisionWorkspace(
  flags: Flags,
  usageHint: string,
  apiBase: string = API,
): Promise<ProvisionedWorkspace> {
  const json = jsonMode(flags);
  let email = flagString(flags, "email")?.trim() ?? "";
  let name = flagString(flags, "name")?.trim() ?? "";

  // A human at the terminal may default the identity from git — but only after
  // seeing and confirming EXACTLY what will be sent. Agents, pipes, and --json
  // never reach this: they must pass --email (and --name) explicitly, so the
  // values are visible in the command transcript instead of harvested silently.
  if (!email) {
    if (json || !isInteractive()) die(usageHint);
    const [gitEmail, gitName] = await Promise.all([
      gitConfig("user.email"),
      name ? Promise.resolve(undefined) : gitConfig("user.name"),
    ]);
    if (gitEmail) {
      const identity = gitName
        ? `${terminalText(gitName)} <${terminalText(gitEmail)}>`
        : `<${terminalText(gitEmail)}>`;
      if (await confirmYes(`  Use your git identity — ${identity}?`)) {
        email = gitEmail;
        if (!name && gitName) name = gitName;
      }
    }
    // Declined the git identity, or none configured — just ask. Declining meant
    // "not those values", so the prompts start clean rather than prefilled.
    if (!email) {
      for (let attempt = 0; !email; attempt++) {
        if (attempt >= 3) die(usageHint);
        const typed = await readLine("  Email for this workspace: ");
        if (!typed) die(usageHint); // EOF/blank — fail closed, never loop
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) email = typed;
        else console.log(dim(`  That doesn't look like an email address.`));
      }
      if (!name) {
        name = await readLine("  Your name (optional, Enter to skip): ");
      }
    }
  }

  // Name the new workspace after the repo/directory so it is recognizable in
  // the dashboard, unless the caller named it explicitly. The server sanitizes
  // and falls back to its owner-derived default if this is blank.
  const workspaceName = flagString(flags, "workspace-name") ?? defaultWorkspaceName();

  const res = await api(
    "/workspaces/provision",
    {
      method: "POST",
      body: JSON.stringify({
        email,
        source: "cli",
        ...(name ? { name } : {}),
        ...(workspaceName ? { workspaceName } : {}),
      }),
    },
    apiBase,
  );
  const body = (await readJson(res, apiBase)) as {
    key?: string;
    workspaceName?: string;
    limits?: { responses: number; expiresAt: string };
    canPublishFileFields?: boolean;
    error?: string;
  };
  if (!res.ok || !body.key) die(body.error ?? `Provisioning failed (${res.status}).`);
  const claimToken = claimCookieValue(res);
  const { claimUrl: _legacyWorkspaceLink, ...current } = readConfig();
  // Persist the email (so `fillo claim` can say where the claim mail goes), the
  // name (applied to the account at claim), and the claim cookie (so it can
  // attach the terminal-approval code later).
  writeConfig({
    ...current,
    pk: body.key,
    email,
    ...(name ? { name } : {}),
    ...(claimToken ? { claimToken } : {}),
  });
  // Prefer the server's authoritative stored name; fall back to what we asked
  // for, then to the same owner-derived default the server would apply.
  const workspace =
    (typeof body.workspaceName === "string" && terminalText(body.workspaceName)) ||
    workspaceName ||
    fallbackWorkspaceName(name, email);
  return {
    pk: body.key,
    email,
    name,
    workspace,
    limits: body.limits,
    ...(typeof body.canPublishFileFields === "boolean"
      ? { canPublishFileFields: body.canPublishFileFields }
      : {}),
  };
}

/**
 * Resolve which workspace the run will actually operate on, BEFORE doing work.
 * A usable stored `fillo login` for this deployment wins — the run attaches to
 * that real workspace (matching how `push` resolves credentials), so we report
 * it as EXISTING and provision nothing. Otherwise a fresh capped preview is
 * provisioned and reported as NEW.
 */
export async function resolveWorkspaceIdentity(
  flags: Flags,
  usageHint: string,
  apiBase: string = API,
): Promise<WorkspaceIdentity> {
  const existing = await existingAccountWorkspace(apiBase);
  if (existing) return { existing: true, workspace: existing };
  const ws = await provisionWorkspace(flags, usageHint, apiBase);
  return { existing: false, ...ws };
}

/**
 * The workspace name of a stored `fillo login` bound to this deployment, or
 * undefined. Non-fatal: a missing, mismatched (belongs to another deployment),
 * or rejected token simply means "not logged in here" and the caller provisions
 * a fresh preview instead. Mirrors the token/origin guard in `push`/`claim`.
 */
async function existingAccountWorkspace(apiBase: string): Promise<string | undefined> {
  const cfg = readConfig();
  if (!cfg.token || cfg.tokenApi?.replace(/\/$/, "") !== apiBase.replace(/\/$/, "")) {
    return undefined;
  }
  const res = await api("/cli/whoami", { token: cfg.token }, apiBase).catch(() => null);
  if (!res?.ok) return undefined;
  const me = (await res.json().catch(() => ({}))) as { workspace?: unknown };
  return typeof me.workspace === "string" && terminalText(me.workspace)
    ? terminalText(me.workspace)
    : undefined;
}

/**
 * The unmissable isolation guard: name the real workspace a stored login points
 * at and how to opt out. Loud clarity, never a blocker or an interactive prompt
 * — an agent run must stay non-interactive.
 */
export function printExistingWorkspaceGuard(workspace: string): void {
  console.log(
    `\n  ${danger(`Using your stored Fillo login — workspace "${terminalText(workspace)}".`)}`,
  );
  console.log(
    `  ${dim("This is a real, connected workspace, not a fresh preview: forms you push go live in it.")}`,
  );
  console.log(
    `  ${dim("Want an isolated preview instead? Run `fillo logout`, then re-run this command.")}`,
  );
}

/** Owner-derived default that mirrors the server's `workspaceNameFor`, used only
 *  when neither the server nor a flag/dir gave us a name to echo. */
function fallbackWorkspaceName(name: string, email: string): string {
  const owner = name.split(/\s+/)[0]?.trim() || email.split("@")[0]?.trim() || "New";
  return `${owner}'s workspace`;
}

/**
 * A recognizable default workspace name taken from the repo/directory the CLI
 * runs in: the nearest ancestor holding a `.git`, else the current directory.
 * Sanitized (control chars stripped, whitespace collapsed, capped at the
 * server's 80-char ceiling) and undefined when it resolves to nothing, so the
 * server falls back to its owner-derived default. Filesystem-only — never
 * spawns git, so it cannot harvest the user's git identity.
 */
function defaultWorkspaceName(): string | undefined {
  let current = resolve(process.cwd());
  let root = current;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      root = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const cleaned = terminalText(basename(root)).slice(0, 80);
  return cleaned || undefined;
}

/** Human-readable "preview: N responses for ~D days" line, or null. */
export function previewLimitLine(limits: ProvisionedWorkspace["limits"]): string | null {
  if (!limits) return null;
  const expiry = Date.parse(limits.expiresAt);
  if (!Number.isFinite(expiry)) return null;
  const days = Math.max(1, Math.round((expiry - Date.now()) / 86400000));
  return `Preview: up to ${limits.responses} responses for ~${days} days.`;
}

/**
 * Read a single `git config` value, or undefined. Silent on every failure — no
 * git, no repo, no such key, or a slow invocation — so a missing git identity
 * simply means the flag is required. Never throws.
 */
async function gitConfig(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", key], { timeout: 2000 });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The provision response binds the claim to the caller via the `fillo_claim`
 * cookie. A browser keeps it automatically; the CLI must capture it so
 * `fillo claim` can later present it to the cookie-keyed claim-email endpoints.
 */
function claimCookieValue(res: Response): string | undefined {
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const match = /^fillo_claim=([^;]+)/.exec(cookie ?? "");
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Provision a capped workspace and send its durable link by email — or, when a
 *  stored login already points here, report that workspace instead of stranding
 *  a throwaway preview beside it. */
async function init(flags: Flags) {
  const json = jsonMode(flags);
  const identity = await resolveWorkspaceIdentity(flags, EMAIL_REQUIRED);

  if (identity.existing) {
    if (json) return emitResult({ existing: true, workspace: identity.workspace });
    printExistingWorkspaceGuard(identity.workspace);
    console.log(`\n  ${bold("Next:")} fillo push form.json --handle my-form`);
    console.log(
      `  ${dim(`Pushes publish into ${terminalText(identity.workspace)} — the workspace above.`)}\n`,
    );
    return;
  }

  const ws = identity;
  if (json) {
    return emitResult({
      existing: false,
      workspace: ws.workspace,
      pk: ws.pk,
      email: ws.email,
      name: ws.name || null,
      limits: ws.limits ?? null,
    });
  }

  console.log(
    `\n  ${okMark()} New workspace ${bold(terminalText(ws.workspace))} ready. A link was sent to ${bold(terminalText(ws.email))}.`,
  );
  const preview = previewLimitLine(ws.limits);
  if (preview) console.log(`  ${dim(preview)}`);
  console.log(`\n  ${bold("Next:")} fillo push form.json --handle my-form`);
  console.log(`  ${dim("Open the emailed link whenever you want to save it to an account.")}\n`);
}

export const initCommand: Command = {
  name: "init",
  flags: ["email", "name", "workspace-name"],
  run: (_args, flags) => init(flags),
};
