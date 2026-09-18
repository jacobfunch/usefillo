import assert from "node:assert/strict";
import test from "node:test";

// localStorage shim — Node has none without --experimental-webstorage.
const store = new Map();
const shim = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
try {
  globalThis.localStorage = shim;
} catch {
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
}

const form = {
  id: "contact",
  theme: undefined,
  schema: {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "email", kind: "email", label: "Email" }] }],
  },
  __filloCodeForm: true,
};

const uploadForm = {
  ...form,
  id: "contact-with-upload",
  schema: {
    ...form.schema,
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "email", kind: "email", label: "Email" },
          { id: "attachment", kind: "file_upload", label: "Attachment" },
        ],
      },
    ],
  },
};

function countingClient(result = { formId: "f1", slug: "contact-f1", status: "published" }) {
  const calls = { n: 0 };
  return {
    calls,
    client: {
      key: "pk_test",
      baseUrl: "",
      syncForm: async () => {
        calls.n++;
        return result;
      },
    },
  };
}

// Fresh module instance (fresh session Map) per import — the localStorage
// layer is what carries across "page loads".
let importSeq = 0;
const freshModule = () => import(`../dist/index.js?fresh=${++importSeq}`);

test("a returning visitor's sync is served from localStorage — zero network", async () => {
  const m1 = await freshModule();
  const first = countingClient({
    formId: "f1",
    slug: "contact-f1",
    manageUrl: "https://fillo.so/forms/f1",
    status: "published",
    uploadFileSizeLimitMb: 10,
  });
  const r1 = await m1.syncCodeForm(first.client, form);
  assert.equal(first.calls.n, 1);
  assert.equal(r1.formId, "f1");

  const m2 = await freshModule(); // new "page load": empty session Map
  const second = countingClient();
  const r2 = await m2.syncCodeForm(second.client, form);
  assert.equal(second.calls.n, 0, "served from storage");
  assert.equal(r2.formId, "f1");
  assert.equal(r2.manageUrl, "https://fillo.so/forms/f1");
  assert.equal(r2.status, "published");
  assert.equal(r2.uploadFileSizeLimitMb, 10);
});

test("draft entries expire fast so publishing flips visitors quickly", async () => {
  store.clear();
  const m1 = await freshModule();
  const first = countingClient({ formId: "f2", slug: "s", status: "draft" });
  await m1.syncCodeForm(first.client, form);

  // Age the stored entry past the 60s draft TTL.
  const key = [...store.keys()].find((k) => k.startsWith("fillo:sync:"));
  const entry = JSON.parse(store.get(key));
  entry.ts = Date.now() - 120_000;
  store.set(key, JSON.stringify(entry));

  const m2 = await freshModule();
  const second = countingClient({ formId: "f2", slug: "s", status: "published" });
  const r = await m2.syncCodeForm(second.client, form);
  assert.equal(second.calls.n, 1, "expired draft entry re-syncs");
  assert.equal(r.status, "published");
});

test("bypassCache forces the network even with warm caches", async () => {
  store.clear();
  const m = await freshModule();
  const c = countingClient();
  await m.syncCodeForm(c.client, form);
  assert.equal(c.calls.n, 1);
  await m.syncCodeForm(c.client, form);
  assert.equal(c.calls.n, 1, "session Map dedupes");
  await m.syncCodeForm(c.client, form, { bypassCache: true });
  assert.equal(c.calls.n, 2, "bypass goes to the network");
});

test("a changed schema busts the stored entry", async () => {
  store.clear();
  const m1 = await freshModule();
  const c1 = countingClient();
  await m1.syncCodeForm(c1.client, form);

  const changed = {
    ...form,
    schema: { ...form.schema, title: "T2" },
  };
  const m2 = await freshModule();
  const c2 = countingClient();
  await m2.syncCodeForm(c2.client, changed);
  assert.equal(c2.calls.n, 1, "different content hash → network");
});

test("staged/live-fallback results are never persisted without their safety snapshot", async () => {
  store.clear();
  const staged = {
    formId: "f-staged",
    slug: "staged",
    status: "published",
    staged: true,
    resolvedSchema: form.schema,
    resolvedTheme: null,
  };
  const m1 = await freshModule();
  const first = countingClient(staged);
  await m1.syncCodeForm(first.client, { ...form, id: "staged-cache-safety" });
  assert.equal(first.calls.n, 1);
  assert.equal(
    [...store.keys()].some((key) => key.includes("staged-cache-safety")),
    false,
    "cross-page cache must not drop staged/resolved metadata",
  );

  const m2 = await freshModule();
  const second = countingClient(staged);
  const result = await m2.syncCodeForm(second.client, { ...form, id: "staged-cache-safety" });
  assert.equal(second.calls.n, 1, "next page resolves the canonical snapshot again");
  assert.equal(result.resolvedSchema?.title, form.schema.title);
});

test("a not-accepting verdict is never cached — reopening flips visitors quickly", async () => {
  store.clear();
  const notAccepting = {
    formId: "f-not-accepting",
    slug: "not-accepting",
    status: "published",
    accepting: false,
    acceptingReason: "capped",
  };
  const m1 = await freshModule();
  const first = countingClient(notAccepting);
  await m1.syncCodeForm(first.client, { ...form, id: "not-accepting-cache" });
  assert.equal(first.calls.n, 1);
  assert.equal(
    [...store.keys()].some((key) => key.includes("not-accepting-cache")),
    false,
    "the stored subset drops the verdict and would render a refused form as open",
  );

  // In-memory too: once settled, the volatile verdict is evicted so an SPA
  // remount re-asks the server instead of pinning "not accepting" for an hour.
  await Promise.resolve();
  const second = countingClient(notAccepting);
  await m1.syncCodeForm(second.client, { ...form, id: "not-accepting-cache" });
  assert.equal(second.calls.n, 1, "a remount resolves the verdict again");
});

test("an upload-unavailable verdict is never cached as available", async () => {
  store.clear();
  const unavailable = {
    formId: "f-upload-unavailable",
    slug: "upload-unavailable",
    status: "published",
    accepting: true,
    uploadsAvailable: false,
    uploadFileSizeLimitMb: 10,
  };
  const m1 = await freshModule();
  const first = countingClient(unavailable);
  await m1.syncCodeForm(first.client, { ...form, id: "upload-unavailable-cache" });
  assert.equal(first.calls.n, 1);
  assert.equal(
    [...store.keys()].some((key) => key.includes("upload-unavailable-cache")),
    false,
    "the stored subset must not drop the upload refusal and reopen the control",
  );

  await Promise.resolve();
  const second = countingClient(unavailable);
  await m1.syncCodeForm(second.client, { ...form, id: "upload-unavailable-cache" });
  assert.equal(second.calls.n, 1, "a remount resolves upload availability again");
});

test("an upload form revalidates a previously healthy storage verdict", async () => {
  store.clear();
  const m1 = await freshModule();
  const healthy = countingClient({
    formId: "f-upload-storage-transition",
    slug: "upload-storage-transition",
    status: "published",
    accepting: true,
    uploadsAvailable: true,
  });
  await m1.syncCodeForm(healthy.client, uploadForm);
  assert.equal(healthy.calls.n, 1);
  assert.equal(
    [...store.keys()].some((key) => key.includes("contact-with-upload")),
    false,
    "a healthy upload verdict must not become stale cross-page state",
  );

  // Same-page remounts and new page loads must both ask again. A storage
  // disconnect does not change the schema hash, so ordinary caching would
  // otherwise leave the file picker enabled for up to an hour.
  await Promise.resolve();
  const disconnected = countingClient({
    formId: "f-upload-storage-transition",
    slug: "upload-storage-transition",
    status: "published",
    accepting: true,
    uploadsAvailable: false,
  });
  const samePage = await m1.syncCodeForm(disconnected.client, uploadForm);
  assert.equal(disconnected.calls.n, 1, "same-page remount revalidates storage");
  assert.equal(samePage.uploadsAvailable, false);

  const m2 = await freshModule();
  const nextVisit = countingClient({
    formId: "f-upload-storage-transition",
    slug: "upload-storage-transition",
    status: "published",
    accepting: true,
    uploadsAvailable: false,
  });
  const nextPage = await m2.syncCodeForm(nextVisit.client, uploadForm);
  assert.equal(nextVisit.calls.n, 1, "next page load revalidates storage");
  assert.equal(nextPage.uploadsAvailable, false);
});

test("volatile staged fallback is evicted from the in-memory cache after settling", async () => {
  store.clear();
  const m = await freshModule();
  let calls = 0;
  const client = {
    key: "pk_volatile_memory",
    baseUrl: "https://volatile-memory.test",
    syncForm: async () => {
      calls += 1;
      return calls === 1
        ? {
            formId: "f-volatile",
            slug: "volatile",
            status: "published",
            staged: true,
            resolvedSchema: form.schema,
            resolvedTheme: null,
          }
        : { formId: "f-volatile", slug: "volatile", status: "published", staged: false };
    },
  };
  const volatileForm = { ...form, id: "volatile-memory" };
  const first = await m.syncCodeForm(client, volatileForm);
  assert.equal(first.staged, true);
  // Allow the cache-settlement handler to evict the volatile result.
  await Promise.resolve();
  const second = await m.syncCodeForm(client, volatileForm);
  assert.equal(calls, 2, "SPA remount observes publication without a hard reload");
  assert.equal(second.staged, false);
});

test("in-memory draft entries honor the documented 60-second TTL", async () => {
  store.clear();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const m = await freshModule();
    let calls = 0;
    const client = {
      key: "pk_draft_memory_ttl",
      baseUrl: "https://draft-memory-ttl.test",
      syncForm: async () => {
        calls += 1;
        return {
          formId: "f-draft-memory",
          slug: "draft-memory",
          status: calls === 1 ? "draft" : "published",
        };
      },
    };
    const draftForm = { ...form, id: "draft-memory-ttl" };
    await m.syncCodeForm(client, draftForm);
    await m.syncCodeForm(client, draftForm);
    assert.equal(calls, 1, "fresh in-memory draft dedupes");
    now += 61_000;
    const published = await m.syncCodeForm(client, draftForm);
    assert.equal(calls, 2, "expired in-memory and local entries re-resolve");
    assert.equal(published.status, "published");
  } finally {
    Date.now = originalNow;
  }
});
