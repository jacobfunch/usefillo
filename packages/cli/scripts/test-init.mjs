import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for `fillo init`'s identity handling (founder rule: the CLI
 * NEVER silently transmits the git identity):
 *   - interactive human: confirm the git identity before sending (Y sends, n
 *     aborts, EOF fails closed);
 *   - agent/pipe (non-TTY): NO git fallback — --email is required and git is
 *     never invoked;
 *   - --name is forwarded only when explicitly passed.
 * Built CLI + scratch HOME + a fake `git` on PATH + a local provision stub.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-init-"));
const binDir = join(home, "bin");
const gitLog = join(home, "git-invocations.log");
mkdirSync(join(home, ".fillo"), { recursive: true });
mkdirSync(binDir, { recursive: true });
// A `.git` marker makes the repo-root detection deterministic: init/bootstrap
// derive the new workspace name from this directory (never by spawning git).
mkdirSync(join(home, ".git"), { recursive: true });
const derivedWorkspace = basename(home);
const configPath = join(home, ".fillo", "config.json");

// A fake `git` that logs every invocation and answers user.email / user.name
// from env, so a test can both control the identity and prove whether git ran.
writeFileSync(
  join(binDir, "git"),
  [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$GIT_STUB_LOG"',
    'if [ "$1" = "config" ] && [ "$3" = "user.email" ]; then',
    '  if [ -n "$GIT_STUB_EMAIL" ]; then printf "%s\\n" "$GIT_STUB_EMAIL"; exit 0; fi',
    "  exit 1",
    "fi",
    'if [ "$1" = "config" ] && [ "$3" = "user.name" ]; then',
    '  if [ -n "$GIT_STUB_NAME" ]; then printf "%s\\n" "$GIT_STUB_NAME"; exit 0; fi',
    "  exit 1",
    "fi",
    "exit 1",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
chmodSync(join(binDir, "git"), 0o755);

let api = "";
let requests = [];

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, api || "http://127.0.0.1");
  requests.push({ method: req.method, path: url.pathname, body });
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && url.pathname === "/api/v1/workspaces/provision") {
    res.setHeader("Set-Cookie", "fillo_claim=claimtok_init; Path=/; HttpOnly");
    res.statusCode = 201;
    const requested = JSON.parse(body || "{}");
    res.end(
      JSON.stringify({
        key: "pk_init_test",
        organizationId: "org_init",
        // Echo the requested workspace name like the real server would return
        // the stored one, so the CLI can echo the authoritative identity.
        workspaceName: requested.workspaceName ?? "Owner's workspace",
        // The fresh preview resolves a default upload destination (transit), so
        // the pre-authoring signal is available before any login/claim.
        canPublishFileFields: true,
        claim: { url: null, email: requested.email ?? null, sent: true },
        limits: { responses: 10, expiresAt: "2026-08-01T00:00:00.000Z" },
      }),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/cli/whoami") {
    // A stored login resolves to a real, connected workspace name.
    if (req.headers.authorization === "Bearer fcli_existing_login") {
      res.statusCode = 200;
      res.end(JSON.stringify({ workspace: "Founder Marketing" }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

const provisionRequests = () => requests.filter((r) => r.path === "/api/v1/workspaces/provision");
const gitRan = () => existsSync(gitLog) && readFileSync(gitLog, "utf8").trim().length > 0;

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;

  // ---------- interactive: confirm the git identity, then send (Y) ----------
  reset();
  const accepted = await runCli(["init"], {
    env: { FILLO_TTY: "1", GIT_STUB_EMAIL: "jacob@git.dev", GIT_STUB_NAME: "Jacob Funch" },
    input: "Y\n",
  });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.match(
    accepted.stdout,
    /Use your git identity — Jacob Funch <jacob@git\.dev>\?/,
    "the prompt must show exactly what will be sent",
  );
  const acceptedProvisions = provisionRequests();
  assert.equal(acceptedProvisions.length, 1, "the request fires only after acceptance");
  assert.deepEqual(JSON.parse(acceptedProvisions[0].body), {
    email: "jacob@git.dev",
    source: "cli",
    name: "Jacob Funch",
    workspaceName: derivedWorkspace,
  });
  const acceptedConfig = readConfig();
  assert.equal(acceptedConfig.email, "jacob@git.dev");
  assert.equal(acceptedConfig.name, "Jacob Funch", "the name persists to config");
  assert.equal(acceptedConfig.pk, "pk_init_test");

  // ---------- interactive: decline (n) falls through to clean prompts ----------
  reset();
  const declined = await runCli(["init"], {
    env: { FILLO_TTY: "1", GIT_STUB_EMAIL: "jacob@git.dev", GIT_STUB_NAME: "Jacob Funch" },
    input: "n\nother@company.dev\nOther Person\n",
  });
  assert.equal(declined.code, 0, `decline-then-type provisions: ${declined.stderr}`);
  assert.match(declined.stdout, /Use your git identity/);
  assert.match(declined.stdout, /Email for this workspace/);
  const declinedReq = provisionRequests();
  assert.equal(declinedReq.length, 1, "typed identity provisions once");
  assert.deepEqual(
    JSON.parse(declinedReq[0].body),
    {
      email: "other@company.dev",
      source: "cli",
      name: "Other Person",
      workspaceName: derivedWorkspace,
    },
    "the TYPED identity is sent, not git's",
  );

  // ---------- interactive: decline then EOF fails closed ----------
  reset();
  const declinedEof = await runCli(["init"], {
    env: { FILLO_TTY: "1", GIT_STUB_EMAIL: "jacob@git.dev", GIT_STUB_NAME: "Jacob Funch" },
    input: "n\n",
  });
  assert.notEqual(declinedEof.code, 0, "decline then EOF aborts");
  assert.match(declinedEof.stderr, /--email you@company.com/);
  assert.equal(provisionRequests().length, 0, "a declined identity must never be sent");

  // ---------- interactive: invalid typed email re-asks, then accepts ----------
  reset();
  const retyped = await runCli(["init"], {
    env: { FILLO_TTY: "1" },
    input: "not-an-email\nreal@company.dev\n\n",
  });
  assert.equal(retyped.code, 0, `invalid-then-valid provisions: ${retyped.stderr}`);
  assert.match(retyped.stdout, /doesn't look like an email/);
  const retypedReq = provisionRequests();
  assert.equal(retypedReq.length, 1);
  assert.deepEqual(
    JSON.parse(retypedReq[0].body),
    { email: "real@company.dev", source: "cli", workspaceName: derivedWorkspace },
    "Enter on the name prompt skips it",
  );

  // ---------- interactive: EOF fails closed (no keypress ⇒ no send) ----------
  reset();
  const eof = await runCli(["init"], {
    env: { FILLO_TTY: "1", GIT_STUB_EMAIL: "jacob@git.dev" },
    input: "",
  });
  assert.notEqual(eof.code, 0, "an unanswered prompt must not proceed");
  assert.equal(provisionRequests().length, 0, "EOF at the prompt sends nothing");

  // ---------- agent mode (non-TTY): NO git fallback, git never invoked ----------
  reset();
  const agent = await runCli(["init"], {
    env: { GIT_STUB_EMAIL: "jacob@git.dev", GIT_STUB_NAME: "Jacob Funch" },
  });
  assert.notEqual(agent.code, 0, "agent mode requires --email");
  assert.match(agent.stderr, /fillo init --email/);
  assert.match(agent.stderr, /--name/, "the guidance mentions --name is also accepted");
  assert.equal(provisionRequests().length, 0, "no network call without an email");
  assert.equal(gitRan(), false, "agent mode must never invoke git");

  // ---------- agent mode: --json also blocks the git fallback ----------
  reset();
  const agentJson = await runCli(["init", "--json"], {
    env: { FILLO_TTY: "1", GIT_STUB_EMAIL: "jacob@git.dev" },
  });
  assert.notEqual(agentJson.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(agentJson.stdout)), ["error"], "one JSON error object");
  assert.equal(gitRan(), false, "--json must never invoke git even under a forced TTY");

  // ---------- agent mode: explicit --email + --name pass straight through ----------
  reset();
  const explicit = await runCli(["init", "--email", "dev@x.dev", "--name", "Dev Human"], {
    env: { GIT_STUB_EMAIL: "should-not-be-read@git.dev", GIT_STUB_NAME: "Ignored" },
  });
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.deepEqual(JSON.parse(provisionRequests()[0].body), {
    email: "dev@x.dev",
    source: "cli",
    name: "Dev Human",
    workspaceName: derivedWorkspace,
  });
  assert.equal(readConfig().name, "Dev Human");
  assert.equal(gitRan(), false, "explicit flags skip git entirely");

  // ---------- agent mode: --email without --name omits name and skips git ----------
  reset();
  const noName = await runCli(["init", "--email", "solo@x.dev"], {
    env: { GIT_STUB_NAME: "Ignored" },
  });
  assert.equal(noName.code, 0, noName.stderr);
  assert.deepEqual(JSON.parse(provisionRequests()[0].body), {
    email: "solo@x.dev",
    source: "cli",
    workspaceName: derivedWorkspace,
  });
  assert.equal(readConfig().name, undefined, "no name is persisted when none was passed");
  assert.equal(gitRan(), false);

  // ---------- agent bootstrap (standalone): no email → actionable guidance ----------
  reset();
  const bareBootstrap = await runCli(["agent", "bootstrap"], {
    env: { GIT_STUB_EMAIL: "jacob@git.dev" },
  });
  assert.notEqual(bareBootstrap.code, 0, "agent-mode bootstrap without --email must not proceed");
  assert.match(
    bareBootstrap.stderr,
    /--email you@company.com/,
    "guides the agent to pass an email",
  );
  assert.equal(provisionRequests().length, 0, "no workspace provisioned without an email");
  assert.equal(gitRan(), false, "agent mode never harvests the git identity");

  // ---------- agent bootstrap --email --json: provision + skill install, one doc ----------
  reset();
  const bootstrap = await runCli(
    ["agent", "bootstrap", "--email", "boot@x.dev", "--name", "Jacob", "--json"],
    {},
  );
  assert.equal(bootstrap.code, 0, bootstrap.stderr);
  const bootReq = provisionRequests();
  assert.equal(bootReq.length, 1, "bootstrap provisions exactly one workspace");
  assert.deepEqual(JSON.parse(bootReq[0].body), {
    email: "boot@x.dev",
    source: "cli",
    name: "Jacob",
    workspaceName: derivedWorkspace,
  });
  const bootDoc = JSON.parse(bootstrap.stdout.trim());
  assert.equal(bootDoc.pk, "pk_init_test", "the pk is returned");
  assert.equal(bootDoc.existing, false, "a fresh provision is reported as NEW");
  assert.equal(bootDoc.workspace, derivedWorkspace, "the resolved workspace identity is echoed");
  assert.equal(
    bootDoc.canPublishFileFields,
    true,
    "the preview uploads signal is exposed without a login",
  );
  assert.equal(bootDoc.skill.installed, true, "the skill is installed");
  assert.ok(
    Array.isArray(bootDoc.skill.targets) && bootDoc.skill.targets.length > 0,
    "skill targets reported",
  );
  assert.equal(
    readConfig().pk,
    "pk_init_test",
    "bootstrap persists the pk so `fillo claim` works after",
  );
  assert.equal(readConfig().claimToken, "claimtok_init", "and the claim cookie");
  assert.doesNotMatch(
    bootstrap.stdout,
    /Installed|Ask your agent/,
    "quiet skill install keeps --json stdout to one doc",
  );

  // ---------- agent bootstrap --workspace-name: names the new workspace ----------
  reset();
  const named = await runCli(
    ["agent", "bootstrap", "--email", "boot@x.dev", "--workspace-name", "My Cool App", "--json"],
    {},
  );
  assert.equal(named.code, 0, named.stderr);
  assert.equal(
    JSON.parse(provisionRequests()[0].body).workspaceName,
    "My Cool App",
    "--workspace-name overrides the repo/dir default in the provision body",
  );
  assert.equal(
    JSON.parse(named.stdout.trim()).workspace,
    "My Cool App",
    "and is echoed back as the resolved identity",
  );

  // ---------- agent bootstrap human echo names the NEW workspace ----------
  reset();
  const humanNew = await runCli(["agent", "bootstrap", "--email", "boot@x.dev"], {});
  assert.equal(humanNew.code, 0, humanNew.stderr);
  assert.match(
    humanNew.stdout,
    new RegExp(`New workspace ${derivedWorkspace} provisioned`),
    "the human echo names the new workspace and marks it NEW",
  );
  assert.match(
    humanNew.stdout,
    /File uploads: storage ready/,
    "the human echo surfaces the preview uploads signal for a first-timer",
  );

  // ---------- isolation guard: a stored login attaches to a REAL workspace ----------
  // A machine already signed in must not silently provision a throwaway preview
  // beside the real workspace the run will actually use.
  reset();
  writeFileSync(configPath, JSON.stringify({ token: "fcli_existing_login", tokenApi: api }), {
    mode: 0o600,
  });
  const beforeGuard = provisionRequests().length;
  const guarded = await runCli(["agent", "bootstrap"], {});
  assert.equal(guarded.code, 0, guarded.stderr);
  assert.equal(
    provisionRequests().length,
    beforeGuard,
    "a stored login must not provision a fresh preview",
  );
  assert.match(guarded.stdout, /Founder Marketing/, "the existing workspace is named unmissably");
  assert.match(guarded.stdout, /fillo logout/, "and the opt-out escape hatch is shown");
  assert.match(
    guarded.stdout,
    /Ask your agent to use build-with-fillo/,
    "the skill still installs",
  );

  // ---------- isolation guard: --json reports EXISTING, not a phantom pk ----------
  reset();
  writeFileSync(configPath, JSON.stringify({ token: "fcli_existing_login", tokenApi: api }), {
    mode: 0o600,
  });
  const guardedJson = await runCli(["agent", "bootstrap", "--json"], {});
  assert.equal(guardedJson.code, 0, guardedJson.stderr);
  const guardDoc = JSON.parse(guardedJson.stdout.trim());
  assert.equal(guardDoc.existing, true, "an existing login is reported as EXISTING");
  assert.equal(guardDoc.workspace, "Founder Marketing");
  assert.equal(guardDoc.pk, undefined, "no phantom preview key is minted");
  assert.equal(guardDoc.skill.installed, true);

  console.log("agent bootstrap standalone checks passed");
  console.log("init identity handling checks passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function reset() {
  requests = [];
  writeFileSync(configPath, "{}", { mode: 0o600 });
  if (existsSync(gitLog)) rmSync(gitLog);
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

function readConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function runCli(args, { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env,
        FILLO_API: api,
        CI: "true",
        HOME: home,
        USERPROFILE: home,
        GIT_STUB_LOG: gitLog,
        PATH: `${binDir}:${process.env.PATH}`,
        ...env,
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
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
