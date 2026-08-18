import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for `fillo keys`, `fillo claim`, the global --json
 * convention, and agent-mode (non-TTY) behavior: built CLI + scratch HOME +
 * FILLO_API pointed at a local stub server.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-keys-claim-"));
const accountToken = "fcli_test_account_secret";
const freshToken = "fcli_test_fresh_claim_secret";
const claimToken = "claimtok_test_value";
const plaintextKey = "fsk_test_plaintext_1234567890";
const pk = "pk_test_workspace";
const initEmail = "owner@example.test";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

let api = "";
let requests = [];
// Mutable per-scenario behavior of the stub endpoints.
let state = {};

function resetState(overrides = {}) {
  requests = [];
  state = {
    deviceInterval: 0.05,
    deviceExpiresIn: 5,
    tokenMode: "grant-after-claim", // grant-after-claim | denied | pending
    claimStatusClaimedFrom: 2, // claim-status call number that starts claimed
    claimStatusServedClaimed: false,
    resendClaimOutcome: "sent",
    whoamiStatus: 200,
    keysCreate: null,
    keysList: { keys: [] },
    claimStatusCalls: 0,
    ...overrides,
  };
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, api || "http://127.0.0.1");
  requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    authorization: req.headers.authorization,
    cookie: req.headers.cookie,
    body,
  });
  res.setHeader("Content-Type", "application/json");
  const send = (status, payload) => {
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  };

  if (req.method === "POST" && url.pathname === "/api/v1/device/code") {
    return send(200, {
      device_code: "fdc_test",
      user_code: "TEST-CODE",
      verification_uri: `${api}/device`,
      verification_uri_complete: `${api}/device?code=TEST-CODE`,
      interval: state.deviceInterval,
      expires_in: state.deviceExpiresIn,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/device/token") {
    assert.deepEqual(JSON.parse(body), { device_code: "fdc_test" });
    if (state.tokenMode === "denied") return send(400, { error: "access_denied" });
    if (state.tokenMode === "grant-after-claim" && state.claimStatusServedClaimed) {
      return send(200, { access_token: freshToken, token_type: "bearer" });
    }
    return send(400, { error: "authorization_pending" });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/workspaces/claim-status") {
    assert.equal(url.searchParams.get("key"), pk);
    state.claimStatusCalls += 1;
    const claimed = state.claimStatusCalls >= state.claimStatusClaimedFrom;
    if (claimed) state.claimStatusServedClaimed = true;
    return send(200, { claimed, pendingTerminalApproval: claimed });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/workspaces/resend-claim") {
    if (req.headers.cookie !== `fillo_claim=${claimToken}`) {
      return send(200, { ok: false, outcome: "invalid" });
    }
    assert.deepEqual(JSON.parse(body), { user_code: "TEST-CODE" });
    return send(200, { ok: true, outcome: state.resendClaimOutcome });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/workspaces/resend-workspace-link") {
    return send(200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/cli/whoami") {
    if (state.whoamiStatus !== 200) return send(state.whoamiStatus, { error: "nope" });
    return send(200, { workspace: "Northstar", email: "" });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/cli/keys") {
    if (req.headers.authorization !== `Bearer ${accountToken}`) {
      return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
    }
    const parsed = JSON.parse(body);
    if (state.keysCreate) return send(state.keysCreate.status, state.keysCreate.body(parsed));
    return send(400, { error: "keysCreate stub not configured" });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/cli/keys") {
    if (req.headers.authorization !== `Bearer ${accountToken}`) {
      return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
    }
    return send(200, state.keysList);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/cli/keys/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/v1/cli/keys/".length));
    if (id === "key_missing") return send(404, { error: "API key not found" });
    return send(200, { ok: true, alreadyRevoked: id === "key_revoked" });
  }

  return send(404, { error: "not found" });
});

const noAnsi = (result) => {
  assert.ok(
    !`${result.stdout}\n${result.stderr}`.includes("\x1b["),
    "non-TTY output must carry zero ANSI",
  );
};
const requestPaths = () => requests.map((r) => `${r.method} ${r.path}`);

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;

  // ---------- keys --help (aligned columns) ----------
  // Help layout keeps its column spacing: the flag/description gap survives, and
  // the delete-scopes continuation line stays indented under the description
  // instead of collapsing to the flag column (where it read as a standalone flag).
  const keysHelp = await runCli(["keys"]);
  assert.equal(keysHelp.code, 0, keysHelp.stderr);
  assert.match(keysHelp.stdout, /--preset read\|agent\|full {2,}scope bundle/);
  assert.match(keysHelp.stdout, /--scopes a,b,c {2,}explicit scopes/);
  assert.match(keysHelp.stdout, /\n {30,}forms:delete, responses:delete, workspace:delete/);
  noAnsi(keysHelp);

  // ---------- keys create ----------
  resetState({
    keysCreate: {
      status: 201,
      body: (parsed) => ({
        id: "key_1",
        key: plaintextKey,
        name: parsed.name,
        scopes: ["forms:read", "responses:read", "respondents:read"],
        expiresAt: "2026-10-25T00:00:00.000Z",
      }),
    },
  });
  writeConfig({ token: accountToken, tokenApi: api });
  const created = await runCli([
    "keys",
    "create",
    "--name",
    "ci agent",
    "--preset",
    "read",
    "--expiry",
    "30d",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(JSON.parse(requests[0].body), {
    name: "ci agent",
    preset: "read",
    expiresIn: "30d",
  });
  assert.match(created.stdout, /Created API key/);
  assert.ok(created.stdout.includes(plaintextKey), "the plaintext key must be printed once");
  assert.match(created.stdout, /Store it now — Fillo cannot show this key again/);
  assert.match(created.stdout, /Expiry: {2}2026-10-25/);
  assert.doesNotMatch(created.stdout, /Warning/);
  noAnsi(created);

  // Danger scopes: explicit only, and the CLI must name them in a warning.
  resetState({
    keysCreate: {
      status: 201,
      body: (parsed) => ({
        id: "key_2",
        key: plaintextKey,
        name: parsed.name,
        scopes: parsed.scopes,
        expiresAt: null,
        danger: true,
      }),
    },
  });
  const dangerous = await runCli([
    "keys",
    "create",
    "--name",
    "cleanup",
    "--scopes",
    "forms:read,forms:delete,responses:delete",
    "--expiry",
    "never",
  ]);
  assert.equal(dangerous.code, 0, dangerous.stderr);
  assert.deepEqual(JSON.parse(requests[0].body), {
    name: "cleanup",
    scopes: ["forms:read", "forms:delete", "responses:delete"],
    expiresIn: "never",
  });
  assert.match(
    dangerous.stdout,
    /Warning: this key holds irreversible scopes: forms:delete, responses:delete/,
  );
  assert.match(dangerous.stdout, /Expiry: {2}never/);

  // --json: the raw server 201 body is the single stdout document.
  resetState({
    keysCreate: {
      status: 201,
      body: (parsed) => ({
        id: "key_3",
        key: plaintextKey,
        name: parsed.name,
        scopes: ["forms:read"],
        expiresAt: null,
      }),
    },
  });
  const createdJson = await runCli([
    "keys",
    "create",
    "--name",
    "robot",
    "--scopes",
    "forms:read",
    "--json",
  ]);
  assert.equal(createdJson.code, 0, createdJson.stderr);
  assert.deepEqual(JSON.parse(createdJson.stdout), {
    id: "key_3",
    key: plaintextKey,
    name: "robot",
    scopes: ["forms:read"],
    expiresAt: null,
  });
  noAnsi(createdJson);

  // Local validation failures: no request may leave the machine.
  resetState();
  const noChoice = await runCli(["keys", "create", "--name", "x"]);
  assert.notEqual(noChoice.code, 0);
  assert.match(noChoice.stderr, /--preset read\|agent\|full, or --scopes/);
  const bothChoices = await runCli([
    "keys",
    "create",
    "--name",
    "x",
    "--preset",
    "read",
    "--scopes",
    "forms:read",
  ]);
  assert.notEqual(bothChoices.code, 0);
  assert.match(bothChoices.stderr, /either --scopes or --preset, not both/);
  const badPreset = await runCli(["keys", "create", "--name", "x", "--preset", "admin"]);
  assert.notEqual(badPreset.code, 0);
  assert.match(badPreset.stderr, /--preset must be one of: read, agent, full/);
  assert.equal(requests.length, 0, "local flag validation must not call the server");

  // Server {error} surfaces on failure.
  resetState({ keysCreate: { status: 400, body: () => ({ error: "Unknown scope: forms:reed" }) } });
  const badScope = await runCli(["keys", "create", "--name", "x", "--scopes", "forms:reed"]);
  assert.notEqual(badScope.code, 0);
  assert.match(badScope.stderr, /Unknown scope: forms:reed/);

  // Minting requires the human's login.
  resetState();
  writeConfig({});
  const loggedOut = await runCli(["keys", "create", "--name", "x", "--preset", "read"]);
  assert.notEqual(loggedOut.code, 0);
  assert.match(loggedOut.stderr, /Not logged in/);
  assert.equal(requests.length, 0);
  writeConfig({ token: accountToken, tokenApi: api });

  // ---------- keys list ----------
  const listBody = {
    keys: [
      {
        id: "key_live",
        name: "agent key",
        scopes: [
          "forms:read",
          "responses:read",
          "respondents:read",
          "forms:write",
          "forms:publish",
          "responses:export",
        ],
        createdAt: "2026-07-01T00:00:00.000Z",
        lastUsedAt: "2026-07-20T10:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
        revokedAt: null,
        createdByEmail: "owner@example.test",
      },
      {
        id: "key_revoked",
        name: "old key",
        scopes: ["forms:read", "workspace:delete"],
        createdAt: "2026-05-01T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: "2026-06-01T00:00:00.000Z",
        createdByEmail: null,
      },
    ],
  };
  resetState({ keysList: listBody });
  const listed = await runCli(["keys", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /ID +NAME +SCOPES +STATE +LAST USED/);
  assert.match(
    listed.stdout,
    /key_live +agent key +agent preset +expires 2026-10-01 +used 2026-07-20/,
  );
  assert.match(
    listed.stdout,
    /key_revoked +old key +workspace:delete, forms:read +revoked 2026-06-01 +never used/,
  );
  noAnsi(listed);

  resetState({ keysList: listBody });
  const listedJson = await runCli(["keys", "list", "--json"]);
  assert.equal(listedJson.code, 0, listedJson.stderr);
  assert.deepEqual(JSON.parse(listedJson.stdout), listBody);

  resetState();
  const emptyList = await runCli(["keys", "list"]);
  assert.equal(emptyList.code, 0, emptyList.stderr);
  assert.match(emptyList.stdout, /No API keys yet/);

  // ---------- keys revoke ----------
  resetState();
  const noId = await runCli(["keys", "revoke"]);
  assert.notEqual(noId.code, 0);
  assert.match(noId.stderr, /Usage: fillo keys revoke <keyId>/);
  assert.equal(requests.length, 0, "revoke must never pick an implicit target");

  const revoked = await runCli(["keys", "revoke", "key_live"]);
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/keys/key_live"]);
  assert.match(revoked.stdout, /Revoked key_live/);

  resetState();
  const revokedAgain = await runCli(["keys", "revoke", "key_revoked"]);
  assert.equal(revokedAgain.code, 0, revokedAgain.stderr);
  assert.match(revokedAgain.stdout, /already revoked/);

  resetState();
  const revokedJson = await runCli(["keys", "revoke", "key_live", "--json"]);
  assert.equal(revokedJson.code, 0, revokedJson.stderr);
  assert.deepEqual(JSON.parse(revokedJson.stdout), { ok: true, alreadyRevoked: false });

  resetState();
  const revokeMissing = await runCli(["keys", "revoke", "key_missing"]);
  assert.notEqual(revokeMissing.code, 0);
  assert.match(revokeMissing.stderr, /API key not found/);

  // ---------- claim: guidance without a provisioned workspace ----------
  resetState();
  writeConfig({});
  const nothing = await runCli(["claim"]);
  assert.notEqual(nothing.code, 0);
  assert.match(nothing.stderr, /Nothing to claim here/);
  assert.match(nothing.stderr, /fillo init/);
  assert.match(nothing.stderr, /fillo login/);
  assert.equal(requests.length, 0);

  // ---------- claim: full happy path ----------
  resetState();
  writeConfig({ pk, email: initEmail, claimToken });
  const claimed = await runCli(["claim"], { FILLO_POLL_INTERVAL_MS: "25" });
  assert.equal(claimed.code, 0, claimed.stderr);
  // Device code first, then the claim email with the code attached.
  assert.deepEqual(requestPaths().slice(0, 2), [
    "POST /api/v1/device/code",
    "POST /api/v1/workspaces/resend-claim",
  ]);
  assert.equal(requests[1].cookie, `fillo_claim=${claimToken}`);
  assert.match(claimed.stdout, /Claim email sent to owner@example\.test/);
  assert.match(claimed.stdout, /TEST-CODE/);
  assert.match(claimed.stdout, /Open the claim link in your inbox — the page will show this code/);
  assert.match(claimed.stdout, /Approve only if it matches/);
  // The informational transition printed before the grant landed.
  const transitionAt = claimed.stdout.indexOf(
    "Workspace claimed — approve the terminal step on the same page (code TEST-CODE)",
  );
  const connectedAt = claimed.stdout.indexOf("Workspace claimed — connected to Northstar");
  assert.ok(transitionAt !== -1, "must announce the claim while approval is pending");
  assert.ok(connectedAt > transitionAt, "claimed announcement must precede the connected summary");
  assert.match(claimed.stdout, /fillo keys create --name agent --preset agent/);
  assert.match(claimed.stdout, /fillo push form\.json/);
  assert.match(claimed.stdout, /fillo publish/);
  noAnsi(claimed);
  // Config upgraded in place: token stored, pk and email kept, claim token spent.
  const upgraded = readConfig();
  assert.equal(upgraded.token, freshToken);
  assert.equal(upgraded.tokenApi, api);
  assert.equal(upgraded.pk, pk);
  assert.equal(upgraded.email, initEmail);
  assert.equal(upgraded.claimToken, undefined, "the spent claim token must leave the config");

  // ---------- claim: --json stdout purity ----------
  resetState();
  writeConfig({ pk, email: initEmail, claimToken });
  const claimedJson = await runCli(["claim", "--json"], { FILLO_POLL_INTERVAL_MS: "25" });
  assert.equal(claimedJson.code, 0, claimedJson.stderr);
  // stdout parses as exactly one JSON document.
  assert.deepEqual(JSON.parse(claimedJson.stdout), { connected: true, workspace: "Northstar" });
  const events = claimedJson.stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.status),
    ["awaiting_claim", "claimed_pending_approval", "connected"],
  );
  assert.equal(events[0].code, "TEST-CODE");
  assert.equal(events[0].email, initEmail);
  assert.match(events[0].note, /Do not retry claim in a loop/);
  noAnsi(claimedJson);

  // ---------- claim: declined from the browser ----------
  resetState({ tokenMode: "denied" });
  writeConfig({ pk, email: initEmail, claimToken });
  const declined = await runCli(["claim"], { FILLO_POLL_INTERVAL_MS: "25" });
  assert.equal(declined.code, 1);
  assert.match(
    declined.stdout,
    /Approval declined from the browser\. Run `fillo claim` again when ready\./,
  );
  const afterDecline = readConfig();
  assert.equal(afterDecline.token, undefined, "a declined claim must not store a token");
  assert.equal(afterDecline.pk, pk);

  resetState({ tokenMode: "denied" });
  const declinedJson = await runCli(["claim", "--json"], { FILLO_POLL_INTERVAL_MS: "25" });
  assert.equal(declinedJson.code, 1);
  assert.deepEqual(JSON.parse(declinedJson.stdout), { connected: false, error: "access_denied" });

  // ---------- claim: the device code expired ----------
  resetState({ tokenMode: "pending", deviceExpiresIn: 0.4, claimStatusClaimedFrom: 99 });
  writeConfig({ pk, email: initEmail, claimToken });
  const expired = await runCli(["claim"], { FILLO_POLL_INTERVAL_MS: "25" });
  assert.equal(expired.code, 1);
  assert.match(expired.stdout, /The code expired \(\d+ minutes?\)\. Run `fillo claim` again\./);

  // ---------- claim: already connected ----------
  resetState();
  writeConfig({ token: accountToken, tokenApi: api, pk, email: initEmail });
  const already = await runCli(["claim"]);
  assert.equal(already.code, 0, already.stderr);
  assert.match(already.stdout, /Already connected to Northstar/);
  assert.deepEqual(
    requestPaths(),
    ["GET /api/v1/cli/whoami"],
    "no device flow when already connected",
  );

  // ---------- claim: legacy config without the saved claim token ----------
  resetState();
  writeConfig({ pk });
  const legacyNoEmail = await runCli(["claim"]);
  assert.notEqual(legacyNoEmail.code, 0);
  assert.match(legacyNoEmail.stderr, /--email you@company\.com/);

  resetState();
  writeConfig({ pk });
  const legacy = await runCli(["claim", "--email", initEmail], { FILLO_POLL_INTERVAL_MS: "25" });
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.deepEqual(requestPaths().slice(0, 2), [
    "POST /api/v1/device/code",
    "POST /api/v1/workspaces/resend-workspace-link",
  ]);
  assert.deepEqual(JSON.parse(requests[1].body), { email: initEmail });
  // No attach possible: the human approves on the /device page instead.
  assert.match(
    legacy.stdout,
    new RegExp(`approve this terminal at ${api}/device`.replace(/[/:?.]/g, "\\$&")),
  );
  assert.match(legacy.stdout, /Workspace claimed — connected to Northstar/);

  // ---------- agent mode: login never opens a browser ----------
  resetState({ claimStatusServedClaimed: true });
  writeConfig({});
  const agentLogin = await runCli(["login"], { FILLO_AGENT: "1" });
  assert.equal(agentLogin.code, 0, agentLogin.stderr);
  assert.match(agentLogin.stdout, /TEST-CODE/);
  assert.match(agentLogin.stdout, /Ask the human to open/);
  assert.match(
    agentLogin.stdout,
    /Do not retry login in a loop; ask the human to complete the browser step/,
  );
  assert.doesNotMatch(agentLogin.stdout, /opening your browser/);
  noAnsi(agentLogin);

  // ---------- login/whoami --json ----------
  resetState({ claimStatusServedClaimed: true });
  writeConfig({});
  const loginJson = await runCli(["login", "--json"]);
  assert.equal(loginJson.code, 0, loginJson.stderr);
  assert.deepEqual(JSON.parse(loginJson.stdout), { connected: true, workspace: "Northstar" });
  const loginEvents = loginJson.stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(loginEvents[0].status, "awaiting_approval");
  assert.equal(loginEvents[0].code, "TEST-CODE");

  resetState();
  const whoamiJson = await runCli(["whoami", "--json"]);
  assert.equal(whoamiJson.code, 0, whoamiJson.stderr);
  assert.deepEqual(JSON.parse(whoamiJson.stdout), { connected: true, workspace: "Northstar" });

  // --json on a human-only command must not error.
  resetState();
  const humanOnly = await runCli(["skill", "--json"]);
  assert.equal(humanOnly.code, 0, humanOnly.stderr);

  console.log("keys, claim, --json, and agent-mode checks passed");
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

function writeConfig(config) {
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
}

function readConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
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
