import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for `fillo responses` (list / export / summary): built CLI
 * + scratch HOME + FILLO_API pointed at a stub of the three /api/v1/cli
 * responses twins. Locks the --json purity contract, the export-to-file and
 * export-to-stdout byte paths, and terminal sanitization of respondent text.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-responses-"));
const accountToken = "fcli_test_account_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

const CSV =
  '"Received","Name"\n"2026-07-21T10:00:00.000Z","Ada"\n"2026-07-20T09:30:00.000Z","Bo"\n';

const LIST_BODY = {
  data: [
    {
      id: "r2",
      formId: "f1",
      // A hostile answer value: ANSI escapes must never reach the terminal.
      data: { name: "Ada", email: "ada@example.com", evil: "[31mboo[0m" },
      meta: null,
      formVersionId: null,
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: null,
    },
    {
      id: "r1",
      formId: "f1",
      data: { name: "Bo" },
      meta: null,
      formVersionId: null,
      createdAt: "2026-07-20T09:30:00.000Z",
      updatedAt: null,
    },
  ],
  nextCursor: "r1",
};

const SUMMARY_BODY = {
  formId: "f1",
  total: 5,
  firstAt: "2026-07-01T10:00:00.000Z",
  lastAt: "2026-07-21T10:00:00.000Z",
  fields: [
    { id: "name", label: "Name", kind: "short_text", answered: 5 },
    { id: "plan", label: "Plan", kind: "select", answered: 4, distribution: { Pro: 3, Free: 1 } },
  ],
  recent: [
    { id: "r2", createdAt: "2026-07-21T10:00:00.000Z", answers: { name: "Ada", plan: "Pro" } },
  ],
};

let api = "";
let requests = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, api || "http://127.0.0.1");
  requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    authorization: req.headers.authorization,
  });
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  };
  if (req.headers.authorization !== `Bearer ${accountToken}`) {
    return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
  }
  if (url.pathname === "/api/v1/cli/forms/missing/responses") {
    return send(404, { error: "Form not found" });
  }
  if (url.pathname === "/api/v1/cli/forms/f1/responses") {
    return send(200, LIST_BODY);
  }
  if (url.pathname === "/api/v1/cli/forms/f1/responses/export") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.end(CSV);
  }
  if (url.pathname === "/api/v1/cli/forms/f1/responses/summary") {
    return send(200, SUMMARY_BODY);
  }
  return send(404, { error: "not found" });
});

const noAnsi = (result) => {
  assert.ok(
    !`${result.stdout}\n${result.stderr}`.includes("\x1b["),
    "non-TTY output must carry zero ANSI",
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
  writeConfig({ token: accountToken, tokenApi: api });

  // ---------- responses list ----------
  requests = [];
  const listed = await runCli(["responses", "list", "f1", "--limit", "2"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    ["GET /api/v1/cli/forms/f1/responses"],
  );
  assert.equal(requests[0].query.limit, "2", "--limit must forward as ?limit=");
  assert.match(listed.stdout, /ID +CREATED +ANSWERS/);
  assert.match(listed.stdout, /r2 +2026-07-21 10:00 +Ada · ada@example\.com/);
  assert.match(listed.stdout, /r1 +2026-07-20 09:30 +Bo/);
  assert.match(listed.stdout, /More available/);
  // The hostile value's ESC bytes are stripped by terminalText.
  assert.ok(!listed.stdout.includes("[31m"), "answer text must be sanitized");
  noAnsi(listed);

  // --json purity: the raw body is the single stdout document.
  requests = [];
  const listedJson = await runCli(["responses", "list", "f1", "--json"]);
  assert.equal(listedJson.code, 0, listedJson.stderr);
  assert.deepEqual(JSON.parse(listedJson.stdout), LIST_BODY);
  noAnsi(listedJson);

  // A real JSON 404 names the form, not a deployment problem.
  requests = [];
  const missing = await runCli(["responses", "list", "missing"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /No form matches "missing"/);

  // ---------- responses export ----------
  requests = [];
  const outPath = join(home, "out.csv");
  const exported = await runCli(["responses", "export", "f1", "--out", outPath]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    ["GET /api/v1/cli/forms/f1/responses/export"],
  );
  assert.equal(readFileSync(outPath, "utf8"), CSV, "the file must hold the exact CSV bytes");
  assert.match(exported.stdout, new RegExp(`Exported ${Buffer.byteLength(CSV)} bytes to `));
  noAnsi(exported);

  // --json wraps {written, path, bytes}; the CSV stays in the file.
  requests = [];
  const exportedJson = await runCli(["responses", "export", "f1", "--out", "out2.csv", "--json"]);
  assert.equal(exportedJson.code, 0, exportedJson.stderr);
  const wrapped = JSON.parse(exportedJson.stdout);
  assert.equal(wrapped.written, true);
  assert.equal(wrapped.bytes, Buffer.byteLength(CSV));
  // The child's cwd may be the realpath of our tmp HOME (macOS /private/var),
  // so assert the reported path by reading it rather than string equality.
  assert.ok(wrapped.path.endsWith(`${join("/", "out2.csv")}`), wrapped.path);
  assert.equal(readFileSync(wrapped.path, "utf8"), CSV);
  assert.equal(readFileSync(join(home, "out2.csv"), "utf8"), CSV);

  // Without --out the CSV itself is stdout — byte-exact, nothing appended.
  requests = [];
  const piped = await runCli(["responses", "export", "f1"]);
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(piped.stdout, CSV, "stdout must be exactly the CSV bytes");

  // --json without --out cannot keep stdout parseable — refuse locally.
  requests = [];
  const jsonNoOut = await runCli(["responses", "export", "f1", "--json"]);
  assert.notEqual(jsonNoOut.code, 0);
  assert.match(jsonNoOut.stderr, /--out/);
  assert.equal(requests.length, 0, "local validation must not call the server");

  // ---------- responses summary ----------
  requests = [];
  const summarized = await runCli(["responses", "summary", "f1", "--exclude", "email,notes"]);
  assert.equal(summarized.code, 0, summarized.stderr);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    ["GET /api/v1/cli/forms/f1/responses/summary"],
  );
  assert.equal(requests[0].query.exclude, "email,notes", "--exclude must forward as ?exclude=");
  assert.match(summarized.stdout, /5 responses {2}f1/);
  assert.match(summarized.stdout, /First 2026-07-01 · Latest 2026-07-21/);
  assert.match(summarized.stdout, /Name {2}5\/5 answered/);
  assert.match(summarized.stdout, /Plan {2}4\/5 answered/);
  // Choice distributions separate the option from its count with an em dash so
  // "Green — 1" never reads as a single value "Green 1".
  assert.match(summarized.stdout, /Pro — 3 · Free — 1/);
  assert.match(summarized.stdout, /Recent/);
  assert.match(summarized.stdout, /r2 {2}2026-07-21 10:00 {2}name: Ada · plan: Pro/);
  noAnsi(summarized);

  requests = [];
  const summaryJson = await runCli(["responses", "summary", "f1", "--json"]);
  assert.equal(summaryJson.code, 0, summaryJson.stderr);
  assert.deepEqual(JSON.parse(summaryJson.stdout), SUMMARY_BODY);

  // ---------- auth failures ----------
  requests = [];
  writeConfig({ token: "fcli_wrong_token", tokenApi: api });
  const rejected = await runCli(["responses", "list", "f1"]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /Token invalid — run `fillo login` again\./);

  requests = [];
  writeConfig({});
  const loggedOut = await runCli(["responses", "list", "f1"]);
  assert.notEqual(loggedOut.code, 0);
  assert.match(loggedOut.stderr, /Not logged in/);
  assert.equal(requests.length, 0, "no request may leave the machine when logged out");
  writeConfig({ token: accountToken, tokenApi: api });

  // ---------- dispatch ----------
  const help = await runCli(["responses"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /fillo responses/);
  const unknown = await runCli(["responses", "purge"]);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown responses command: purge/);

  console.log("responses list/export/summary checks passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function writeConfig(config) {
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
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
