import assert from "node:assert/strict";
import test from "node:test";
import { createClient, FilloError } from "../dist/index.js";

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(commit) {
  const commits = [],
    completed = [];
  const commitWaiters = [];
  const session = {
    id: "s",
    formId: "f",
    fieldId: "upload",
    fileName: "upload.bin",
    size: 1,
    mime: "application/octet-stream",
    status: "pending",
    uploadedBytes: 0,
    chunkSize: 1,
    token: "fictional",
    transport: {
      type: "box",
      mode: "chunked",
      sessionUrl: "https://box.test/session",
      token: "fictional",
      folderId: "folder",
      fileName: "upload.bin",
      size: 1,
    },
  };
  const client = createClient({
    baseUrl: "https://fillo.test",
    fetch: async (url, init) => {
      if (String(url).includes("/forms/f/uploads")) return json(session);
      if (url === "https://box.test/session")
        return json({
          part_size: 1,
          session_endpoints: {
            upload_part: "https://box.test/part",
            commit: "https://box.test/commit",
          },
        });
      if (url === "https://box.test/part")
        return json({ part: { part_id: "part", offset: 0, size: 1 } });
      if (url === "https://box.test/commit") {
        commits.push(init);
        for (const waiter of commitWaiters) {
          if (commits.length >= waiter.count) waiter.resolve();
        }
        return commit(commits.length, init);
      }
      if (String(url).endsWith("/complete")) {
        completed.push(JSON.parse(init.body));
        return json({
          ...session,
          status: "complete",
          file: { fileId: "file", name: "upload.bin", mime: "application/octet-stream", size: 1 },
        });
      }
      throw new Error(`Unexpected local fixture request: ${url}`);
    },
  });
  return {
    commits,
    completed,
    waitForCommit: (count) =>
      commits.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => commitWaiters.push({ count, resolve })),
    upload: (signal) => client.uploadFile("f", new Blob(["x"]), { fieldId: "upload", signal }),
  };
}

test("Box empty 202 commits honor Retry-After, reuse parts/digest, and finalize exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const f = fixture((attempt) =>
    attempt < 3
      ? new Response(null, { status: 202, headers: { "retry-after": "1" } })
      : json({ entries: [{ id: "box-file" }] }, 201),
  );
  const uploading = f.upload();
  await f.waitForCommit(1);
  await settle();
  assert.equal(f.commits.length, 1);
  assert.equal(f.completed.length, 0);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(f.commits.length, 1);
  t.mock.timers.tick(1);
  await f.waitForCommit(2);
  await settle();
  assert.equal(f.commits.length, 2);
  t.mock.timers.tick(1000);
  await settle();
  await uploading;
  assert.equal(f.commits.length, 3);
  assert.ok(
    f.commits.every(
      (request) =>
        request.body === f.commits[0].body &&
        request.headers.Digest === f.commits[0].headers.Digest,
    ),
  );
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].providerFileId, "box-file");
});

test("Box processing wait is abortable and never finalizes after cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const f = fixture(() => new Response(null, { status: 202, headers: { "retry-after": "120" } }));
  const abort = new AbortController();
  const uploading = f.upload(abort.signal);
  const rejected = assert.rejects(uploading, { name: "AbortError" });
  await f.waitForCommit(1);
  await settle();
  abort.abort();
  await rejected;
  assert.equal(f.commits.length, 1);
  assert.equal(f.completed.length, 0);
});

test("Box processing is bounded even when every commit remains 202", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const f = fixture(() => new Response(null, { status: 202, headers: { "retry-after": "9999" } }));
  const rejected = assert.rejects(
    f.upload(),
    (error) => error instanceof FilloError && /timed out/.test(error.message),
  );
  await f.waitForCommit(1);
  await settle();
  t.mock.timers.tick(600_000);
  await rejected;
  assert.equal(f.commits.length, 1);
  assert.equal(f.completed.length, 0);
});

test("Box permanent commit rejection fails without retry or finalization", async () => {
  const f = fixture(() => new Response(null, { status: 400 }));
  await assert.rejects(f.upload(), (error) => error instanceof FilloError && error.status === 400);
  assert.equal(f.commits.length, 1);
  assert.equal(f.completed.length, 0);
});

test("Box HTTP-date Retry-After delays processing retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const f = fixture((attempt) =>
    attempt === 1
      ? new Response(null, {
          status: 202,
          headers: { "retry-after": new Date(3000).toUTCString() },
        })
      : json({ entries: [{ id: "box-file" }] }, 201),
  );
  const uploading = f.upload();
  await f.waitForCommit(1);
  await settle();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(f.commits.length, 1);
  t.mock.timers.tick(1);
  await uploading;
  assert.equal(f.completed.length, 1);
});

test("Box transient commit failure retries before processing completes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const f = fixture((attempt) =>
    attempt === 1
      ? new Response(null, { status: 503 })
      : json({ entries: [{ id: "box-file" }] }, 201),
  );
  const uploading = f.upload();
  await f.waitForCommit(1);
  await settle();
  t.mock.timers.tick(1000);
  await uploading;
  assert.equal(f.commits.length, 2);
  assert.equal(f.completed.length, 1);
});
