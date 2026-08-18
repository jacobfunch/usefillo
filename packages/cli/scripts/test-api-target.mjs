import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How the CLI resolves and reports its API target:
 *   - a connection failure names the resolved host and the reason instead of
 *     surfacing Node's bare "fetch failed", and calls out the FILLO_API/--api
 *     override when one is in play;
 *   - an empty or blank FILLO_API means "unset" (default deployment), never an
 *     empty base URL;
 *   - standalone `agent bootstrap` honors --api over FILLO_API.
 * Built CLI + scratch HOME + a local provision stub; no real network.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-api-target-"));
mkdirSync(join(home, ".fillo"), { recursive: true });
writeFileSync(join(home, ".fillo", "config.json"), "{}", { mode: 0o600 });

// A port that refuses connections: bind to grab a free one, then close it.
const deadPort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const dead = `http://127.0.0.1:${deadPort}`;

const requests = [];
const stub = createServer((req, res) => {
  requests.push({ method: req.method, path: req.url });
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && req.url === "/api/v1/workspaces/provision") {
    res.setHeader("Set-Cookie", "fillo_claim=claimtok_api_target; Path=/; HttpOnly");
    res.statusCode = 201;
    res.end(
      JSON.stringify({
        key: "pk_api_target",
        limits: { responses: 10, expiresAt: "2026-08-01T00:00:00.000Z" },
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

try {
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", resolve);
  });
  const live = `http://127.0.0.1:${stub.address().port}`;

  // ---------- unreachable override: name the host, the reason, and the override ----------
  const refused = await runCli(["init", "--email", "x@y.dev"], { env: { FILLO_API: dead } });
  assert.notEqual(refused.code, 0, "an unreachable API must fail");
  assert.ok(
    refused.stderr.includes(`Couldn't reach ${dead}`),
    `the error names the resolved host: ${refused.stderr}`,
  );
  assert.match(refused.stderr, /ECONNREFUSED/, `the connection reason surfaces: ${refused.stderr}`);
  assert.match(refused.stderr, /FILLO_API or --api/, "the override is called out");
  assert.doesNotMatch(refused.stderr, /fetch failed/, "the bare undici message never surfaces");

  // ---------- empty/blank FILLO_API falls back to the default deployment ----------
  for (const value of ["", "   "]) {
    const help = await runCli(["help"], { env: { FILLO_API: value } });
    assert.equal(help.code, 0, help.stderr);
    assert.match(
      help.stdout,
      /API: https:\/\/fillo\.so/,
      `FILLO_API=${JSON.stringify(value)} must mean unset`,
    );
  }

  // ---------- standalone bootstrap honors --api over FILLO_API ----------
  const boot = await runCli(
    ["agent", "bootstrap", "--email", "boot@x.dev", "--api", live, "--json"],
    { env: { FILLO_API: dead } },
  );
  assert.equal(boot.code, 0, boot.stderr);
  assert.equal(
    requests.filter((r) => r.path === "/api/v1/workspaces/provision").length,
    1,
    "the --api target received the provision request",
  );
  const doc = JSON.parse(boot.stdout.trim());
  assert.equal(doc.pk, "pk_api_target", "provisioning went through the --api deployment");
  assert.equal(doc.skill.installed, true);

  console.log("api target resolution and unreachable-host messaging checks passed");
} finally {
  await new Promise((resolve) => stub.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env,
        CI: "true",
        HOME: home,
        USERPROFILE: home,
        ...env,
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
