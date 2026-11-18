import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-agent-account-"));
const accountToken = "fcli_test_account_secret";
const freshAccountToken = "fcli_test_fresh_handoff_secret";
const progressToken = "progress_test_secret";
const privateEmail = "owner-private@example.test";
const requests = [];
let api = "";

mkdirSync(join(home, ".fillo"), { recursive: true });
mkdirSync(join(home, ".git"));
const configPath = join(home, ".fillo", "config.json");

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  requests.push({ url: req.url, authorization: req.headers.authorization, body });
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/api/v1/device/code") {
    assert.deepEqual(JSON.parse(body), {
      agent_run_id: "run_test",
      agent_run_token: progressToken,
    });
    res.end(
      JSON.stringify({
        device_code: "fdc_test",
        user_code: "TEST-CODE",
        verification_uri: `${api}/device`,
        verification_uri_complete: `${api}/device?code=TEST-CODE`,
        interval: 0,
        expires_in: 5,
      }),
    );
    return;
  }
  if (req.url === "/api/v1/device/token") {
    assert.deepEqual(JSON.parse(body), { device_code: "fdc_test" });
    res.end(JSON.stringify({ access_token: freshAccountToken, token_type: "bearer" }));
    return;
  }
  if (req.url === "/api/v1/cli/whoami") {
    assert.equal(req.headers.authorization, `Bearer ${freshAccountToken}`);
    // Even if an older server still includes identity fields, the CLI must not
    // print them into the agent-visible terminal transcript.
    res.end(JSON.stringify({ workspace: "Northstar", email: privateEmail }));
    return;
  }
  if (req.url === "/api/v1/agent-runs/run_test/account") {
    assert.ok(
      req.headers.authorization === `Bearer ${accountToken}` ||
        req.headers.authorization === `Bearer ${freshAccountToken}`,
    );
    assert.equal(req.headers["x-fillo-agent-run-token"], progressToken);
    res.end(JSON.stringify({ workspace: "Northstar", publishableKey: "pk_northstar" }));
    return;
  }
  if (req.url === "/api/v1/agent-runs/run_test/events") {
    assert.equal(req.headers.authorization, `Bearer ${progressToken}`);
    assert.deepEqual(JSON.parse(body), {
      status: "connected",
      message: "Agent connected. Reading the app now.",
    });
    res.end(JSON.stringify({ event: { status: "connected" } }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;
  writeConfig({ token: accountToken, tokenApi: api });

  const result = await runCli([
    "agent",
    "connect",
    "--account",
    "--api",
    api,
    "--run",
    "run_test",
    "--token",
    progressToken,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    requests.map((request) => request.url),
    ["/api/v1/agent-runs/run_test/account", "/api/v1/agent-runs/run_test/events"],
  );
  assert.match(result.stdout, /Northstar/);
  assert.match(result.stdout, /pk_northstar/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(accountToken));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(progressToken));

  // --status is validated locally against the CLI-sendable statuses. "copied"
  // exists server-side but is browser-posted only; it must be rejected with the
  // valid list before any request leaves the machine.
  const badStatus = await runCli([
    "agent",
    "event",
    "--api",
    api,
    "--run",
    "run_test",
    "--token",
    progressToken,
    "--status",
    "copied",
    "--message",
    "Copied the prompt",
  ]);
  assert.notEqual(badStatus.code, 0);
  assert.match(
    badStatus.stderr,
    /--status must be one of: created, connected, asking, planning, installing, editing, checking, needs_action, done, error/,
  );
  assert.equal(requests.length, 2, "an invalid status must be rejected before any request");

  // Tokens created by older CLIs have no trusted issuer recorded. Never infer
  // it from mutable FILLO_API; require a fresh browser login instead.
  writeConfig({ token: accountToken });
  const legacy = await runCli(
    ["agent", "connect", "--account", "--api", api, "--run", "run_test", "--token", progressToken],
    api,
  );
  assert.notEqual(legacy.code, 0);
  assert.match(legacy.stderr, /login.*again/i);
  assert.equal(requests.length, 2, "a token with no issuer must not leave the machine");

  writeConfig({ token: accountToken, tokenApi: api });

  const wrongGlobal = await runCli(["whoami"], "http://127.0.0.1:9");
  assert.notEqual(wrongGlobal.code, 0);
  assert.match(wrongGlobal.stderr, /login belongs to/i);
  assert.equal(requests.length, 2, "FILLO_API must not redirect an account bearer");
  assert.doesNotMatch(`${wrongGlobal.stdout}\n${wrongGlobal.stderr}`, new RegExp(accountToken));

  const refused = await runCli(
    [
      "agent",
      "connect",
      "--account",
      "--api",
      "http://127.0.0.1:9",
      "--run",
      "run_test",
      "--token",
      progressToken,
    ],
    api,
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /login belongs to/i);
  assert.equal(requests.length, 2, "an untrusted --api must not receive the account token");
  assert.doesNotMatch(`${refused.stdout}\n${refused.stderr}`, new RegExp(accountToken));

  const freshLogin = await runCli([
    "login",
    "--api",
    api,
    "--run",
    "run_test",
    "--token",
    progressToken,
  ]);
  assert.equal(freshLogin.code, 0, freshLogin.stderr);
  assert.deepEqual(
    requests.slice(-3).map((request) => request.url),
    ["/api/v1/device/code", "/api/v1/device/token", "/api/v1/cli/whoami"],
  );
  assert.match(freshLogin.stdout, /Connected to.*Northstar/s);
  assert.doesNotMatch(`${freshLogin.stdout}\n${freshLogin.stderr}`, new RegExp(privateEmail));
  assert.doesNotMatch(`${freshLogin.stdout}\n${freshLogin.stderr}`, new RegExp(freshAccountToken));
  assert.doesNotMatch(`${freshLogin.stdout}\n${freshLogin.stderr}`, new RegExp(progressToken));

  const bootstrap = await runCli([
    "agent",
    "bootstrap",
    "--account",
    "--api",
    api,
    "--run",
    "run_test",
    "--token",
    progressToken,
  ]);
  assert.equal(bootstrap.code, 0, bootstrap.stderr);
  assert.deepEqual(
    requests.slice(-5).map((request) => request.url),
    [
      "/api/v1/device/code",
      "/api/v1/device/token",
      "/api/v1/cli/whoami",
      "/api/v1/agent-runs/run_test/account",
      "/api/v1/agent-runs/run_test/events",
    ],
  );
  assert.ok(existsSync(join(home, ".agents", "skills", "build-with-fillo", "SKILL.md")));
  assert.ok(existsSync(join(home, ".claude", "skills", "build-with-fillo", "SKILL.md")));
  assert.match(bootstrap.stdout, /Installed.*Build with Fillo/s);
  assert.match(bootstrap.stdout, /Workspace approved.*Live progress connected/s);
  assert.match(bootstrap.stdout, /Northstar/);
  assert.match(bootstrap.stdout, /pk_northstar/);
  assert.doesNotMatch(`${bootstrap.stdout}\n${bootstrap.stderr}`, new RegExp(privateEmail));
  assert.doesNotMatch(`${bootstrap.stdout}\n${bootstrap.stderr}`, new RegExp(freshAccountToken));
  assert.doesNotMatch(`${bootstrap.stdout}\n${bootstrap.stderr}`, new RegExp(progressToken));

  const beforeGuestBootstrap = requests.length;
  const guestBootstrap = await runCli([
    "agent",
    "bootstrap",
    "--api",
    api,
    "--run",
    "run_test",
    "--token",
    progressToken,
  ]);
  assert.equal(guestBootstrap.code, 0, guestBootstrap.stderr);
  assert.deepEqual(
    requests.slice(beforeGuestBootstrap).map((request) => request.url),
    ["/api/v1/agent-runs/run_test/events"],
    "guest bootstrap must not start account login",
  );
  assert.match(guestBootstrap.stdout, /already installed/);

  console.log("agent bootstrap and account attachment checks passed");
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

function runCli(args, configuredApi = args[args.indexOf("--api") + 1]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env,
        FILLO_API: configuredApi,
        CI: "true",
        HOME: home,
        USERPROFILE: home,
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
