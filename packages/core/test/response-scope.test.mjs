import test from "node:test";
import assert from "node:assert/strict";
import { createFormController, responseScopeValue } from "../dist/index.js";

test("responseScopeValue: scalar answers key the scope; non-scalar/absent → null (whole form)", () => {
  const s = (f) => ({ responseLimit: { scopeField: f } });
  assert.equal(responseScopeValue({}, { article: "A" }), null, "no scope field → null");
  assert.equal(responseScopeValue(s("article"), { article: "A" }), "A", "string → itself");
  assert.equal(responseScopeValue(s("n"), { n: 5 }), "5", "number → String");
  assert.equal(responseScopeValue(s("n"), { n: 0 }), "0", "falsy zero is a real scope value");
  assert.equal(responseScopeValue(s("article"), { article: "  A  " }), "A", "matches submitted string trimming");
  assert.equal(responseScopeValue(s("article"), { article: "   " }), null, "blank strings are not scopes");
  assert.equal(responseScopeValue(s("n"), { n: Infinity }), null, "non-finite numbers are not scopes");
  assert.equal(responseScopeValue(s("c"), { c: true }), null, "boolean → null (not a bucket)");
  assert.equal(responseScopeValue(s("m"), { m: ["a"] }), null, "array → null");
  assert.equal(responseScopeValue(s("x"), {}), null, "absent answer → null");
});

// browser-limit forms send a PERSISTENT per-visitor key so the server can
// dedupe. With settings.responseLimit.scopeField set, that key must fold in the
// scope field's answer, so a single shared form gives "one response per browser
// PER article" instead of one across the whole site. No localStorage in the
// test runner => the SDK's in-memory submission store persists across
// controllers in this process, which is exactly what a returning visitor's
// browser storage would do.

function makeClient() {
  const keys = [];
  return {
    keys,
    submit: async (_formId, _data, opts) => {
      keys.push(opts?.submissionKey);
      return { ok: true, responseId: `r${keys.length}` };
    },
  };
}

const scopedForm = (id) => ({
  version: 1,
  title: "Rating",
  settings: { responseLimit: { by: "browser", scopeField: "article", onRepeat: "keep" } },
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "rating", kind: "short_text", label: "Rating", required: true },
        { id: "article", kind: "hidden", label: "Article" },
      ],
    },
  ],
});

const unscopedForm = {
  version: 1,
  title: "Rating",
  settings: { responseLimit: { by: "browser", onRepeat: "keep" } },
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "rating", kind: "short_text", label: "Rating", required: true },
        { id: "article", kind: "hidden", label: "Article" },
      ],
    },
  ],
};

const settle = () => new Promise((r) => setTimeout(r, 10));

test("scoped browser limit: different scope values → different visitor keys", async () => {
  const client = makeClient();
  const form = scopedForm();
  const a = createFormController({ form, formId: "scope-keys", client, initialData: { rating: "5", article: "A" } });
  await a.submit();
  const b = createFormController({ form, formId: "scope-keys", client, initialData: { rating: "3", article: "B" } });
  await b.submit();
  const [kA, kB] = client.keys;
  assert.ok(kA && kB, "both submits sent a visitor key");
  assert.notEqual(kA, kB, "article A and article B must not share a per-visitor key");
});

test("scoped browser limit: the already-answered gate is per scope value", async () => {
  const client = makeClient();
  const form = scopedForm();
  const first = createFormController({ form, formId: "scope-gate", client, initialData: { rating: "5", article: "A" } });
  await first.submit();

  const againA = createFormController({ form, formId: "scope-gate", client, initialData: { rating: "5", article: "A" } });
  await settle();
  assert.equal(againA.getState().status, "submitted", "returning to the SAME article shows already-answered");

  const otherB = createFormController({ form, formId: "scope-gate", client, initialData: { rating: "5", article: "B" } });
  await settle();
  assert.equal(otherB.getState().status, "idle", "a DIFFERENT article is still answerable");
});

test("scoped gate honors a URL-prefilled scope value (?article=A)", async () => {
  const client = makeClient();
  const form = scopedForm();
  // Record an answer for article A.
  const a = createFormController({ form, formId: "url-scope", client, initialData: { rating: "5", article: "A" } });
  await a.submit();
  // Return visit where the article arrives via the URL, not initialData.
  globalThis.location = { search: "?article=A" };
  try {
    const back = createFormController({ form, formId: "url-scope", client, initialData: { rating: "5" } });
    await settle();
    assert.equal(back.getState().status, "submitted", "URL-prefilled article A restores the already-answered state");
  } finally {
    delete globalThis.location;
  }
});

test("a whole-form (empty-scope) submit must not block a later URL-scoped article", async () => {
  const client = makeClient();
  const form = scopedForm();
  // Submit with NO article → recorded under the empty-scope bucket.
  const none = createFormController({ form, formId: "url-scope-2", client, initialData: { rating: "5" } });
  await none.submit();
  // Now open ?article=A — the gate must key on article A, not the empty bucket.
  globalThis.location = { search: "?article=A" };
  try {
    const artA = createFormController({ form, formId: "url-scope-2", client, initialData: { rating: "5" } });
    await settle();
    assert.equal(artA.getState().status, "idle", "article A stays answerable despite an empty-scope prior submit");
  } finally {
    delete globalThis.location;
  }
});

test("unscoped browser limit keeps whole-form behavior (field value ignored)", async () => {
  const client = makeClient();
  const first = createFormController({ form: unscopedForm, formId: "noscope-gate", client, initialData: { rating: "5", article: "A" } });
  await first.submit();

  const other = createFormController({ form: unscopedForm, formId: "noscope-gate", client, initialData: { rating: "5", article: "B" } });
  await settle();
  assert.equal(other.getState().status, "submitted", "without a scope field, one answer gates the whole form");
});
