import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for `fillo sheets|notion|hubspot|slack|connections`: built
 * CLI + scratch HOME + FILLO_API pointed at a stub of the per-form
 * `/api/v1/cli/forms/<form>/integrations/<provider>` route and the
 * `/api/v1/cli/integrations/...` connection routes.
 *
 * The properties worth a test each, because losing any of them is silent:
 *
 *   - Tier B. Turning an integration on starts sending a workspace's answers to
 *     a third party, so an agent (--json or FILLO_AGENT=1) is REFUSED without a
 *     bare --confirm, nothing is written, and the consent notice naming where
 *     the data goes is printed before the write — on stderr as a JSON line
 *     under --json, so stdout stays exactly one document.
 *   - Tier C. Removing a workspace account and disconnecting a Discord server
 *     need the target typed back; --yes never substitutes.
 *   - A command that can't act coherently (HubSpot with no email field, Slack
 *     with no channel on a form that is off) fails BEFORE the request rather
 *     than guessing.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-integrations-"));
const accountToken = "fcli_test_account_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

const GUILD = "222222222222222222";

let api = "";
let requests = [];
let state = {};

function resetState(overrides = {}) {
  requests = [];
  state = {
    integration: {
      provider: "google_sheets",
      enabled: false,
      config: null,
    },
    integrationStatus: 200,
    putStatus: 200,
    putError: null,
    connections: {
      accounts: [
        {
          id: "conn_1",
          provider: "slack",
          label: "Acme HQ",
          selected: true,
          projectCount: 1,
          formDestinationCount: 2,
        },
      ],
      selected: { notion: null, slack: "conn_1", hubspot: null, discord: null },
      discordServers: [{ id: "guild_row_1", guildId: GUILD, name: "Acme HQ" }],
    },
    removeStatus: 200,
    removeBody: { removed: true, id: "conn_1", provider: "slack", label: "Acme HQ" },
    disconnectStatus: 200,
    disconnectBody: { disconnected: true, guildId: GUILD, name: "Acme HQ" },
    properties: { properties: [{ name: "firstname", label: "First name", type: "string" }] },
    ...overrides,
  };
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, api || "http://127.0.0.1");
  requests.push({ method: req.method, path: url.pathname, body });
  res.setHeader("Content-Type", "application/json");
  const send = (status, payload) => {
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  };
  if (req.headers.authorization !== `Bearer ${accountToken}`) {
    return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
  }

  const segs = url.pathname.split("/").filter(Boolean).slice(3); // after api/v1/cli
  const [a, b, c, d] = segs;

  if (a === "whoami" && req.method === "GET") {
    return send(200, { workspace: "Acme", workspaceId: "org_acme", projectId: "project_main" });
  }
  if (a === "forms" && c === "integrations") {
    if (state.integrationStatus !== 200) {
      return send(state.integrationStatus, { error: "Form not found" });
    }
    if (req.method === "GET") return send(200, { ...state.integration, provider: d });
    if (req.method === "PUT") {
      if (state.putStatus !== 200) return send(state.putStatus, state.putError);
      return send(200, { provider: d, enabled: true, config: JSON.parse(body) });
    }
    if (req.method === "DELETE") return send(200, { provider: d, enabled: false, config: null });
  }
  // The pre-existing connection-status route: bare `fillo slack status` must
  // keep landing here, not on the new per-form route.
  if (a === "slack" && req.method === "GET") {
    return send(200, { connected: true, accountLabel: "Acme HQ", channels: [] });
  }
  if (a === "integrations" && b === "connections" && c === undefined && req.method === "GET") {
    return send(200, state.connections);
  }
  if (a === "integrations" && b === "connections" && c && req.method === "PUT") {
    return send(200, state.connections);
  }
  if (a === "integrations" && b === "accounts" && req.method === "DELETE") {
    return send(state.removeStatus, state.removeBody);
  }
  if (a === "integrations" && b === "discord" && c === "servers" && req.method === "DELETE") {
    return send(state.disconnectStatus, state.disconnectBody);
  }
  if (a === "integrations" && b === "discord" && c === "accounts" && req.method === "PATCH") {
    return send(200, { id: d, label: JSON.parse(body).label });
  }
  if (a === "integrations" && b === "hubspot" && c === "properties") {
    return send(200, state.properties);
  }

  return send(404, { error: "not found" });
});

const requestPaths = () => requests.map((r) => `${r.method} ${r.path}`);
const writes = () => requests.filter((r) => r.method !== "GET");
const lastBody = () => JSON.parse(requests.at(-1).body);
const oneJsonDoc = (result) => {
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be exactly one JSON line, got:\n${result.stdout}`);
  return JSON.parse(lines[0]);
};
const stderrNotices = (result) =>
  result.stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.status === "notice");

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
  for (const family of ["sheets", "notion", "hubspot", "connections"]) {
    const help = await runCli([family, "help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`fillo ${family}`));
    assert.equal(requests.length, 0, `${family} help must not call the API`);
  }

  resetState();
  for (const family of ["sheets", "notion", "hubspot", "connections"]) {
    const unknown = await runCli([family, "nuke"]);
    assert.notEqual(unknown.code, 0, `${family} nuke should fail`);
    assert.match(unknown.stderr, new RegExp(`Unknown ${family} command: nuke`));
  }

  // ================= Tier B: enabling needs the human's yes =================
  resetState();
  const refused = await runCli(["sheets", "enable", "contact", "--json"]);
  assert.notEqual(refused.code, 0, "agent mode must refuse to enable without --confirm");
  const refusedBody = oneJsonDoc(refused);
  assert.match(refusedBody.error, /--confirm/);
  assert.match(refusedBody.error, /Google account/, "the refusal must say where data would go");
  assert.equal(writes().length, 0, "a refused enable must not write");

  resetState();
  const refusedEnv = await runCli(["notion", "enable", "contact"], { FILLO_AGENT: "1" });
  assert.notEqual(refusedEnv.code, 0, "FILLO_AGENT=1 is agent mode too");
  assert.match(refusedEnv.stderr, /--confirm/);
  assert.equal(writes().length, 0);

  // The consent notice rides on stderr under --json; stdout stays one document.
  resetState();
  const enabled = await runCli(["sheets", "enable", "contact", "--json", "--confirm"]);
  assert.equal(enabled.code, 0, enabled.stderr);
  const notices = stderrNotices(enabled);
  assert.equal(notices.length, 1, "exactly one consent notice");
  assert.match(notices[0].notice, /Google account/);
  const enabledBody = oneJsonDoc(enabled);
  assert.equal(enabledBody.enabled, true);
  assert.deepEqual(
    requestPaths().filter((p) => p.startsWith("PUT")),
    ["PUT /api/v1/cli/forms/contact/integrations/google_sheets"],
  );

  // A pasted Sheets link is parsed locally: the server receives ids, not a URL.
  resetState();
  const withSheet = await runCli([
    "sheets",
    "enable",
    "contact",
    "--sheet",
    "https://docs.google.com/spreadsheets/d/1AbC_dEfGhIj/edit#gid=42",
    "--json",
    "--confirm",
  ]);
  assert.equal(withSheet.code, 0, withSheet.stderr);
  assert.deepEqual(lastBody(), { spreadsheetId: "1AbC_dEfGhIj", sheetTabId: 42 });

  resetState();
  const badSheet = await runCli([
    "sheets",
    "enable",
    "contact",
    "--sheet",
    "https://example.com/not-a-sheet",
    "--json",
    "--confirm",
  ]);
  assert.notEqual(badSheet.code, 0);
  assert.match(oneJsonDoc(badSheet).error, /Google Sheets link/);
  assert.equal(writes().length, 0, "a bad link must fail before the request");

  // A human at a TTY is the yes — no --confirm needed, but the notice still prints.
  resetState();
  const human = await runCli(["notion", "enable", "contact"], { FILLO_TTY: "1" });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Notion workspace/);
  assert.equal(writes().length, 1);

  // --confirm is the Tier B acknowledgement, never a value here: a swallowed
  // word (`--confirm yes`) is named rather than quietly read as consent.
  resetState();
  const valued = await runCli(["sheets", "enable", "contact", "--confirm", "yes", "--json"]);
  assert.notEqual(valued.code, 0);
  assert.match(oneJsonDoc(valued).error, /takes no value/);
  assert.equal(writes().length, 0);

  // ================= disable is Tier A =================
  resetState();
  const disabled = await runCli(["sheets", "disable", "contact", "--json"]);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(oneJsonDoc(disabled).enabled, false);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/forms/contact/integrations/google_sheets"]);

  // ================= coherence before the request =================
  resetState();
  const noEmail = await runCli(["hubspot", "enable", "contact", "--json", "--confirm"]);
  assert.notEqual(noEmail.code, 0);
  assert.match(oneJsonDoc(noEmail).error, /--email-field/);
  assert.equal(writes().length, 0);

  resetState();
  const halfDeal = await runCli([
    "hubspot",
    "enable",
    "contact",
    "--email-field",
    "email",
    "--deal-name",
    "company",
    "--json",
    "--confirm",
  ]);
  assert.notEqual(halfDeal.code, 0);
  assert.match(oneJsonDoc(halfDeal).error, /--deal-pipeline/);
  assert.equal(writes().length, 0);

  resetState();
  const hubspotOk = await runCli([
    "hubspot",
    "enable",
    "contact",
    "--email-field",
    "email",
    "--map",
    "name=firstname,co=company",
    "--marketable",
    "--json",
    "--confirm",
  ]);
  assert.equal(hubspotOk.code, 0, hubspotOk.stderr);
  assert.deepEqual(lastBody(), {
    hubspotEmailFieldId: "email",
    hubspotMappings: [
      { fieldId: "name", property: "firstname" },
      { fieldId: "co", property: "company" },
    ],
    hubspotCreateMarketableContact: true,
  });
  assert.match(stderrNotices(hubspotOk)[0].notice, /a Contact/);

  // Slack: a form that is off needs a channel named, not guessed.
  resetState();
  const noChannel = await runCli(["slack", "enable", "contact", "--json", "--confirm"]);
  assert.notEqual(noChannel.code, 0);
  assert.match(oneJsonDoc(noChannel).error, /--channel/);
  assert.equal(writes().length, 0);

  resetState();
  const slackOk = await runCli([
    "slack",
    "enable",
    "contact",
    "--channel",
    "C0123456789",
    "--fields",
    "email,message",
    "--json",
    "--confirm",
  ]);
  assert.equal(slackOk.code, 0, slackOk.stderr);
  assert.deepEqual(lastBody(), {
    slackChannelId: "C0123456789",
    slackIncludeFieldIds: ["email", "message"],
  });

  // Bare `fillo slack status` still reports the CONNECTION, not a form.
  resetState();
  const slackConnection = await runCli(["slack", "status", "--json"]);
  assert.ok(
    requestPaths().every((path) => !path.includes("/integrations/")),
    "bare slack status must not hit the per-form route",
  );
  assert.equal(slackConnection.code, 0, slackConnection.stderr);

  // ================= connections =================
  resetState();
  const listed = await runCli(["connections", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(oneJsonDoc(listed).accounts[0].label, "Acme HQ");

  resetState();
  const used = await runCli(["connections", "use", "slack", "conn_1", "--json"]);
  assert.equal(used.code, 0, used.stderr);
  assert.deepEqual(lastBody(), { connectionId: "conn_1" });

  resetState();
  const badProvider = await runCli(["connections", "use", "salesforce", "conn_1", "--json"]);
  assert.notEqual(badProvider.code, 0);
  assert.match(oneJsonDoc(badProvider).error, /Choose a provider/);

  // ================= Tier C: typed confirmation =================
  resetState();
  for (const args of [
    ["connections", "remove", "slack", "conn_1", "--json"],
    ["connections", "remove", "slack", "conn_1", "--json", "--yes"],
  ]) {
    const refusedRemove = await runCli(args);
    assert.notEqual(refusedRemove.code, 0, `${args.join(" ")} must refuse`);
    assert.match(oneJsonDoc(refusedRemove).error, /--confirm/);
    assert.equal(writes().length, 0, "--yes never substitutes for the typed name");
  }

  resetState();
  const removed = await runCli([
    "connections",
    "remove",
    "slack",
    "conn_1",
    "--confirm",
    "Acme HQ",
    "--json",
  ]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(lastBody(), { confirm: "Acme HQ" });

  resetState({
    removeStatus: 409,
    removeBody: { error: 'Confirm the removal by sending the account\'s exact name: "Acme HQ".' },
  });
  const mismatch = await runCli([
    "connections",
    "remove",
    "slack",
    "conn_1",
    "--confirm",
    "acme hq",
    "--json",
  ]);
  assert.notEqual(mismatch.code, 0);
  assert.match(oneJsonDoc(mismatch).error, /exact name/);

  resetState();
  const refusedServer = await runCli(["discord", "disconnect-server", GUILD, "--json"]);
  assert.notEqual(refusedServer.code, 0);
  assert.match(oneJsonDoc(refusedServer).error, /--confirm/);
  assert.equal(writes().length, 0);

  resetState();
  const disconnected = await runCli([
    "discord",
    "disconnect-server",
    GUILD,
    "--confirm",
    GUILD,
    "--json",
  ]);
  assert.equal(disconnected.code, 0, disconnected.stderr);
  assert.deepEqual(lastBody(), { confirm: GUILD });

  // Renaming a channel is label-only, so it needs no confirmation at all.
  resetState();
  const renamed = await runCli(["discord", "rename", "conn_1", "#leads", "--json"]);
  assert.equal(renamed.code, 0, renamed.stderr);
  assert.deepEqual(requestPaths(), ["PATCH /api/v1/cli/integrations/discord/accounts/conn_1"]);
  assert.deepEqual(lastBody(), { label: "#leads" });

  // ================= lookups =================
  resetState();
  const properties = await runCli(["hubspot", "properties", "--json"]);
  assert.equal(properties.code, 0, properties.stderr);
  assert.equal(oneJsonDoc(properties).properties[0].name, "firstname");

  // ================= token handling =================
  resetState();
  const badToken = await runCli(["sheets", "status", "contact", "--json"], {
    HOME: mkdtempSync(join(tmpdir(), "fillo-empty-")),
  });
  assert.notEqual(badToken.code, 0);
  assert.match(oneJsonDoc(badToken).error, /Not logged in/);

  console.log("integrations command checks passed");
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
        FILLO_AGENT: "",
        FILLO_TTY: "",
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
