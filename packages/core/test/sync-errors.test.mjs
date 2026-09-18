import test from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  createFormController,
  FilloError,
  syncCodeForm,
} from "../dist/index.js";

const schema = {
  version: 1,
  title: "Contact",
  settings: {},
  pages: [{ id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name" }] }],
};

const codeForm = (id) => ({ id, schema, __filloCodeForm: true });

test("FilloError keeps its positional constructor and adds an optional machine code", () => {
  const existing = new FilloError("Busy", 429, 7);
  assert.equal(existing.status, 429);
  assert.equal(existing.retryAfterSec, 7);
  assert.equal(existing.code, undefined);

  const coded = new FilloError("Use trusted sync", 403, undefined, "trusted_sync_required");
  assert.equal(coded.code, "trusted_sync_required");
});

test("syncForm exposes the server's actionable message, status, retry hint, and code", async () => {
  const message =
    "Schema changes require a trusted server or CLI sync token. Run `fillo forms push`.";
  const client = createClient({
    key: "pk_error_contract",
    baseUrl: "https://api.example.test",
    fetch: async () =>
      Response.json(
        { error: message, code: "trusted_sync_required" },
        { status: 403, headers: { "retry-after": "9" } },
      ),
  });

  await assert.rejects(
    () => client.syncForm("contact", schema),
    (error) => {
      assert.ok(error instanceof FilloError);
      assert.equal(error.message, message);
      assert.equal(error.status, 403);
      assert.equal(error.retryAfterSec, 9);
      assert.equal(error.code, "trusted_sync_required");
      return true;
    },
  );
});

test("sync retry classification retries transient failures but not definitive 4xx", async () => {
  let transientCalls = 0;
  const transientClient = {
    key: "pk_transient_retry_contract",
    baseUrl: "https://transient.example.test",
    syncForm: async () => {
      transientCalls += 1;
      if (transientCalls < 3) throw new FilloError("Busy", 429, 0.001);
      return { formId: "f-transient", slug: "transient", status: "published" };
    },
  };
  const result = await syncCodeForm(transientClient, codeForm("transient-retry"));
  assert.equal(result.formId, "f-transient");
  assert.equal(transientCalls, 3);

  let definitiveCalls = 0;
  const definitiveClient = {
    key: "pk_definitive_retry_contract",
    baseUrl: "https://definitive.example.test",
    syncForm: async () => {
      definitiveCalls += 1;
      throw new FilloError("Use trusted sync", 403, undefined, "trusted_sync_required");
    },
  };
  await assert.rejects(
    () => syncCodeForm(definitiveClient, codeForm("definitive-no-retry")),
    (error) => error.code === "trusted_sync_required",
  );
  assert.equal(definitiveCalls, 1);
});

test("submit-time definitive resolution errors preserve the full error but hide setup details", async () => {
  const failure = new FilloError(
    "Run `fillo forms push` with an fsync token.",
    403,
    undefined,
    "trusted_sync_required",
  );
  let submits = 0;
  const controller = createFormController({
    form: schema,
    formId: "f-cached-before-live-change",
    client: {
      key: "pk_submit_resolution",
      baseUrl: "",
      submit: async () => {
        submits += 1;
        return { ok: true, responseId: "r1" };
      },
      startSession: async () => null,
      reportProgress: () => {},
    },
    resolveFormId: async () => {
      throw failure;
    },
  });

  await assert.rejects(() => controller.submit(), (error) => error === failure);
  assert.equal(controller.getState().submitError, "This form is unavailable.");
  assert.doesNotMatch(controller.getState().submitError, /fillo forms push|fsync/i);
  assert.equal(submits, 0, "a cached form id never bypasses canonical submit-time resolution");
});
