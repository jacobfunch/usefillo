import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for `fillo logo <file|https-url>`.
 *
 * What it locks:
 *   - a local file travels as base64 `{ data }`, byte for byte, to the one
 *     `fcli_` route; an https URL travels as `{ url }` for Fillo to download.
 *   - a non-https URL and an oversized file are refused before any request.
 *   - the printed id is the server's, and --json is the raw server document.
 *   - a server refusal (unsupported image) surfaces its own copy and fails.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-logo-"));
const accountToken = "fcli_test_logo_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

let api = "";
let requests = [];
let reply = { status: 201, body: {} };

const IMAGE = {
  id: "img_0123456789abcdefghij",
  contentType: "image/png",
  size: 12,
  path: "/api/v1/assets/img_0123456789abcdefghij",
  url: "https://fillo.test/api/v1/assets/img_0123456789abcdefghij",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, api || "http://127.0.0.1");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== `Bearer ${accountToken}`) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "Invalid or missing CLI token — run `fillo login`" }));
  }
  if (url.pathname === "/api/v1/cli/assets" && req.method === "POST") {
    res.statusCode = reply.status;
    return res.end(JSON.stringify(reply.body));
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
  writeFileSync(configPath, JSON.stringify({ token: accountToken, tokenApi: api }), {
    mode: 0o600,
  });

  // ================= a local file travels as base64 =======================
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const pngPath = join(home, "logo.png");
  writeFileSync(pngPath, png);
  requests = [];
  reply = { status: 201, body: IMAGE };
  const local = await runCli(["logo", pngPath]);
  assert.equal(local.code, 0, local.stderr);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    ["POST /api/v1/cli/assets"],
  );
  assert.deepEqual(requests[0].body, { data: png.toString("base64") });
  assert.match(local.stdout, /Logo added: img_0123456789abcdefghij/);
  assert.match(local.stdout, /"logo": "img_0123456789abcdefghij"/);

  // ================= an https URL is Fillo's to download ===================
  requests = [];
  const remote = await runCli(["logo", "https://example.com/brand/logo.png"]);
  assert.equal(remote.code, 0, remote.stderr);
  assert.deepEqual(requests[0].body, { url: "https://example.com/brand/logo.png" });

  // ================= --json is the server's own document ===================
  requests = [];
  const json = await runCli(["logo", pngPath, "--json"]);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), IMAGE);

  // ================= refused before any request ============================
  requests = [];
  const http = await runCli(["logo", "http://example.com/logo.png"]);
  assert.notEqual(http.code, 0);
  assert.match(http.stderr, /must be https/);

  const bigPath = join(home, "big.png");
  writeFileSync(bigPath, Buffer.alloc(512 * 1024 + 1, 1));
  const big = await runCli(["logo", bigPath]);
  assert.notEqual(big.code, 0);
  assert.match(big.stderr, /up to 512 KB/);

  const missing = await runCli(["logo", join(home, "nope.png")]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Couldn't read/);

  const bare = await runCli(["logo"]);
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /Usage: fillo logo/);
  assert.deepEqual(requests, [], "local refusals never reach the server");

  // ================= a server refusal keeps its own copy ===================
  reply = { status: 422, body: { error: "Use a PNG, JPEG, or WebP image." } };
  const refused = await runCli(["logo", pngPath]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Use a PNG, JPEG, or WebP image\./);

  const help = await runCli(["logo", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /SVG is not accepted/);

  console.log("logo checks passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
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
