import test from "node:test";
import assert from "node:assert/strict";
import { createFormController } from "../dist/index.js";

const HASH = "a".repeat(64);

const saveProgressForm = {
  version: 1,
  title: "T",
  settings: { saveProgress: true },
  pages: [
    {
      id: "p1",
      blocks: [{ id: "name", kind: "short_text", label: "Name" }],
    },
  ],
};

/** Settle the post-hydration microtask + the restore promise chain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function stubClient(overrides = {}) {
  const calls = { createDraft: [], getDraft: [], saveDraft: [], deleteDraft: [] };
  return {
    calls,
    startSession: async () => null,
    reportProgress: () => {},
    createDraft: async (formId, body) => {
      calls.createDraft.push({ formId, body });
      return overrides.createDraft ?? { id: "d1", token: "t1" };
    },
    getDraft: async (id, token) => {
      calls.getDraft.push({ id, token });
      if (overrides.getDraft) return overrides.getDraft;
      throw Object.assign(new Error("not found"), { name: "FilloError", status: 404 });
    },
    saveDraft: async (id, token, body) => {
      calls.saveDraft.push({ id, token, body });
    },
    deleteDraft: async (id, token) => {
      calls.deleteDraft.push({ id, token });
    },
    fetchOwnResponse: async () => overrides.ownResponse ?? null,
  };
}

test("verified affinity: hashed identity picks up its existing draft with no local ref", async () => {
  const client = stubClient({
    createDraft: { id: "d-aff", token: "t-aff", existing: true },
    getDraft: { id: "d-aff", formId: "form-affinity", data: { name: "Ada" }, page: 0 },
  });
  const ctl = createFormController({
    form: saveProgressForm,
    formId: "form-affinity",
    client,
    respondent: { id: "u1", hash: HASH },
  });
  await settle();
  await settle();
  assert.equal(client.calls.createDraft.length, 1);
  assert.deepEqual(client.calls.createDraft[0].body.respondent, { id: "u1", hash: HASH });
  assert.equal(ctl.getState().data.name, "Ada");
  assert.equal(ctl.getState().resumedDraft, true);
  ctl.destroy();
});

test("the affinity-written ref restores through the plain local-ref path next mount", async () => {
  // Same formId as above: the previous test's writeDraftRef left {d-aff, t-aff}
  // in the module's in-memory store (node has no localStorage).
  const client = stubClient({
    getDraft: { id: "d-aff", formId: "form-affinity", data: { name: "Grace" }, page: 0 },
  });
  const ctl = createFormController({
    form: saveProgressForm,
    formId: "form-affinity",
    client,
  });
  await settle();
  await settle();
  assert.equal(client.calls.createDraft.length, 0);
  assert.deepEqual(client.calls.getDraft[0], { id: "d-aff", token: "t-aff" });
  assert.equal(ctl.getState().data.name, "Grace");
  assert.equal(ctl.getState().resumedDraft, true);
  ctl.destroy();
});

test("identity without a hash gets no affinity lookup", async () => {
  const client = stubClient();
  const ctl = createFormController({
    form: saveProgressForm,
    formId: "form-no-hash",
    client,
    respondent: { id: "u2", name: "No Hash" },
  });
  await settle();
  await settle();
  assert.equal(client.calls.createDraft.length, 0);
  assert.equal(ctl.getState().resumedDraft, false);
  ctl.destroy();
});

test("saveProgress off: no draft traffic at all", async () => {
  const client = stubClient();
  const ctl = createFormController({
    form: { ...saveProgressForm, settings: {} },
    formId: "form-off",
    client,
    respondent: { id: "u3", hash: HASH },
  });
  await settle();
  await settle();
  assert.equal(client.calls.createDraft.length, 0);
  assert.equal(client.calls.getDraft.length, 0);
  ctl.destroy();
});

test("upsert prefill: fresh affinity draft falls through to the person's own response", async () => {
  const client = stubClient({
    createDraft: { id: "d-up", token: "t-up" }, // no `existing` → nothing in progress
    ownResponse: { responseId: "r1", data: { name: "Prev" } },
  });
  const ctl = createFormController({
    form: { ...saveProgressForm, settings: { saveProgress: true, responseLimit: { by: "identify", onRepeat: "update" } } },
    formId: "form-upsert",
    client,
    respondent: { id: "u9", hash: HASH },
  });
  await settle();
  await settle();
  await settle();
  assert.equal(ctl.getState().data.name, "Prev");
  assert.equal(ctl.getState().editingPrevious, true);
  assert.equal(ctl.getState().resumedDraft, false);
  ctl.destroy();
});

test("upsert prefill works with drafts off entirely", async () => {
  const client = stubClient({ ownResponse: { responseId: "r2", data: { name: "PrevOff" } } });
  const ctl = createFormController({
    form: { ...saveProgressForm, settings: { responseLimit: { by: "identify", onRepeat: "update" } } },
    formId: "form-upsert-off",
    client,
    respondent: { id: "u10", hash: HASH },
  });
  await settle();
  await settle();
  assert.equal(ctl.getState().data.name, "PrevOff");
  assert.equal(ctl.getState().editingPrevious, true);
  ctl.destroy();
});

test("a spent/expired resume link flags resumeLinkFailed and leaves the form idle", async () => {
  const prevLoc = globalThis.location;
  globalThis.location = { hash: "#fillo-draft=d-gone.tok-gone", pathname: "/", search: "" };
  try {
    const client = stubClient(); // getDraft rejects with a 404 (gone) by default
    const ctl = createFormController({
      form: saveProgressForm,
      formId: "form-resume-gone",
      client,
    });
    await settle();
    await settle();
    assert.equal(ctl.getState().resumeLinkFailed, true, "renderer can explain the blank form");
    assert.equal(ctl.getState().status, "idle");
    assert.equal(ctl.getState().resumedDraft, false);
    // The single-use token was still sent to the (failed) adopt call.
    assert.deepEqual(client.calls.getDraft.at(-1), { id: "d-gone", token: "tok-gone" });
    ctl.destroy();
  } finally {
    if (prevLoc === undefined) delete globalThis.location;
    else globalThis.location = prevLoc;
  }
});
