import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for the form-lifecycle commands (pull, unpublish, discard,
 * duplicate, rename, versions, storage set, storage folder): built CLI +
 * scratch HOME + FILLO_API pointed at a stub of the /api/v1/cli/forms/* twins.
 *
 * Locks the things a human or an agent would notice if they broke: the pulled
 * file is one `fillo push` accepts, the outward-facing unpublish refuses to run
 * in agent mode without a bare --confirm (and says what it would do first), the
 * destination words reach the server verbatim, and every command keeps the
 * --json single-document contract.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-lifecycle-"));
const accountToken = "fcli_test_account_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

let api = "";
let requests = [];
let state = {};

const SCHEMA = {
  version: 1,
  title: "Contact",
  pages: [{ id: "p1", blocks: [{ id: "email", kind: "email", label: "Email" }] }],
  settings: { sendReceipt: true },
};

function resetState(overrides = {}) {
  requests = [];
  state = {
    form: {
      id: "f_contact",
      handle: "contact",
      name: "Contact",
      slug: "contact-f_contact",
      status: "published",
      managed: "code",
      staged: true,
      purpose: null,
      storage: "gdrive",
      url: "https://fillo.test/f/contact-f_contact",
      schema: SCHEMA,
      theme: null,
      draftSchema: { ...SCHEMA, title: "Contact (staged)" },
      draftTheme: null,
      settings: SCHEMA.settings,
      revision: "draft",
    },
    formMissing: false,
    unpublish: {
      status: 200,
      body: {
        id: "f_contact",
        name: "Contact",
        slug: "contact-f_contact",
        status: "draft",
        changed: true,
      },
    },
    discard: { status: 200, body: { id: "f_contact", changed: true } },
    duplicate: {
      status: 201,
      body: {
        id: "f_copy",
        name: "Contact (copy)",
        slug: "contact-copy-f_copy",
        status: "draft",
        source: "f_contact",
        url: "https://fillo.test/f/contact-copy-f_copy",
      },
    },
    rename: {
      status: 200,
      body: {
        id: "f_contact",
        name: "Talk to us",
        slug: "talk-to-us-f_contact",
        status: "published",
      },
    },
    versions: {
      status: 200,
      body: {
        data: [
          {
            id: "v2",
            version: 2,
            schemaHash: "0123456789abcdef0123",
            createdAt: "2026-07-02T10:00:00.000Z",
          },
          {
            id: "v1",
            version: 1,
            schemaHash: "fedcba98765432100000",
            createdAt: "2026-07-01T10:00:00.000Z",
          },
        ],
      },
    },
    storage: {
      status: 200,
      body: { destination: "gdrive", storage: { provider: "gdrive" }, resolved: "gdrive" },
    },
    folder: {
      status: 200,
      body: {
        folder: { id: null, name: null },
        folders: [
          { id: "1AbCdEfGhIjKlMnOp", name: "Client uploads" },
          { id: "2QrStUvWxYz012345", name: "Archive" },
        ],
      },
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
  const [a, , c, d] = segs;
  if (a !== "forms") return send(404, { error: "not found" });
  if (state.formMissing) return send(404, { error: "Form not found" });

  if (c === undefined && req.method === "GET") {
    // The real route adds the definition under ?include (draft, or the older
    // `schema` spelling); `fillo status` gets the status envelope alone. Both
    // answer with the form itself, bare, like the `fsk_` twin.
    if (url.searchParams.get("include")) return send(200, state.form);
    const status = { ...state.form, uploadsAvailable: true };
    for (const key of [
      "schema",
      "theme",
      "draftSchema",
      "draftTheme",
      "settings",
      "revision",
      "handle",
      "managed",
    ]) {
      delete status[key];
    }
    return send(200, status);
  }
  if (c === undefined && req.method === "PATCH") {
    return send(state.rename.status, state.rename.body);
  }
  if (c === "unpublish" && req.method === "POST") {
    return send(state.unpublish.status, state.unpublish.body);
  }
  if (c === "discard" && req.method === "POST") {
    return send(state.discard.status, state.discard.body);
  }
  if (c === "duplicate" && req.method === "POST") {
    return send(state.duplicate.status, state.duplicate.body);
  }
  if (c === "versions" && req.method === "GET") {
    return send(state.versions.status, state.versions.body);
  }
  if (c === "storage" && d === undefined) {
    return send(state.storage.status, state.storage.body);
  }
  if (c === "storage" && d === "folder") {
    return send(state.folder.status, state.folder.body);
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
const lastBody = () => JSON.parse(requests.at(-1).body);
const oneJsonDoc = (result) => {
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be exactly one JSON line, got:\n${result.stdout}`);
  return JSON.parse(lines[0]);
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

  // ================= pull =================
  resetState();
  const pullStdout = await runCli(["pull", "contact"]);
  assert.equal(pullStdout.code, 0, pullStdout.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/contact"]);
  assert.deepEqual(requests.at(-1).query, { include: "schema" });
  // Without --out the document IS the output, so `fillo pull f > form.json` works.
  const pulled = JSON.parse(pullStdout.stdout);
  assert.deepEqual(Object.keys(pulled).sort(), ["id", "schema", "storage", "theme"]);
  assert.equal(pulled.id, "contact", "the push handle, not the internal id");
  assert.equal(pulled.schema.title, "Contact (staged)", "the newest editable revision");
  assert.equal(pulled.storage, "gdrive");
  noAnsi(pullStdout);

  resetState();
  const outFile = join(home, "contact.json");
  const pullOut = await runCli(["pull", "contact", "--out", outFile]);
  assert.equal(pullOut.code, 0, pullOut.stderr);
  const written = JSON.parse(readFileSync(outFile, "utf8"));
  assert.equal(written.schema.title, "Contact (staged)");
  assert.match(pullOut.stdout, /Wrote/);
  assert.match(pullOut.stdout, /fillo push/);

  // A dashboard-managed form has no push handle: say that pushing the file
  // would create a SECOND form rather than letting an agent find out later.
  resetState();
  state.form.managed = "builder";
  state.form.handle = null;
  const pullBuilder = await runCli(["pull", "f_contact", "--out", outFile]);
  assert.equal(pullBuilder.code, 0, pullBuilder.stderr);
  assert.match(pullBuilder.stdout, /managed in the dashboard/);
  assert.match(pullBuilder.stdout, /second, code-managed form/);
  assert.equal(JSON.parse(readFileSync(outFile, "utf8")).id, "f_contact");

  resetState();
  const pullJson = await runCli(["pull", "contact", "--json"]);
  assert.equal(pullJson.code, 0, pullJson.stderr);
  const pullDoc = oneJsonDoc(pullJson);
  assert.equal(pullDoc.file, null);
  assert.equal(pullDoc.revision, "draft");
  assert.equal(pullDoc.form.id, "contact");

  resetState();
  const pullBadOut = await runCli(["pull", "contact", "--out", "form.yaml"]);
  assert.notEqual(pullBadOut.code, 0);
  assert.match(pullBadOut.stderr, /--out must be a \.json path/);

  resetState();
  state.formMissing = true;
  const pullMissing = await runCli(["pull", "nope"]);
  assert.notEqual(pullMissing.code, 0);
  assert.match(pullMissing.stderr, /No form matches "nope"/);

  // ================= unpublish (outward-facing) =================
  // Agent mode without --confirm: print what would happen, change nothing.
  resetState();
  const unpublishRefused = await runCli(["unpublish", "contact"], { FILLO_AGENT: "1" });
  assert.notEqual(unpublishRefused.code, 0);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/contact"], "nothing was written");
  assert.match(unpublishRefused.stdout, /takes Contact offline/);
  assert.match(unpublishRefused.stdout, /Recorded responses and files are kept/);
  assert.match(unpublishRefused.stderr, /Refusing to unpublish without confirmation/);
  assert.match(unpublishRefused.stderr, /bare --confirm/);

  // --json is an agent lane too, and its refusal stays one JSON document.
  resetState();
  const unpublishJsonRefused = await runCli(["unpublish", "contact", "--json"]);
  assert.notEqual(unpublishJsonRefused.code, 0);
  assert.match(oneJsonDoc(unpublishJsonRefused).error, /Refusing to unpublish/);
  assert.match(unpublishJsonRefused.stderr, /"status":"notice"/);

  resetState();
  const unpublishOk = await runCli(["unpublish", "contact", "--confirm"], { FILLO_AGENT: "1" });
  assert.equal(unpublishOk.code, 0, unpublishOk.stderr);
  assert.deepEqual(requestPaths(), [
    "GET /api/v1/cli/forms/contact",
    "POST /api/v1/cli/forms/contact/unpublish",
  ]);
  assert.deepEqual(lastBody(), {});
  assert.match(unpublishOk.stdout, /is offline/);
  assert.match(unpublishOk.stdout, /fillo publish f_contact/);
  noAnsi(unpublishOk);

  // A typed --confirm is the DELETE convention; here it must be bare.
  resetState();
  const unpublishTyped = await runCli(["unpublish", "contact", "--confirm", "Contact"], {
    FILLO_AGENT: "1",
  });
  assert.notEqual(unpublishTyped.code, 0);
  assert.match(unpublishTyped.stderr, /--confirm takes no value here/);

  // Already offline: no consent needed for an action that changes nothing.
  resetState();
  state.form.status = "draft";
  const unpublishIdempotent = await runCli(["unpublish", "contact"], { FILLO_AGENT: "1" });
  assert.equal(unpublishIdempotent.code, 0, unpublishIdempotent.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/contact"]);
  assert.match(unpublishIdempotent.stdout, /already offline/);

  // A human at a terminal is the yes: no flag, it just runs. (FILLO_TTY forces
  // the interactive path on under the test's piped stdio.)
  resetState();
  const unpublishHuman = await runCli(["unpublish", "contact"], { FILLO_TTY: "1" });
  assert.equal(unpublishHuman.code, 0, unpublishHuman.stderr);
  assert.deepEqual(requestPaths(), [
    "GET /api/v1/cli/forms/contact",
    "POST /api/v1/cli/forms/contact/unpublish",
  ]);

  // ================= discard =================
  resetState();
  const discard = await runCli(["discard", "contact"]);
  assert.equal(discard.code, 0, discard.stderr);
  assert.deepEqual(requestPaths(), ["POST /api/v1/cli/forms/contact/discard"]);
  assert.match(discard.stdout, /Discarded the staged changes/);

  resetState();
  state.discard.body = { id: "f_contact", changed: false };
  const discardNothing = await runCli(["discard", "contact", "--json"]);
  assert.equal(discardNothing.code, 0, discardNothing.stderr);
  assert.deepEqual(oneJsonDoc(discardNothing), { id: "f_contact", changed: false });

  resetState();
  state.discard = { status: 409, body: { error: "The form's publication state changed." } };
  const discardConflict = await runCli(["discard", "contact"]);
  assert.notEqual(discardConflict.code, 0);
  assert.match(discardConflict.stderr, /publication state changed/);

  // ================= duplicate =================
  resetState();
  const duplicate = await runCli(["duplicate", "contact"]);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.deepEqual(lastBody(), {});
  assert.match(duplicate.stdout, /Created Contact \(copy\)/);
  assert.match(duplicate.stdout, /fillo publish f_copy/);

  resetState();
  const duplicateNamed = await runCli(["duplicate", "contact", "--name", "Contact Q4", "--json"]);
  assert.equal(duplicateNamed.code, 0, duplicateNamed.stderr);
  assert.deepEqual(lastBody(), { name: "Contact Q4" });
  assert.equal(oneJsonDoc(duplicateNamed).form.id, "f_copy");

  // ================= rename =================
  resetState();
  const rename = await runCli(["rename", "contact", "Talk", "to", "us"]);
  assert.equal(rename.code, 0, rename.stderr);
  assert.deepEqual(requestPaths(), ["PATCH /api/v1/cli/forms/contact"]);
  assert.deepEqual(lastBody(), { name: "Talk to us" });
  assert.match(rename.stdout, /Renamed to Talk to us/);
  assert.match(rename.stdout, /links to the old one keep working/);

  resetState();
  const renameMissingName = await runCli(["rename", "contact"]);
  assert.notEqual(renameMissingName.code, 0);
  assert.match(renameMissingName.stderr, /Usage: fillo rename/);
  assert.equal(requests.length, 0);

  // ================= versions =================
  resetState();
  const versions = await runCli(["versions", "contact"]);
  assert.equal(versions.code, 0, versions.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/contact/versions"]);
  assert.match(versions.stdout, /VERSION +PUBLISHED +SCHEMA HASH/);
  assert.match(versions.stdout, /2 +2026-07-02 +0123456789abcdef/);
  noAnsi(versions);

  resetState();
  state.versions.body = { data: [] };
  const versionsEmpty = await runCli(["versions", "contact"]);
  assert.equal(versionsEmpty.code, 0, versionsEmpty.stderr);
  assert.match(versionsEmpty.stdout, /No published versions yet/);

  // ================= storage set =================
  resetState();
  const storageShow = await runCli(["storage", "set", "contact"]);
  assert.equal(storageShow.code, 0, storageShow.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/contact/storage"]);
  assert.match(storageShow.stdout, /Destination: gdrive/);

  resetState();
  state.storage.body = {
    destination: "r2",
    storage: { provider: "s3", variant: "r2" },
    resolved: "s3",
  };
  const storageSet = await runCli(["storage", "set", "contact", "r2"]);
  assert.equal(storageSet.code, 0, storageSet.stderr);
  assert.deepEqual(requestPaths(), ["PUT /api/v1/cli/forms/contact/storage"]);
  assert.deepEqual(lastBody(), { destination: "r2" });
  assert.match(storageSet.stdout, /Uploads for this form go to r2/);

  // Asking for transit where a durable provider is connected is honored as
  // "no per-form choice" — the CLI says what actually happens.
  resetState();
  state.storage.body = { destination: "none", storage: null, resolved: "gdrive" };
  const storageTransit = await runCli(["storage", "set", "contact", "transit"]);
  assert.equal(storageTransit.code, 0, storageTransit.stderr);
  assert.deepEqual(lastBody(), { destination: "transit" });
  assert.match(storageTransit.stdout, /follows the workspace default/);

  resetState();
  const storageBad = await runCli(["storage", "set", "contact", "dropbox"]);
  assert.notEqual(storageBad.code, 0);
  assert.match(storageBad.stderr, /must be one of: gdrive, box, s3, r2, transit, none/);
  assert.equal(requests.length, 0, "an unknown destination never reaches the server");

  resetState();
  state.storage = { status: 409, body: { error: "Box is not connected for this workspace." } };
  const storageConflict = await runCli(["storage", "set", "contact", "box"]);
  assert.notEqual(storageConflict.code, 0);
  assert.match(storageConflict.stderr, /Box is not connected/);

  // ================= storage folder =================
  resetState();
  const folderList = await runCli(["storage", "folder", "contact"]);
  assert.equal(folderList.code, 0, folderList.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/contact/storage/folder"]);
  assert.match(folderList.stdout, /Current folder: automatic/);
  assert.match(folderList.stdout, /Client uploads +1AbCdEfGhIjKlMnOp/);
  noAnsi(folderList);

  resetState();
  const folderSearch = await runCli(["storage", "folder", "contact", "--q", "client"]);
  assert.equal(folderSearch.code, 0, folderSearch.stderr);
  assert.deepEqual(requests.at(-1).query, { q: "client" });

  resetState();
  state.folder.body = { folder: { id: "1AbCdEfGhIjKlMnOp", name: "Client uploads" } };
  const folderSet = await runCli(["storage", "folder", "contact", "--id", "1AbCdEfGhIjKlMnOp"]);
  assert.equal(folderSet.code, 0, folderSet.stderr);
  assert.deepEqual(requestPaths(), ["PUT /api/v1/cli/forms/contact/storage/folder"]);
  assert.deepEqual(lastBody(), { folderId: "1AbCdEfGhIjKlMnOp" });
  assert.match(folderSet.stdout, /Uploads land in Client uploads/);

  resetState();
  state.folder.body = { folder: { id: null, name: null } };
  const folderReset = await runCli(["storage", "folder", "contact", "--reset", "--json"]);
  assert.equal(folderReset.code, 0, folderReset.stderr);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/forms/contact/storage/folder"]);
  assert.deepEqual(oneJsonDoc(folderReset), { folder: { id: null, name: null } });

  resetState();
  const folderBoth = await runCli(["storage", "folder", "contact", "--id", "1Ab", "--reset"]);
  assert.notEqual(folderBoth.code, 0);
  assert.match(folderBoth.stderr, /--id or --reset, not both/);

  // ================= usage guards =================
  for (const args of [["pull"], ["unpublish"], ["discard"], ["duplicate"], ["versions"]]) {
    resetState();
    const usage = await runCli(args);
    assert.notEqual(usage.code, 0, `${args[0]} without a form should fail`);
    assert.match(usage.stderr, new RegExp(`Usage: fillo ${args[0]}`));
    assert.equal(requests.length, 0);
  }

  console.log(
    "form lifecycle (pull/unpublish/discard/duplicate/rename/versions/storage) checks passed",
  );
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
        CI: "true",
        HOME: home,
        USERPROFILE: home,
        FILLO_AGENT: "",
        FILLO_TTY: "",
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
