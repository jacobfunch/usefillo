import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A malformed schema should be rejected locally by the bundled core validator,
// before `fillo push` ever contacts /forms/sync. A valid schema must still be
// sent unchanged — the local check is a fast path, not a behavior change.

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-local-validation-"));
const configDir = join(home, ".fillo");
const syncToken = "fsync_test_secret_abcdef";
const validSchema = {
  version: 1,
  title: "Contact",
  pages: [{ id: "main", blocks: [{ id: "email", kind: "email", label: "Email" }] }],
  settings: {},
};
// Empty `pages` fails core's structural validation ("pages: Invalid input").
const malformedSchema = { version: 1, title: "Broken", pages: [] };
const requests = [];
let api = "";

mkdirSync(configDir, { recursive: true });

const server = createServer(async (req, res) => {
  const rawBody = await readBody(req);
  requests.push({ url: req.url, body: rawBody ? JSON.parse(rawBody) : {} });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/v1/forms/sync") {
    res.statusCode = 201;
    res.end(
      JSON.stringify({ formId: "form_contact", slug: "contact", status: "draft", staged: true }),
    );
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

  // A malformed schema is rejected locally, naming the form handle, and the
  // server is never contacted.
  const rejected = await runCli(
    ["push", "-", "--handle", "bad", "--stage"],
    JSON.stringify(malformedSchema),
    { FILLO_SYNC_TOKEN: syncToken },
  );
  assert.notEqual(rejected.code, 0, rejected.stdout);
  assert.match(rejected.stderr, /Invalid schema for .bad./i);
  assert.match(rejected.stderr, /pages/i);
  assert.equal(requests.length, 0, "a malformed schema must never reach the server");
  assert.doesNotMatch(rejected.stdout, /Draft ready|Synced|Staged/);

  // A valid schema still reaches /forms/sync, sent through unchanged.
  const accepted = await runCli(
    ["push", "-", "--handle", "contact", "--stage"],
    JSON.stringify(validSchema),
    { FILLO_SYNC_TOKEN: syncToken },
  );
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(requests.length, 1, "a valid schema must reach the server exactly once");
  assert.equal(requests[0].url, "/api/v1/forms/sync");
  assert.equal(requests[0].body.id, "contact");
  assert.deepEqual(requests[0].body.schema, validSchema);
  assert.match(accepted.stdout, /Draft ready/);

  console.log("local schema validation checks passed");
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

function runCli(args, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      FILLO_API: api,
      HOME: home,
      USERPROFILE: home,
      ...extraEnv,
    };
    if (!("FILLO_SYNC_TOKEN" in extraEnv)) delete env.FILLO_SYNC_TOKEN;
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
