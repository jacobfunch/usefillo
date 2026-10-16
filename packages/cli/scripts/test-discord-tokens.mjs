import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for `fillo discord` and `fillo tokens`: built CLI + scratch
 * HOME + FILLO_API pointed at a stub of the /api/v1/cli/* twins.
 *
 * The two properties worth a test each, because losing either is silent:
 *
 *   - The webhook URL is NEVER an argument. A positional is ignored, the
 *     non-interactive path names the env var, and the URL never reaches stdout
 *     or stderr on any path.
 *   - Early signal and auto-join print a consent notice — on stderr as a JSON
 *     line under --json, so stdout stays exactly one document.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-discord-"));
const accountToken = "fcli_test_account_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

const WEBHOOK_URL = `https://discord.com/api/webhooks/111111111111111111/${"a".repeat(68)}`;
const GUILD = "222222222222222222";
const ROLE = "444444444444444444";

let api = "";
let requests = [];
let state = {};

function resetState(overrides = {}) {
  requests = [];
  state = {
    connection: {
      connected: true,
      webhookId: "111111111111111111",
      channelLabel: "#leads",
      guildId: GUILD,
      appConfigured: true,
      botConfigured: true,
    },
    connectionPolls: 0,
    discordConnectAt: Number.POSITIVE_INFINITY,
    webhookConnect: { status: 200, body: { webhookId: "111111111111111111", label: "#leads" } },
    destination: {
      enabled: true,
      webhookId: "111111111111111111",
      channelLabel: "#leads",
      includedFieldIds: ["email"],
      earlySignalLimit: null,
      earlySignalDelivered: 0,
      roleGrant: null,
      appConfigured: true,
      botConfigured: true,
      connected: true,
      connectionWebhookId: "111111111111111111",
      connectionLabel: "#leads",
      webhookMatches: true,
    },
    destinationStatus: 200,
    putStatus: 200,
    putError: null,
    guilds: { guilds: [{ id: GUILD, name: "Acme HQ" }], guildsUnavailable: false },
    roles: {
      guildId: GUILD,
      roles: [
        { id: ROLE, name: "Beta Tester", grantable: true },
        { id: "555555555555555555", name: "Admin", grantable: false },
      ],
    },
    rolesStatus: 200,
    rolesError: null,
    connectorToken: {
      status: 201,
      body: { token: "fcli_connector_minted_secret", tool: "n8n", label: "n8n" },
    },
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
    body,
  });
  res.setHeader("Content-Type", "application/json");
  const send = (status, payload) => {
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  };
  if (req.headers.authorization !== `Bearer ${accountToken}`) {
    return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
  }

  const segs = url.pathname.split("/").filter(Boolean).slice(3); // after api/v1/cli
  const [a, b, c] = segs;

  if (a === "whoami" && req.method === "GET") {
    return send(200, { workspace: "Acme", workspaceId: "org_acme", projectId: "project_main" });
  }
  if (a === "discord" && b === undefined && req.method === "GET") {
    state.connectionPolls += 1;
    const snapshot = { ...state.connection };
    if (state.connectionPolls < state.discordConnectAt) {
      // Before the human finishes the browser step there is no webhook yet.
      if (state.discordConnectAt !== Number.POSITIVE_INFINITY) {
        snapshot.connected = false;
        snapshot.webhookId = null;
        snapshot.channelLabel = null;
      }
    }
    return send(200, snapshot);
  }
  if (a === "discord" && b === "webhook" && req.method === "POST") {
    return send(state.webhookConnect.status, state.webhookConnect.body);
  }
  if (a === "discord" && b === "roles" && req.method === "GET") {
    if (state.rolesStatus !== 200) return send(state.rolesStatus, state.rolesError);
    return send(200, url.searchParams.get("guildId") ? state.roles : state.guilds);
  }
  if (a === "forms" && c === "discord" && req.method === "GET") {
    if (state.destinationStatus !== 200)
      return send(state.destinationStatus, { error: "Form not found" });
    return send(200, state.destination);
  }
  if (a === "forms" && c === "discord" && req.method === "PUT") {
    if (state.putStatus !== 200) return send(state.putStatus, state.putError);
    const patch = JSON.parse(body);
    return send(200, {
      ...state.destination,
      ...(patch.enabled === false ? { enabled: false } : {}),
      ...(patch.includeFieldIds ? { includedFieldIds: patch.includeFieldIds } : {}),
      ...(patch.earlySignalLimit !== undefined ? { earlySignalLimit: patch.earlySignalLimit } : {}),
      ...(patch.roleGrant !== undefined ? { roleGrant: patch.roleGrant } : {}),
    });
  }
  if (a === "tokens" && b === "connector" && req.method === "POST") {
    const parsed = JSON.parse(body);
    if (parsed.tool !== "zapier" && parsed.tool !== "n8n") {
      return send(400, { error: "Unsupported connector — choose one of: zapier, n8n" });
    }
    return send(state.connectorToken.status, {
      ...state.connectorToken.body,
      tool: parsed.tool,
      label: parsed.tool === "zapier" ? "Zapier" : "n8n",
    });
  }

  return send(404, { error: "not found" });
});

const requestPaths = () => requests.map((r) => `${r.method} ${r.path}`);
const lastBody = () => JSON.parse(requests.at(-1).body);
const oneJsonDoc = (result) => {
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be exactly one JSON line, got:\n${result.stdout}`);
  return JSON.parse(lines[0]);
};
/** The webhook URL (and its token half) must not survive into any output. */
const noWebhookUrl = (result) => {
  const all = `${result.stdout}\n${result.stderr}`;
  assert.ok(!all.includes(WEBHOOK_URL), "the webhook URL must never be printed");
  assert.ok(!all.includes("a".repeat(68)), "the webhook token must never be printed");
};

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;
  writeFileSync(configPath, JSON.stringify({ token: accountToken, tokenApi: api }), {
    mode: 0o600,
  });

  // ================= dispatch =================
  resetState();
  const help = await runCli(["discord"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /fillo discord/);
  assert.match(help.stdout, /discord enable <form>/);
  assert.equal(requests.length, 0, "help must not call the API");

  resetState();
  for (const [family, bad] of [
    ["discord", "nuke"],
    ["tokens", "nuke"],
  ]) {
    const unknown = await runCli([family, bad]);
    assert.notEqual(unknown.code, 0, `${family} ${bad} should fail`);
    assert.match(unknown.stderr, new RegExp(`Unknown ${family} command: ${bad}`));
  }

  // ================= discord connect =================
  // A deploy with no Discord app must not print an OAuth URL that would 501.
  resetState();
  state.connection.appConfigured = false;
  const noApp = await runCli(["discord", "connect"]);
  assert.notEqual(noApp.code, 0);
  assert.match(noApp.stderr, /no Discord app/);
  assert.match(noApp.stderr, /fillo discord webhook/);
  assert.ok(!noApp.stdout.includes("integrations/discord/start"), "no OAuth URL without an app");

  resetState({ discordConnectAt: 3 });
  const connect = await runCli(["discord", "connect"], { FILLO_POLL_INTERVAL_MS: "10" });
  assert.equal(connect.code, 0, connect.stderr);
  assert.match(
    connect.stdout,
    /api\/integrations\/discord\/start\?return=terminal&project=project_main/,
  );
  assert.match(connect.stdout, /Open in your signed-in browser/);
  assert.match(connect.stdout, /Discord connected \(#leads\)/);
  const polls = requests.filter((r) => r.path === "/api/v1/cli/discord").length;
  assert.ok(polls >= 3, `connect must poll until connected (saw ${polls})`);

  resetState({ discordConnectAt: 2 });
  const connectJson = await runCli(["discord", "connect", "--json"], {
    FILLO_POLL_INTERVAL_MS: "10",
  });
  assert.equal(connectJson.code, 0, connectJson.stderr);
  assert.deepEqual(oneJsonDoc(connectJson), {
    connected: true,
    webhookId: "111111111111111111",
    channelLabel: "#leads",
  });

  // ================= discord webhook (the URL is never an argument) ==========
  resetState();
  const argvUrl = await runCli(["discord", "webhook", WEBHOOK_URL]);
  assert.notEqual(argvUrl.code, 0, "a URL passed as an argument must not connect anything");
  assert.match(argvUrl.stderr, /FILLO_DISCORD_WEBHOOK_URL/);
  assert.match(argvUrl.stderr, /never accepted as an argument/);
  assert.equal(requests.length, 0, "nothing is sent when the URL came from argv");

  resetState();
  const noUrl = await runCli(["discord", "webhook"]);
  assert.notEqual(noUrl.code, 0);
  assert.match(noUrl.stderr, /FILLO_DISCORD_WEBHOOK_URL/);

  // The interactive lane asks for it with a hidden prompt; with no real TTY to
  // read from, it says so instead of silently connecting nothing.
  resetState();
  const promptNoTty = await runCli(["discord", "webhook"], { FILLO_TTY: "1" }, "");
  assert.notEqual(promptNoTty.code, 0);
  assert.match(promptNoTty.stderr, /No webhook URL entered|FILLO_DISCORD_WEBHOOK_URL/);
  assert.equal(requests.length, 0);

  resetState();
  const envUrl = await runCli(["discord", "webhook", "--label", "#leads"], {
    FILLO_DISCORD_WEBHOOK_URL: WEBHOOK_URL,
  });
  assert.equal(envUrl.code, 0, envUrl.stderr);
  assert.deepEqual(requestPaths(), ["POST /api/v1/cli/discord/webhook"]);
  assert.deepEqual(lastBody(), { url: WEBHOOK_URL, label: "#leads" });
  assert.match(envUrl.stdout, /Connected Discord \(#leads\)/);
  noWebhookUrl(envUrl);

  // A server rejection must not echo the URL back either.
  resetState({
    webhookConnect: {
      status: 409,
      body: { error: "That doesn't look like a Discord webhook URL. Copy it from the channel." },
    },
  });
  const badUrl = await runCli(["discord", "webhook"], {
    FILLO_DISCORD_WEBHOOK_URL: "https://evil.test/api/webhooks/1/2",
  });
  assert.notEqual(badUrl.code, 0);
  assert.match(badUrl.stderr, /doesn't look like a Discord webhook URL/);
  noWebhookUrl(badUrl);

  // ================= discord status =================
  resetState();
  const noForm = await runCli(["discord", "status"]);
  assert.notEqual(noForm.code, 0);
  assert.match(noForm.stderr, /Usage: fillo discord status <form>/);
  assert.equal(requests.length, 0);

  resetState();
  state.destination.earlySignalLimit = 10;
  state.destination.earlySignalDelivered = 4;
  state.destination.roleGrant = { guildId: GUILD, roleId: ROLE, autoJoin: true };
  const status = await runCli(["discord", "status", "f1"]);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/f1/discord"]);
  assert.match(status.stdout, /Sending to Discord — #leads/);
  assert.match(status.stdout, /Fields: +email/);
  assert.match(status.stdout, /Early signal: +first 10 responses in full \(4 sent\)/);
  assert.match(status.stdout, new RegExp(`Role grant: +${ROLE} in ${GUILD} \\(auto-join\\)`));

  resetState();
  state.destination.webhookMatches = false;
  const mismatch = await runCli(["discord", "status", "f1"]);
  assert.equal(mismatch.code, 0, mismatch.stderr);
  // A form on its own channel is a normal state now — an informational line,
  // never an alarm about a failing destination.
  assert.match(mismatch.stdout, /posts to its own channel/);
  assert.match(mismatch.stdout, /--channel <channelId>/);

  resetState();
  const statusJson = await runCli(["discord", "status", "f1", "--json"]);
  assert.deepEqual(oneJsonDoc(statusJson), state.destination);

  resetState({ destinationStatus: 404 });
  const missingForm = await runCli(["discord", "status", "ghost"]);
  assert.notEqual(missingForm.code, 0);
  assert.match(missingForm.stderr, /Form not found/);

  // ================= discord enable =================
  // Already live on the project's webhook: the destination is left alone so the
  // early-signal consent given for THIS channel survives a field change.
  resetState();
  const fieldsOnly = await runCli(["discord", "enable", "f1", "--fields", "email,message"]);
  assert.equal(fieldsOnly.code, 0, fieldsOnly.stderr);
  assert.deepEqual(requestPaths(), [
    "GET /api/v1/cli/forms/f1/discord",
    "PUT /api/v1/cli/forms/f1/discord",
  ]);
  assert.deepEqual(lastBody(), { includeFieldIds: ["email", "message"] });

  // Not sending yet: enabling names the webhook it just read, so a project
  // re-pointed in the meantime fails loud instead of silently redirecting.
  resetState();
  state.destination.enabled = false;
  const firstEnable = await runCli(["discord", "enable", "f1"]);
  assert.equal(firstEnable.code, 0, firstEnable.stderr);
  assert.deepEqual(lastBody(), { enabled: true, webhookId: "111111111111111111" });

  // Live on its own channel while the project default moved: `enable` without
  // --channel must NOT silently re-point the form (that also cleared the
  // early-signal window). Re-pointing is an explicit --channel decision.
  resetState();
  state.destination.webhookMatches = false;
  const reEnable = await runCli(["discord", "enable", "f1"]);
  assert.equal(reEnable.code, 0, reEnable.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/f1/discord"], "no silent re-point");

  // --channel deliberately re-points an already-live form at another
  // connected channel.
  resetState();
  const repoint = await runCli(["discord", "enable", "f1", "--channel", "222222222222222222"]);
  assert.equal(repoint.code, 0, repoint.stderr);
  assert.deepEqual(lastBody(), { enabled: true, channelId: "222222222222222222" });

  resetState();
  const badChannel = await runCli(["discord", "enable", "f1", "--channel", "not-a-snowflake"]);
  assert.notEqual(badChannel.code, 0);
  assert.match(badChannel.stderr, /--channel must be a Discord channel id/);

  // Already on, nothing passed: `enable` is idempotent — it reports the state
  // it was asked for and succeeds, instead of reading as a failure to an agent.
  resetState();
  const alreadyOn = await runCli(["discord", "enable", "f1"]);
  assert.equal(alreadyOn.code, 0, alreadyOn.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/f1/discord"], "no needless write");
  assert.match(alreadyOn.stdout, /Sending to Discord — #leads/);

  resetState();
  state.destination.connected = false;
  state.destination.connectionWebhookId = null;
  const notConnected = await runCli(["discord", "enable", "f1"]);
  assert.notEqual(notConnected.code, 0);
  assert.match(notConnected.stderr, /Discord isn't connected to this project/);

  resetState();
  const clearFields = await runCli(["discord", "enable", "f1", "--fields", "none"]);
  assert.equal(clearFields.code, 0, clearFields.stderr);
  assert.deepEqual(lastBody(), { includeFieldIds: [] });

  // ---- consent: early signal ----
  resetState();
  const early = await runCli(["discord", "enable", "f1", "--early-signal", "10"]);
  assert.equal(early.code, 0, early.stderr);
  assert.deepEqual(lastBody(), { earlySignalLimit: 10 });
  assert.match(
    early.stdout,
    /Early signal sends every answer to this channel for the first 10 responses\./,
  );

  resetState();
  const earlyJson = await runCli(["discord", "enable", "f1", "--early-signal", "5", "--json"]);
  assert.equal(earlyJson.code, 0, earlyJson.stderr);
  const earlyDoc = oneJsonDoc(earlyJson);
  assert.equal(earlyDoc.earlySignalLimit, 5);
  const earlyEvents = earlyJson.stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(
    earlyEvents.some((e) => e.status === "notice" && /first 5 responses/.test(e.notice)),
    "the consent notice must still be emitted under --json (on stderr)",
  );

  resetState();
  const earlyOff = await runCli(["discord", "enable", "f1", "--early-signal", "off"]);
  assert.equal(earlyOff.code, 0, earlyOff.stderr);
  assert.deepEqual(lastBody(), { earlySignalLimit: null });
  assert.ok(!earlyOff.stdout.includes("every answer"), "turning it off is not a consent moment");

  resetState();
  const earlyBad = await runCli(["discord", "enable", "f1", "--early-signal", "7"]);
  assert.notEqual(earlyBad.code, 0);
  assert.match(earlyBad.stderr, /--early-signal must be one of: 5, 10, 25, off/);

  // ---- consent: role grant and auto-join ----
  resetState();
  const role = await runCli(["discord", "enable", "f1", "--role", `${GUILD}/${ROLE}`]);
  assert.equal(role.code, 0, role.stderr);
  assert.deepEqual(lastBody(), { roleGrant: { guildId: GUILD, roleId: ROLE } });
  assert.match(role.stdout, /Respondents who verify with Discord get that role/);

  resetState();
  const autoJoin = await runCli([
    "discord",
    "enable",
    "f1",
    "--role",
    `${GUILD}/${ROLE}`,
    "--auto-join",
  ]);
  assert.equal(autoJoin.code, 0, autoJoin.stderr);
  assert.deepEqual(lastBody(), { roleGrant: { guildId: GUILD, roleId: ROLE, autoJoin: true } });
  assert.match(autoJoin.stdout, /Auto-join adds respondents to your Discord server/);
  assert.match(autoJoin.stdout, /asks each person's permission first/);

  resetState();
  const clearRole = await runCli(["discord", "enable", "f1", "--role", "none"]);
  assert.equal(clearRole.code, 0, clearRole.stderr);
  assert.deepEqual(lastBody(), { roleGrant: null });

  resetState();
  const badRole = await runCli(["discord", "enable", "f1", "--role", "acme/beta"]);
  assert.notEqual(badRole.code, 0);
  assert.match(badRole.stderr, /--role must be <guildId>\/<roleId>/);
  assert.equal(requests.length, 1, "a malformed role never reaches the write");

  resetState();
  const lonelyAutoJoin = await runCli(["discord", "enable", "f1", "--auto-join"]);
  assert.notEqual(lonelyAutoJoin.code, 0);
  assert.match(lonelyAutoJoin.stderr, /--auto-join needs --role/);

  // A tenant-boundary refusal from the server is surfaced verbatim.
  resetState({
    putStatus: 403,
    putError: {
      error:
        "That server isn't connected to this workspace — connect one of its channel webhooks first.",
    },
  });
  const deniedGuild = await runCli(["discord", "enable", "f1", "--role", `${GUILD}/${ROLE}`]);
  assert.notEqual(deniedGuild.code, 0);
  assert.match(deniedGuild.stderr, /isn't connected to this workspace/);

  // ================= discord disable =================
  resetState();
  const disable = await runCli(["discord", "disable", "f1"]);
  assert.equal(disable.code, 0, disable.stderr);
  assert.deepEqual(requestPaths(), ["PUT /api/v1/cli/forms/f1/discord"]);
  assert.deepEqual(lastBody(), { enabled: false });
  assert.match(disable.stdout, /no longer posts to Discord/);

  resetState();
  const disableNoForm = await runCli(["discord", "disable"]);
  assert.notEqual(disableNoForm.code, 0);
  assert.match(disableNoForm.stderr, /Usage: fillo discord disable <form>/);

  // ================= discord roles =================
  resetState();
  const guilds = await runCli(["discord", "roles"]);
  assert.equal(guilds.code, 0, guilds.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/discord/roles"]);
  assert.match(guilds.stdout, /SERVER +ID/);
  assert.match(guilds.stdout, new RegExp(`Acme HQ +${GUILD}`));

  resetState();
  const roleList = await runCli(["discord", "roles", GUILD]);
  assert.equal(roleList.code, 0, roleList.stderr);
  assert.equal(requests[0].query.guildId, GUILD);
  assert.match(roleList.stdout, /ROLE +ID +GRANTABLE/);
  assert.match(roleList.stdout, new RegExp(`Beta Tester +${ROLE} +yes`));
  assert.match(roleList.stdout, /Admin +555555555555555555 +no/);

  resetState({
    rolesStatus: 403,
    rolesError: {
      error:
        "That server isn't connected to this workspace — connect one of its channel webhooks first.",
    },
  });
  const deniedRoles = await runCli(["discord", "roles", GUILD]);
  assert.notEqual(deniedRoles.code, 0);
  assert.match(deniedRoles.stderr, /isn't connected to this workspace/);

  // ================= tokens create-connector =================
  resetState();
  const tokensHelp = await runCli(["tokens"]);
  assert.equal(tokensHelp.code, 0, tokensHelp.stderr);
  assert.match(tokensHelp.stdout, /tokens create-connector/);

  resetState();
  const noTool = await runCli(["tokens", "create-connector"]);
  assert.notEqual(noTool.code, 0);
  assert.match(noTool.stderr, /--tool zapier\|n8n/);
  assert.equal(requests.length, 0, "no credential is minted without a named connector");

  resetState();
  const badTool = await runCli(["tokens", "create-connector", "--tool", "hubspot"]);
  assert.notEqual(badTool.code, 0);
  assert.match(badTool.stderr, /--tool must be one of: zapier, n8n/);
  assert.equal(requests.length, 0);

  resetState();
  const minted = await runCli(["tokens", "create-connector", "--tool", "n8n"]);
  assert.equal(minted.code, 0, minted.stderr);
  assert.deepEqual(requestPaths(), ["POST /api/v1/cli/tokens/connector"]);
  assert.deepEqual(lastBody(), { tool: "n8n" });
  assert.match(minted.stdout, /Created a n8n connector token/);
  assert.match(minted.stdout, /fcli_connector_minted_secret/);
  assert.match(minted.stdout, /Store it now/);
  assert.match(minted.stdout, /Treat it like a password/);
  assert.match(minted.stdout, /Revoke it any time in Settings/);

  resetState();
  const mintedJson = await runCli(["tokens", "create-connector", "--tool", "zapier", "--json"]);
  assert.equal(mintedJson.code, 0, mintedJson.stderr);
  assert.deepEqual(oneJsonDoc(mintedJson), {
    token: "fcli_connector_minted_secret",
    tool: "zapier",
    label: "Zapier",
  });

  // A server that answers with something that isn't a Fillo token is refused
  // rather than echoed.
  resetState({
    connectorToken: {
      status: 201,
      body: { token: "not-a-fillo-token", tool: "n8n", label: "n8n" },
    },
  });
  const junk = await runCli(["tokens", "create-connector", "--tool", "n8n"]);
  assert.notEqual(junk.code, 0);
  assert.match(junk.stderr, /unexpected token format/);

  console.log("discord + tokens command checks passed");
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

function runCli(args, extraEnv = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env,
        FILLO_API: api,
        FILLO_DISCORD_WEBHOOK_URL: "",
        CI: "true",
        HOME: home,
        USERPROFILE: home,
        ...extraEnv,
      },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
