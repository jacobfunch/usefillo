import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist/index.js");
const scratch = mkdtempSync(join(tmpdir(), "fillo-product-health-"));
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("FILLO_")) delete cleanEnv[key];
const home = join(scratch, "home");
const project = join(scratch, "project");
const configDir = join(home, ".fillo");
mkdirSync(configDir, { recursive: true });
mkdirSync(join(project, ".git"), { recursive: true });
const configPath = join(configDir, "config.json");
const schema = {
  version: 1,
  title: "Contact",
  pages: [{ id: "main", blocks: [{ id: "name", kind: "short_text", label: "Name" }] }],
  settings: {},
};
let requests = [];
let lateCollision = false;
let origin;
const collision = join(project, ".agents/skills/build-with-fillo");
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, body });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/v1/device/code") {
    res.end(
      JSON.stringify({
        device_code: "fixture",
        user_code: "FIXTURE",
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?code=FIXTURE`,
        interval: 0,
        expires_in: 5,
      }),
    );
    return;
  }
  if (req.url === "/api/v1/device/token") {
    res.end(JSON.stringify({ access_token: "fcli_fixture" }));
    return;
  }
  if (req.url === "/api/v1/cli/whoami") {
    res.end(JSON.stringify({ workspace: "Claimed Fixture" }));
    return;
  }
  if (req.url === "/api/v1/workspaces/provision") {
    if (lateCollision) {
      mkdirSync(collision, { recursive: true });
      writeFileSync(join(collision, "SKILL.md"), "custom skill");
    }
    res.setHeader("Set-Cookie", "fillo-claim=fictional-cookie; HttpOnly; Path=/");
    res.end(
      JSON.stringify({
        key: "pk_fixture",
        workspaceName: "Fixture",
        limits: { responses: 100, expiresAt: "2099-01-01T00:00:00Z" },
      }),
    );
    return;
  }
  if (req.url === "/api/v1/forms/sync" || req.url === "/api/v1/cli/forms") {
    const handle = body.id ?? body.handle;
    if (handle === "invalid-response") {
      res.end("null");
      return;
    }
    if (handle === "remote-failure") {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "Fixture unavailable" }));
      return;
    }
    res.end(
      JSON.stringify({
        formId: `form_${handle}`,
        status: "published",
        updated: true,
        staged: handle === "staged",
        url: `${origin}/f/form`,
        slug: "form",
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

function config(value) {
  writeFileSync(configPath, JSON.stringify(value));
}
function run(args, input, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: project,
      env: {
        ...cleanEnv,
        HOME: home,
        USERPROFILE: home,
        FILLO_CONFIG_DIR: configDir,
        FILLO_API: origin,
        CI: "true",
        FILLO_AUTO_UPDATE: "0",
        ...extra,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}
function progress(output) {
  return output.trim().split("\n").filter(Boolean).map(JSON.parse);
}
function compile(source, name) {
  const output = join(scratch, `${name}.mjs`);
  writeFileSync(
    output,
    ts.transpileModule(readFileSync(source, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText,
  );
  return output;
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  config({ token: "fcli_fixture", tokenApi: origin });
  const unknown = await run(["definitely-not-a-command", "--json"]);
  assert.equal(unknown.code, 2);
  assert.match(JSON.parse(unknown.stdout).error, /Unknown command/);
  progress(unknown.stderr);
  const staged = await run(["push", "-", "--handle", "staged", "--json"], JSON.stringify(schema));
  assert.equal(staged.code, 0, staged.stderr);
  assert.equal(JSON.parse(staged.stdout).forms[0].staged, true);
  assert.deepEqual(
    progress(staged.stderr).map((p) => [p.staged, p.published]),
    [[true, false]],
  );
  const humanStaged = await run(["push", "-", "--handle", "staged"], JSON.stringify(schema));
  assert.match(humanStaged.stdout, /Staged changes/);
  assert.match(humanStaged.stdout, /fillo publish/);
  assert.doesNotMatch(humanStaged.stdout, /Live at/);

  for (const credentials of [{ token: "fcli_fixture", tokenApi: origin }, { pk: "pk_fixture" }]) {
    config(credentials);
    requests = [];
    const invalid = await run(
      ["push", "-", "--json"],
      JSON.stringify([
        { id: "first", schema },
        { id: "second", schema: { pages: [] } },
      ]),
    );
    assert.notEqual(invalid.code, 0);
    assert.equal(requests.length, 0);
    progress(invalid.stderr);
    const missingUpload = await run(
      ["push", "-", "--json"],
      JSON.stringify([
        { id: "first", schema },
        { id: "files", schema, storage: "r2", purpose: "file_request" },
      ]),
    );
    assert.notEqual(missingUpload.code, 0);
    assert.equal(requests.length, 0);
    const oversized = await run(
      ["push", "-", "--json"],
      JSON.stringify([
        { id: "first", schema },
        { id: "large", schema: { ...schema, title: "x".repeat(200_001) } },
      ]),
    );
    assert.notEqual(oversized.code, 0);
    assert.equal(requests.length, 0);
    const invalidHandle = await run(
      ["push", "-", "--json"],
      JSON.stringify([
        { id: "first", schema },
        { id: "bad handle", schema },
      ]),
    );
    assert.notEqual(invalidHandle.code, 0);
    assert.equal(requests.length, 0);
    const partial = await run(
      ["push", "-", "--json"],
      JSON.stringify([
        { id: "first", schema },
        { id: "remote-failure", schema },
      ]),
    );
    assert.notEqual(partial.code, 0, partial.stderr);
    const result = JSON.parse(partial.stdout);
    assert.equal(result.forms.length, 1);
    assert.equal(result.forms[0].formId, "form_first");
    assert.equal(result.failed.handle, "remote-failure");
    assert.equal(progress(partial.stderr).at(-1).status, "error");
    const malformedResponse = await run(
      ["push", "-", "--json"],
      JSON.stringify([
        { id: "first", schema },
        { id: "invalid-response", schema },
      ]),
    );
    assert.notEqual(malformedResponse.code, 0);
    assert.equal(JSON.parse(malformedResponse.stdout).forms.length, 1);
    assert.equal(JSON.parse(malformedResponse.stdout).failed.handle, "invalid-response");
  }

  config({
    token: "fcli_fixture",
    tokenApi: origin,
    pk: "pk_fixture",
    activeContext: "provisional",
  });
  requests = [];
  const previewPush = await run(
    ["push", "-", "--handle", "preview", "--json"],
    JSON.stringify(schema),
  );
  assert.equal(previewPush.code, 0, previewPush.stderr);
  assert.equal(
    requests[0].url,
    "/api/v1/forms/sync",
    "selected provisional context must survive a switch from MCP to CLI",
  );
  config({});
  requests = [];
  const syncInvalid = await run(
    ["push", "-", "--stage", "--json"],
    JSON.stringify([
      { id: "first", schema },
      { id: "second", schema: { pages: [] } },
    ]),
    { FILLO_SYNC_TOKEN: "fsync_fixture_long_secret" },
  );
  assert.notEqual(syncInvalid.code, 0);
  assert.equal(requests.length, 0);
  const syncPartial = await run(
    ["push", "-", "--stage", "--json"],
    JSON.stringify([
      { id: "first", schema },
      { id: "remote-failure", schema },
    ]),
    { FILLO_SYNC_TOKEN: "fsync_fixture_long_secret" },
  );
  assert.notEqual(syncPartial.code, 0);
  assert.equal(JSON.parse(syncPartial.stdout).forms.length, 1);
  requests = [];
  mkdirSync(collision, { recursive: true });
  writeFileSync(join(collision, "SKILL.md"), "custom skill");
  for (let retry = 0; retry < 2; retry++) {
    const blocked = await run(["agent", "bootstrap", "--email", "review@example.test", "--json"]);
    assert.notEqual(blocked.code, 0);
    assert.match(JSON.parse(blocked.stdout).error, /fillo skill install --force/);
    progress(blocked.stderr);
  }
  assert.equal(requests.length, 0, "known collisions must not provision previews");
  rmSync(collision, { recursive: true });
  lateCollision = true;
  const late = await run(["agent", "bootstrap", "--email", "review@example.test", "--json"]);
  assert.notEqual(late.code, 0);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(readFileSync(configPath)).pk, "pk_fixture");
  lateCollision = false;
  rmSync(collision, { recursive: true });
  const recovered = await run(["agent", "bootstrap", "--email", "review@example.test", "--json"]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(requests.length, 1, "a later install failure resumes the saved preview");
  assert.equal(JSON.parse(recovered.stdout).pk, "pk_fixture");
  const savedPreview = JSON.parse(readFileSync(configPath));

  // An account connection retires preview metadata; logging out must not let a
  // formerly provisional key be announced as a new preview on the next setup.
  const loggedIn = await run(["login", "--headless", "--json"]);
  assert.equal(loggedIn.code, 0, loggedIn.stderr);
  const accountConfig = JSON.parse(readFileSync(configPath));
  assert.equal(accountConfig.activeContext, "account");
  assert.equal(accountConfig.pk, "pk_fixture", "login preserves the selected project key");
  const previewLogout = await run(["logout"]);
  assert.equal(previewLogout.code, 0, previewLogout.stderr);
  // Older versions kept these caches on login. The context guard also fences
  // persisted configurations written before cache retirement was introduced.
  config({
    ...JSON.parse(readFileSync(configPath)),
    preview: savedPreview.preview,
    provision: savedPreview.provision,
  });
  requests = [];
  const afterLogoutBootstrap = await run([
    "agent",
    "bootstrap",
    "--email",
    "review@example.test",
    "--json",
  ]);
  assert.equal(afterLogoutBootstrap.code, 0, afterLogoutBootstrap.stderr);
  assert.equal(
    requests.filter((request) => request.url === "/api/v1/workspaces/provision").length,
    1,
    "a claimed preview must never be reused after logout",
  );
  assert.equal(accountConfig.preview, undefined);
  assert.equal(accountConfig.provision, undefined);

  // Execute both real config implementations against the same isolated file.
  const cliConfig = compile(join(packageRoot, "src/lib/config.ts"), "cli-config");
  const mcpConfig = compile(join(packageRoot, "../mcp/src/config.ts"), "mcp-config");
  const roundtrip = join(scratch, "roundtrip.mjs");
  writeFileSync(
    roundtrip,
    `
    import assert from 'node:assert/strict';
    import * as cli from ${JSON.stringify(pathToFileURL(cliConfig).href)};
    import * as mcp from ${JSON.stringify(pathToFileURL(mcpConfig).href)};
    const fixture = { token:'fcli_fixture', tokenApi:'https://fillo.so', pk:'pk_fixture', pkApi:'https://fillo.so', claimToken:'fictional_claim', email:'review@example.test', name:'Review', apiKey:'fsk_fixture', apiKeyApi:'https://fillo.so', activeContext:'provisional', provision:{ api:'https://fillo.so', responseCap:100 }, futureSetting:{ enabled:true } };
    cli.writeConfig(fixture); mcp.writeConfig({...mcp.readConfig(), futureMcp:true}); cli.writeConfig({...cli.readConfig(), futureCli:true});
    assert.deepEqual(cli.readConfig(), {...fixture, futureMcp:true, futureCli:true});
    for (const value of ['', '   ', 'https://custom.example///']) { process.env.FILLO_API=value; assert.equal(mcp.apiOrigin(), value.trim() ? 'https://custom.example' : 'https://fillo.so'); }
    process.env.FILLO_API='https://other.example'; assert.equal(mcp.resolveApiKey(), undefined); assert.equal(mcp.resolveAccountToken(), undefined);
  `,
  );
  const roundtripResult = spawnSync(process.execPath, [roundtrip], {
    encoding: "utf8",
    env: { ...cleanEnv, HOME: home, USERPROFILE: home, FILLO_CONFIG_DIR: configDir },
  });
  assert.equal(roundtripResult.status, 0, roundtripResult.stderr);
  const beforeLogout = JSON.parse(readFileSync(configPath));
  const loggedOut = await run(["logout"]);
  assert.equal(loggedOut.code, 0, loggedOut.stderr);
  const afterLogout = JSON.parse(readFileSync(configPath));
  assert.equal(afterLogout.token, undefined);
  assert.equal(afterLogout.tokenApi, undefined);
  for (const [key, value] of Object.entries(beforeLogout))
    if (key !== "token" && key !== "tokenApi") assert.deepEqual(afterLogout[key], value);

  const exportModule = compile(join(packageRoot, "src/lib/export-stream.ts"), "export-stream");
  const { writeExport } = await import(pathToFileURL(exportModule).href);
  const destination = join(scratch, "export.csv");
  writeFileSync(destination, "original");
  let canceled = false;
  const failedBody = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("partial"));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    writeExport(failedBody, destination, { idleMs: 40, totalMs: 5000 }),
    /stopped sending/,
  );
  assert.equal(canceled, true);
  assert.equal(readFileSync(destination, "utf8"), "original");
  assert.equal(
    readdirSync(scratch).some((entry) => entry.includes(".fillo-export-")),
    false,
  );
  const totalBody = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]));
    },
  });
  await assert.rejects(
    writeExport(totalBody, destination, { idleMs: 5000, totalMs: 40 }),
    /aborted/i,
  );
  assert.equal(readFileSync(destination, "utf8"), "original");
  const missing = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  await assert.rejects(writeExport(missing, join(scratch, "missing/out.csv")), /ENOENT/);
  let sent = 0;
  const large = new ReadableStream({
    pull(c) {
      if (sent++ < 256) c.enqueue(new Uint8Array(64 * 1024).fill(65));
      else c.close();
    },
  });
  assert.equal(await writeExport(large, destination), 256 * 64 * 1024);
  assert.equal(readFileSync(destination).length, 256 * 64 * 1024);
  const reset = new ReadableStream({
    pull(c) {
      c.error(new Error("connection reset"));
    },
  });
  await assert.rejects(writeExport(reset, destination), /connection reset/);
  assert.equal(readFileSync(destination).length, 256 * 64 * 1024);
  console.log(
    "product health: staged output, batch validation/recovery, bootstrap/config isolation, atomic bounded exports passed",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
