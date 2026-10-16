import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for the workspace-administration commands added in Wave 1d
 * of the agent-parity workstream: workspace/project rename, members role and
 * remove, tokens list/revoke, sync-tokens, developers policy/origins/identity,
 * mcp list/revoke, and webhooks --auth.
 *
 * What it locks, beyond "the request was made":
 *   - the human layer. Tier B (role, policy, origins, identity enable) refuses
 *     to run unattended without a bare --confirm and always prints its notice;
 *     Tier C (remove, every revoke, identity disable) refuses without the TYPED
 *     --confirm and a bare one never substitutes.
 *   - secrets appear exactly once. A minted sync token and the identity secret
 *     print at mint and never in any listing or status.
 *   - a webhook's receiver credential is NEVER an argument: it comes from
 *     FILLO_WEBHOOK_AUTH_SECRET (or a hidden prompt) and is never echoed back.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-admin-"));
const accountToken = "fcli_test_admin_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

let api = "";
let requests = [];
let state = {};

const MEMBERS = [
  {
    id: "m_owner",
    userId: "u_owner",
    email: "ada@acme.test",
    name: "Ada Owner",
    role: "owner",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "m_bo",
    userId: "u_bo",
    email: "bo@acme.test",
    name: "Bo Member",
    role: "member",
    createdAt: "2026-06-15T00:00:00.000Z",
  },
];

function resetState(overrides = {}) {
  requests = [];
  state = {
    workspaceName: "Acme Inc",
    projectName: "Main site",
    policy: "trusted_only",
    origins: ["https://app.acme.test"],
    identity: { enabled: false, protectedFormCount: 0 },
    identitySecret: "is_minted_once_abcdefghijklmnop",
    tokens: [
      {
        id: "tok_cli",
        name: "Fillo CLI",
        current: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "tok_zapier",
        name: "Zapier",
        current: false,
        createdAt: "2026-06-10T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: "2027-06-10T00:00:00.000Z",
      },
    ],
    syncTokens: [
      {
        id: "sync_1",
        name: "deploy",
        createdAt: "2026-07-01T00:00:00.000Z",
        lastUsedAt: "2026-08-02T00:00:00.000Z",
        expiresAt: null,
      },
    ],
    syncTokenSecret: "fsync_shown_once_abcdefghijklmnop",
    grants: [
      {
        id: "key_claude",
        client: "Claude Code",
        scopes: ["forms:read", "forms:write"],
        approvalPolicy: "ask",
        createdAt: "2026-07-20T00:00:00.000Z",
        lastUsedAt: "2026-08-03T00:00:00.000Z",
        expiresAt: "2026-10-18T00:00:00.000Z",
        expired: false,
      },
    ],
    ...overrides,
  };
}

/** The server half of the typed-confirmation gate, mirrored from the routes. */
function confirmMismatch(send, expected) {
  return send(409, {
    error: `Pass confirm exactly as "${expected}" to authorize this. Nothing was changed.`,
    code: "confirm_mismatch",
  });
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, api || "http://127.0.0.1");
  requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization, body });
  res.setHeader("Content-Type", "application/json");
  const send = (status, payload) => {
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  };
  if (req.headers.authorization !== `Bearer ${accountToken}`) {
    return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
  }
  const parsed = body ? JSON.parse(body) : {};
  const segs = url.pathname.split("/").filter(Boolean).slice(3); // after api/v1/cli
  const [a, b, c] = segs;

  // ---- whoami: the project slug is the typed target for `identity disable` ----
  if (a === "whoami" && req.method === "GET") {
    return send(200, {
      workspace: "Acme",
      workspaceSlug: "acme",
      project: state.projectName,
      projectSlug: "main-site-a1b2c3",
    });
  }

  // ---- workspace / project rename ----
  if (a === "workspace" && b === undefined && req.method === "PATCH") {
    state.workspaceName = parsed.name;
    return send(200, { workspace: { id: "org_acme", name: parsed.name } });
  }
  if (a === "project" && b === undefined && req.method === "PATCH") {
    if (parsed.project && parsed.project !== "docs-site") {
      return send(404, { error: "No project in this workspace matches that value" });
    }
    state.projectName = parsed.name;
    return send(200, {
      project: { id: "project_main", name: parsed.name, slug: "main-site-a1b2c3" },
    });
  }

  // ---- developers: policy / origins / identity ----
  if (a === "project" && b === "code-sync" && req.method === "PATCH") {
    state.policy = parsed.policy;
    return send(200, { policy: parsed.policy });
  }
  if (a === "project" && b === "origins" && req.method === "GET") {
    return send(200, { origins: state.origins });
  }
  if (a === "project" && b === "origins" && req.method === "PUT") {
    state.origins = parsed.origins;
    return send(200, { origins: parsed.origins });
  }
  if (a === "project" && b === "identity" && req.method === "GET") {
    return send(200, state.identity);
  }
  if (a === "project" && b === "identity" && req.method === "POST") {
    const minted = !state.identity.enabled;
    state.identity = { ...state.identity, enabled: true };
    return send(200, {
      enabled: true,
      minted,
      ...(minted ? { secret: state.identitySecret } : {}),
      protectedFormCount: state.identity.protectedFormCount,
    });
  }
  if (a === "project" && b === "identity" && req.method === "DELETE") {
    if (parsed.confirm !== "main-site-a1b2c3") return confirmMismatch(send, "main-site-a1b2c3");
    if (state.identity.protectedFormCount > 0) {
      return send(409, {
        error: `Identity verification is required by ${state.identity.protectedFormCount} forms. Remove the verified-only policy, including staged changes, before disabling it.`,
      });
    }
    state.identity = { ...state.identity, enabled: false };
    return send(200, { enabled: false, disabled: true });
  }

  // ---- project tokens ----
  if (a === "tokens" && b === undefined && req.method === "GET") {
    return send(200, { tokens: state.tokens });
  }
  if (a === "tokens" && b !== undefined && req.method === "DELETE") {
    if (parsed.confirm !== b) return confirmMismatch(send, b);
    const found = state.tokens.find((token) => token.id === b);
    if (!found) return send(404, { error: "Token not found in the selected project" });
    state.tokens = state.tokens.filter((token) => token.id !== b);
    return send(200, { id: b, revoked: true, self: Boolean(found.current) });
  }

  // ---- form sync tokens ----
  if (a === "sync-tokens" && b === undefined && req.method === "GET") {
    return send(200, { tokens: state.syncTokens });
  }
  if (a === "sync-tokens" && b === undefined && req.method === "POST") {
    return send(201, { token: state.syncTokenSecret, name: parsed.name });
  }
  if (a === "sync-tokens" && b !== undefined && req.method === "DELETE") {
    if (parsed.confirm !== b) return confirmMismatch(send, b);
    return send(200, { id: b, revoked: true });
  }

  // ---- MCP grants ----
  if (a === "agents" && b === undefined && req.method === "GET") {
    return send(200, { grants: state.grants });
  }
  if (a === "agents" && b !== undefined && req.method === "DELETE") {
    if (parsed.confirm !== b) return confirmMismatch(send, b);
    if (!state.grants.some((grant) => grant.id === b)) {
      return send(404, { error: "MCP client not found in this project" });
    }
    return send(200, { id: b, revoked: true, alreadyRevoked: false });
  }

  // ---- members ----
  if (a === "members" && b === undefined && req.method === "GET") {
    return send(200, { members: MEMBERS, invitations: [] });
  }
  if (a === "members" && b !== undefined && req.method === "DELETE") {
    const target = MEMBERS.find((m) => m.id === decodeURIComponent(b) || m.email === decodeURIComponent(b));
    if (!target) return send(404, { error: "That member isn't in this workspace." });
    if (target.role === "owner") {
      return send(400, { error: "Add another owner before removing the workspace's only owner." });
    }
    if (parsed.confirm !== target.email) return confirmMismatch(send, target.email);
    return send(200, { id: target.id, email: target.email, removed: true });
  }
  if (a === "members" && b !== undefined && req.method === "PATCH") {
    const target = MEMBERS.find((m) => m.id === decodeURIComponent(b) || m.email === decodeURIComponent(b));
    if (!target) return send(404, { error: "That member isn't in this workspace." });
    return send(200, { id: target.id, email: target.email, role: parsed.role });
  }

  // ---- webhooks (the --auth lane) ----
  if (a === "forms" && c === "webhooks" && req.method === "POST") {
    return send(201, {
      id: "wh_new",
      url: parsed.url,
      events: ["response.created"],
      authentication: parsed.authentication?.type ?? "none",
      secret: "whsec_shown_once",
    });
  }
  if (a === "forms" && c === "webhooks" && req.method === "PATCH") {
    return send(200, {
      id: "wh_new",
      events: ["response.created"],
      authentication: parsed.authentication?.type ?? "none",
    });
  }

  return send(404, { error: "not found" });
});

const lastBody = () => JSON.parse(requests.at(-1).body);
const requestPaths = () => requests.map((r) => `${r.method} ${r.path}`);
const oneJsonDoc = (result) => {
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be exactly one JSON line, got:\n${result.stdout}`);
  return JSON.parse(lines[0]);
};
/** Nothing anywhere in the run may contain this string. */
const neverMentions = (result, secret, label) => {
  assert.ok(
    !`${result.stdout}\n${result.stderr}`.includes(secret),
    `${label} must never appear in output`,
  );
};

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;
  writeFileSync(configPath, JSON.stringify({ token: accountToken, tokenApi: api }), { mode: 0o600 });

  // ================= renames are Tier A: no confirmation at all =============
  resetState();
  const wsRename = await runCli(["workspace", "rename", "Acme", "Group"]);
  assert.equal(wsRename.code, 0, wsRename.stderr);
  assert.deepEqual(requestPaths(), ["PATCH /api/v1/cli/workspace"]);
  assert.deepEqual(lastBody(), { name: "Acme Group" });
  assert.match(wsRename.stdout, /Renamed the workspace to Acme Group/);

  resetState();
  const wsRenameEmpty = await runCli(["workspace", "rename"]);
  assert.notEqual(wsRenameEmpty.code, 0);
  assert.match(wsRenameEmpty.stderr, /Usage: fillo workspace rename/);

  resetState();
  const projRename = await runCli(["project", "rename", "Customer site"]);
  assert.equal(projRename.code, 0, projRename.stderr);
  assert.deepEqual(lastBody(), { name: "Customer site" });

  resetState();
  const projRenameTarget = await runCli(["project", "rename", "docs-site", "Docs"]);
  assert.equal(projRenameTarget.code, 0, projRenameTarget.stderr);
  assert.deepEqual(lastBody(), { name: "Docs", project: "docs-site" });

  resetState();
  const projRenameMissing = await runCli(["project", "rename", "ghost-site", "Docs"]);
  assert.notEqual(projRenameMissing.code, 0);
  assert.match(projRenameMissing.stderr, /No project in this workspace matches/);

  // ================= Tier B: bare --confirm plus a notice ==================
  resetState();
  const policyUnconfirmed = await runCli(["developers", "policy", "publishable_key"]);
  assert.notEqual(policyUnconfirmed.code, 0);
  assert.match(policyUnconfirmed.stderr, /Ask the human first, then re-run with --confirm/);
  assert.deepEqual(requestPaths(), [], "an unconfirmed Tier B write must not reach the server");

  resetState();
  const policyConfirmed = await runCli(["developers", "policy", "publishable_key", "--confirm"]);
  assert.equal(policyConfirmed.code, 0, policyConfirmed.stderr);
  // The notice prints before the write, so a human sees what was agreed to.
  assert.match(policyConfirmed.stdout, /any browser holding your pk_ key can stage|stage schema changes/);
  assert.deepEqual(lastBody(), { policy: "publishable_key" });

  resetState();
  const policyJson = await runCli(["developers", "policy", "trusted_only", "--confirm", "--json"]);
  assert.equal(policyJson.code, 0, policyJson.stderr);
  assert.deepEqual(oneJsonDoc(policyJson), { policy: "trusted_only" });
  // In --json the notice is a progress line on stderr, never on stdout.
  assert.match(policyJson.stderr, /"status":"notice"/);

  resetState();
  const originsList = await runCli(["developers", "origins"]);
  assert.equal(originsList.code, 0, originsList.stderr);
  assert.match(originsList.stdout, /https:\/\/app\.acme\.test/);

  resetState();
  const originsUnconfirmed = await runCli([
    "developers",
    "origins",
    "--set",
    "https://a.test,https://b.test",
  ]);
  assert.notEqual(originsUnconfirmed.code, 0);
  assert.deepEqual(requestPaths(), []);

  resetState();
  const originsSet = await runCli([
    "developers",
    "origins",
    "--set",
    "https://a.test,https://b.test",
    "--confirm",
  ]);
  assert.equal(originsSet.code, 0, originsSet.stderr);
  assert.deepEqual(lastBody(), { origins: ["https://a.test", "https://b.test"] });

  resetState();
  const originsClear = await runCli(["developers", "origins", "--clear", "--confirm"]);
  assert.equal(originsClear.code, 0, originsClear.stderr);
  assert.deepEqual(lastBody(), { origins: [] });
  assert.match(originsClear.stdout, /any origin/i);

  resetState();
  const originsBoth = await runCli([
    "developers",
    "origins",
    "--set",
    "https://a.test",
    "--clear",
    "--confirm",
  ]);
  assert.notEqual(originsBoth.code, 0);
  assert.match(originsBoth.stderr, /either --set or --clear/);

  // ================= the identity secret prints once, never again ==========
  resetState();
  const identityOff = await runCli(["developers", "identity", "status"]);
  assert.equal(identityOff.code, 0, identityOff.stderr);
  assert.match(identityOff.stdout, /Identity verification is off/);
  neverMentions(identityOff, state.identitySecret, "the identity secret");

  resetState();
  const enableUnconfirmed = await runCli(["developers", "identity", "enable"]);
  assert.notEqual(enableUnconfirmed.code, 0);
  assert.deepEqual(requestPaths(), []);

  resetState();
  const enabled = await runCli(["developers", "identity", "enable", "--confirm"]);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.match(enabled.stdout, new RegExp(state.identitySecret));
  assert.match(enabled.stdout, /Store it now/);
  assert.match(enabled.stdout, /Never ship it in client code|Keep it on your server/);

  // Status after enabling reports the state and NOT the secret.
  resetState({ identity: { enabled: true, protectedFormCount: 2 } });
  const identityOn = await runCli(["developers", "identity", "status"]);
  assert.equal(identityOn.code, 0, identityOn.stderr);
  assert.match(identityOn.stdout, /Identity verification is on/);
  assert.match(identityOn.stdout, /2 forms require verified respondents/);
  neverMentions(identityOn, state.identitySecret, "the identity secret");

  // Enabling again reports "already on" and still never echoes the secret.
  resetState({ identity: { enabled: true, protectedFormCount: 0 } });
  const reEnabled = await runCli(["developers", "identity", "enable", "--confirm"]);
  assert.equal(reEnabled.code, 0, reEnabled.stderr);
  assert.match(reEnabled.stdout, /already on/);
  neverMentions(reEnabled, state.identitySecret, "the identity secret");

  // Disable is Tier C: the project slug typed back, not a bare flag and not a
  // fixed word the command already knows.
  resetState({ identity: { enabled: true, protectedFormCount: 0 } });
  const disableBare = await runCli(["developers", "identity", "disable", "--confirm"]);
  assert.notEqual(disableBare.code, 0);
  assert.match(disableBare.stderr, /A bare --confirm never substitutes/);
  assert.deepEqual(requestPaths(), []);

  resetState({ identity: { enabled: true, protectedFormCount: 0 } });
  const disableWord = await runCli(["developers", "identity", "disable", "--confirm", "identity"]);
  assert.notEqual(disableWord.code, 0);
  assert.match(disableWord.stderr, /main-site-a1b2c3/);
  assert.ok(state.identity.enabled, "a wrong confirm must change nothing");

  resetState({ identity: { enabled: true, protectedFormCount: 0 } });
  const disabled = await runCli([
    "developers",
    "identity",
    "disable",
    "--confirm",
    "main-site-a1b2c3",
  ]);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.deepEqual(lastBody(), { confirm: "main-site-a1b2c3" });
  assert.match(disabled.stdout, /Identity verification is off/);

  resetState({ identity: { enabled: true, protectedFormCount: 3 } });
  const disableBlocked = await runCli([
    "developers",
    "identity",
    "disable",
    "--confirm",
    "main-site-a1b2c3",
  ]);
  assert.notEqual(disableBlocked.code, 0);
  assert.match(disableBlocked.stderr, /required by 3 forms/);

  // ================= project tokens: list never shows material =============
  resetState();
  const tokensList = await runCli(["tokens", "list"]);
  assert.equal(tokensList.code, 0, tokensList.stderr);
  assert.match(tokensList.stdout, /tok_cli +Fillo CLI +never expires/);
  assert.match(tokensList.stdout, /this login/);
  assert.ok(!tokensList.stdout.includes("fcli_"), "a listing must never print token material");

  resetState();
  const tokenRevokeBare = await runCli(["tokens", "revoke", "tok_zapier", "--confirm"]);
  assert.notEqual(tokenRevokeBare.code, 0);
  assert.match(tokenRevokeBare.stderr, /A bare --confirm never substitutes/);
  assert.deepEqual(requestPaths(), []);

  resetState();
  const tokenRevokeNone = await runCli(["tokens", "revoke", "tok_zapier"]);
  assert.notEqual(tokenRevokeNone.code, 0);
  assert.match(tokenRevokeNone.stderr, /--confirm "tok_zapier"/);

  resetState();
  const tokenRevokeWrong = await runCli([
    "tokens",
    "revoke",
    "tok_zapier",
    "--confirm",
    "tok_cli",
  ]);
  assert.notEqual(tokenRevokeWrong.code, 0);
  // The server names the exact value to retry with; the CLI relays it verbatim.
  assert.match(tokenRevokeWrong.stderr, /Pass confirm exactly as "tok_zapier"/);

  resetState();
  const tokenRevoked = await runCli(["tokens", "revoke", "tok_zapier", "--confirm", "tok_zapier"]);
  assert.equal(tokenRevoked.code, 0, tokenRevoked.stderr);
  assert.deepEqual(lastBody(), { confirm: "tok_zapier" });
  assert.match(tokenRevoked.stdout, /Revoked tok_zapier/);

  // Revoking this terminal's own login says so, rather than failing silently.
  resetState();
  const selfRevoked = await runCli(["tokens", "revoke", "tok_cli", "--confirm", "tok_cli"]);
  assert.equal(selfRevoked.code, 0, selfRevoked.stderr);
  assert.match(selfRevoked.stdout, /run `fillo login` again/);

  // ================= sync tokens: minted once, never listed ================
  resetState();
  const syncList = await runCli(["sync-tokens", "list"]);
  assert.equal(syncList.code, 0, syncList.stderr);
  assert.match(syncList.stdout, /sync_1 +deploy/);
  assert.ok(!syncList.stdout.includes("fsync_"), "a listing must never print token material");

  resetState();
  const syncCreate = await runCli(["sync-tokens", "create", "--name", "ci"]);
  assert.equal(syncCreate.code, 0, syncCreate.stderr);
  assert.deepEqual(lastBody(), { name: "ci" });
  assert.match(syncCreate.stdout, new RegExp(state.syncTokenSecret));
  assert.match(syncCreate.stdout, /Store it now/);
  assert.match(syncCreate.stdout, /FILLO_SYNC_TOKEN/);

  resetState({ syncTokenSecret: "not_a_fillo_token" });
  const syncBadFormat = await runCli(["sync-tokens", "create"]);
  assert.notEqual(syncBadFormat.code, 0);
  assert.match(syncBadFormat.stderr, /unexpected token format/);

  resetState();
  const syncRevokeBare = await runCli(["sync-tokens", "revoke", "sync_1", "--confirm"]);
  assert.notEqual(syncRevokeBare.code, 0);
  assert.deepEqual(requestPaths(), []);

  resetState();
  const syncRevoked = await runCli(["sync-tokens", "revoke", "sync_1", "--confirm", "sync_1"]);
  assert.equal(syncRevoked.code, 0, syncRevoked.stderr);
  assert.deepEqual(lastBody(), { confirm: "sync_1" });

  // ================= MCP grants ============================================
  resetState();
  const mcpList = await runCli(["mcp", "list"]);
  assert.equal(mcpList.code, 0, mcpList.stderr);
  assert.match(mcpList.stdout, /key_claude +Claude Code +ask each time/);

  resetState();
  const mcpRevokeBare = await runCli(["mcp", "revoke", "key_claude", "--confirm"]);
  assert.notEqual(mcpRevokeBare.code, 0);
  assert.deepEqual(requestPaths(), []);

  resetState();
  const mcpRevoked = await runCli(["mcp", "revoke", "key_claude", "--confirm", "key_claude"]);
  assert.equal(mcpRevoked.code, 0, mcpRevoked.stderr);
  assert.deepEqual(lastBody(), { confirm: "key_claude" });
  assert.match(mcpRevoked.stdout, /That client is disconnected/);

  // ================= members: Tier B role, Tier C remove ===================
  resetState();
  const roleUnconfirmed = await runCli(["members", "role", "bo@acme.test", "admin"]);
  assert.notEqual(roleUnconfirmed.code, 0);
  assert.match(roleUnconfirmed.stderr, /Ask the human first/);
  assert.deepEqual(requestPaths(), []);

  resetState();
  const roleBadValue = await runCli(["members", "role", "bo@acme.test", "superuser", "--confirm"]);
  assert.notEqual(roleBadValue.code, 0);
  assert.match(roleBadValue.stderr, /Unknown role: superuser/);

  resetState();
  const roleChanged = await runCli(["members", "role", "bo@acme.test", "admin", "--confirm"]);
  assert.equal(roleChanged.code, 0, roleChanged.stderr);
  assert.deepEqual(lastBody(), { role: "admin" });
  assert.match(roleChanged.stdout, /Changing a role changes what that person can do/);
  assert.match(roleChanged.stdout, /bo@acme\.test is now admin/);

  resetState();
  const removeBare = await runCli(["members", "remove", "bo@acme.test", "--confirm"]);
  assert.notEqual(removeBare.code, 0);
  assert.match(removeBare.stderr, /A bare --confirm never substitutes/);
  assert.deepEqual(requestPaths(), []);

  resetState();
  const removeWrong = await runCli([
    "members",
    "remove",
    "m_bo",
    "--confirm",
    "someone@acme.test",
  ]);
  assert.notEqual(removeWrong.code, 0);
  assert.match(removeWrong.stderr, /Pass confirm exactly as "bo@acme\.test"/);

  resetState();
  const removed = await runCli(["members", "remove", "m_bo", "--confirm", "bo@acme.test"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(lastBody(), { confirm: "bo@acme.test" });
  assert.match(removed.stdout, /Removed bo@acme\.test/);

  // The server's last-owner refusal surfaces intact.
  resetState();
  const removeOwner = await runCli(["members", "remove", "m_owner", "--confirm", "ada@acme.test"]);
  assert.notEqual(removeOwner.code, 0);
  assert.match(removeOwner.stderr, /Add another owner/);

  // ================= webhooks --auth: the secret is never an argument =======
  resetState();
  const authNoSecret = await runCli([
    "webhooks",
    "add",
    "f1",
    "--url",
    "https://hooks.acme.test/in",
    "--auth",
    "bearer",
  ]);
  assert.notEqual(authNoSecret.code, 0);
  assert.match(authNoSecret.stderr, /FILLO_WEBHOOK_AUTH_SECRET/);
  assert.match(authNoSecret.stderr, /never accepted as an argument/);
  assert.deepEqual(requestPaths(), [], "no webhook is created without the credential");

  resetState();
  const authFromEnv = await runCli(
    [
      "webhooks",
      "add",
      "f1",
      "--url",
      "https://hooks.acme.test/in",
      "--auth",
      "bearer",
      // Tier B: adding a webhook sends every answer to a host Fillo does not
      // control, so agent mode needs the bare flag.
      "--confirm",
    ],
    { FILLO_WEBHOOK_AUTH_SECRET: "receiver_secret_value" },
  );
  assert.equal(authFromEnv.code, 0, authFromEnv.stderr);
  assert.deepEqual(lastBody(), {
    url: "https://hooks.acme.test/in",
    authentication: { type: "bearer", secret: "receiver_secret_value" },
  });
  // The credential goes into the request and NEVER back out to the terminal.
  neverMentions(authFromEnv, "receiver_secret_value", "the receiver credential");
  assert.match(authFromEnv.stdout, /Auth: +bearer/);
  assert.match(authFromEnv.stdout, /whsec_shown_once/);

  resetState();
  const authNone = await runCli([
    "webhooks",
    "set",
    "f1",
    "wh_new",
    "--auth",
    "none",
  ]);
  assert.equal(authNone.code, 0, authNone.stderr);
  assert.deepEqual(lastBody(), { authentication: { type: "none" } });

  resetState();
  const authBadMode = await runCli([
    "webhooks",
    "add",
    "f1",
    "--url",
    "https://hooks.acme.test/in",
    "--auth",
    "basic",
  ]);
  assert.notEqual(authBadMode.code, 0);
  assert.match(authBadMode.stderr, /--auth must be one of: none, bearer, x-api-key/);

  // ================= dispatch / unknown subcommands ========================
  resetState();
  for (const [family, bad] of [
    ["workspace", "nuke"],
    ["sync-tokens", "nuke"],
    ["developers", "nuke"],
    ["mcp", "nuke"],
    ["tokens", "nuke"],
  ]) {
    const unknown = await runCli([family, bad]);
    assert.notEqual(unknown.code, 0, `${family} ${bad} should fail`);
    assert.match(unknown.stderr, new RegExp(`Unknown ${family} command: ${bad}`));
  }

  console.log("workspace/project/members/tokens/sync-tokens/developers/mcp/webhook-auth checks passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      value += chunk;
    });
    req.on("end", () => resolve(value));
    req.on("error", reject);
  });
}

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env,
        FILLO_API: api,
        CI: "true",
        HOME: home,
        USERPROFILE: home,
        FILLO_WEBHOOK_AUTH_SECRET: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
