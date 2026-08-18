import test from "node:test";
import assert from "node:assert/strict";
import { createFormController, DEFAULT_STRINGS, FilloError } from "../dist/index.js";

const form = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    { id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }] },
  ],
};

/** Minimal client double — only what submit() touches. */
function fakeClient(submitImpl) {
  return {
    key: "pk_test",
    baseUrl: "",
    submit: submitImpl,
    startSession: async () => null,
    reportProgress: () => {},
  };
}

test("resolveFormId supplies the target at submit time; answers are kept", async () => {
  const submits = [];
  const client = fakeClient(async (formId) => {
    submits.push(formId);
    return { ok: true, responseId: "r1" };
  });
  const c = createFormController({
    form,
    client,
    resolveFormId: async () => "resolved-id",
  });
  c.setValue("name", "Ada");
  await c.submit();
  assert.deepEqual(submits, ["resolved-id"]);
  assert.equal(c.getState().status, "submitted");
});

test("resolver failure keeps answers, sets submitError, and a retry succeeds", async () => {
  let calls = 0;
  const client = fakeClient(async () => ({ ok: true, responseId: "r1" }));
  const c = createFormController({
    form,
    client,
    resolveFormId: async () => {
      calls++;
      if (calls === 1) throw new FilloError("Too many sync requests", 429);
      return "resolved-id";
    },
  });
  c.setValue("name", "Ada");
  await assert.rejects(() => c.submit());
  const failed = c.getState();
  assert.equal(failed.status, "idle");
  assert.equal(failed.data.name, "Ada");
  assert.equal(
    failed.submitError,
    "This form can't submit right now. Please try again in a moment.",
  );
  assert.doesNotMatch(failed.submitError, /sync requests|429/i);

  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.equal(calls, 2);
});

test("a 404 submit failure uses safe unavailable copy; editing clears it", async () => {
  let attempt = 0;
  const client = fakeClient(async () => {
    attempt++;
    if (attempt === 1) throw new FilloError("Form not found — check the form id", 404);
    return { ok: true, responseId: "r1" };
  });
  const c = createFormController({ form, formId: "f1", client });
  c.setValue("name", "Ada");
  await assert.rejects(() => c.submit());
  assert.equal(
    c.getState().submitError,
    "Form not found. Check the link or ask the form owner for help.",
  );
  assert.doesNotMatch(c.getState().submitError, /form id/i);

  c.setValue("name", "Ada L.");
  assert.equal(c.getState().submitError, undefined);
  await c.submit();
  assert.equal(c.getState().status, "submitted");
});

test("status-0 failures give connection retry guidance instead of a bare status", async () => {
  const client = fakeClient(async () => {
    throw new FilloError("Request timed out", 0);
  });
  const c = createFormController({ form, formId: "f1", client });
  c.setValue("name", "Ada");
  await assert.rejects(() => c.submit());
  assert.equal(
    c.getState().submitError,
    "Couldn't reach the server — check your connection and try again.",
  );
  assert.doesNotMatch(c.getState().submitError, /CSP|firewall|browser extension/i);
});

test("server failures use fixed respondent copy instead of internal API prose", async () => {
  const client = fakeClient(async () => {
    throw new FilloError("Submit failed: 500 — inspect server logs for postgres details", 500);
  });
  const c = createFormController({
    form,
    formId: "f1",
    client,
    respondentErrorStrings: { submitFailed: "Localized safe retry copy." },
  });
  c.setValue("name", "Ada");

  await assert.rejects(() => c.submit());

  assert.equal(c.getState().submitError, "Localized safe retry copy.");
  assert.doesNotMatch(c.getState().submitError, /500|server logs|postgres/i);
});

test("4xx submit codes select localized copy without reflecting server prose", async () => {
  let attempt = 0;
  const client = fakeClient(async () => {
    attempt++;
    if (attempt === 1) {
      throw new FilloError("Unknown file reference: bucket/key respondent@example.com", 400);
    }
    throw new FilloError(
      "allowlisted code with malicious bucket/key respondent@example.com prose",
      400,
      undefined,
      "invalid_file_reference",
    );
  });
  const c = createFormController({
    form,
    formId: "f1",
    client,
    respondentErrorStrings: { fileUnavailable: "Localized file recovery copy." },
  });
  c.setValue("name", "Ada");

  await assert.rejects(() => c.submit());
  assert.equal(c.getState().submitError, DEFAULT_STRINGS.submitFailed);
  assert.doesNotMatch(c.getState().submitError, /bucket|key|respondent@example/i);

  await assert.rejects(() => c.submit());
  assert.equal(c.getState().submitError, "Localized file recovery copy.");
  assert.doesNotMatch(c.getState().submitError, /bucket|key|respondent@example/i);
});

test("closed, rate-limit, identity, and scope codes use controller-owned copy", async () => {
  const cases = [
    ["provision_closed", "Owner-only claim instructions", "Closed locally"],
    ["submit_rate_limited", "HTTP gateway limit detail", "Rate limited locally"],
    ["respondent_unrecognized", "identify() integration detail", "Identity locally"],
    ["response_scope_missing", "scopeField implementation detail", "Scope locally"],
  ];
  for (const [code, serverMessage, expected] of cases) {
    const client = fakeClient(async () => {
      throw new FilloError(serverMessage, 422, undefined, code);
    });
    const c = createFormController({
      form,
      formId: "f1",
      client,
      respondentErrorStrings: {
        formClosed: "Closed locally",
        submitRateLimited: "Rate limited locally",
        respondentUnrecognized: "Identity locally",
        scopeMissing: "Scope locally",
      },
    });
    c.setValue("name", "Ada");
    await assert.rejects(() => c.submit());
    assert.equal(c.getState().submitError, expected);
    assert.notEqual(c.getState().submitError, serverMessage);
  }
});

test("setContext updates respondent error copy after a locale change", async () => {
  const client = fakeClient(async () => {
    throw new FilloError("internal 503 detail", 503);
  });
  const c = createFormController({ form, formId: "f1", client });
  c.setContext({ respondentErrorStrings: { submitFailed: "Nouvelle copie sûre." } });
  c.setValue("name", "Ada");

  await assert.rejects(() => c.submit());
  assert.equal(c.getState().submitError, "Nouvelle copie sûre.");
});

test("verboseResolutionErrors surfaces the real resolver failure with its code", async () => {
  const failure = () => {
    throw new FilloError("This form is no longer published.", 403, undefined, "form_not_published");
  };
  const client = fakeClient(async () => ({ ok: true, responseId: "r1" }));

  // Default (respondent-safe): the definitive failure flattens to the fallback.
  const quiet = createFormController({
    form,
    client,
    resolveFormId: async () => failure(),
    respondentErrorStrings: { formUnavailable: "Localized unavailable copy." },
  });
  quiet.setValue("name", "Ada");
  await assert.rejects(() => quiet.submit());
  assert.equal(quiet.getState().submitError, "Localized unavailable copy.");

  // Dev chrome: the real message plus the machine code.
  const verbose = createFormController({
    form,
    client,
    verboseResolutionErrors: true,
    resolveFormId: async () => failure(),
  });
  verbose.setValue("name", "Ada");
  await assert.rejects(() => verbose.submit());
  assert.equal(
    verbose.getState().submitError,
    "This form is no longer published. (form_not_published)",
  );
});

test("verbose mode still explains status-0 transport failures", async () => {
  const c = createFormController({
    form,
    client: fakeClient(async () => ({ ok: true, responseId: "r1" })),
    verboseResolutionErrors: true,
    resolveFormId: async () => {
      throw new FilloError("Request timed out", 0);
    },
  });
  c.setValue("name", "Ada");
  await assert.rejects(() => c.submit());
  assert.equal(
    c.getState().submitError,
    "Couldn't reach the server — check your connection and try again.",
  );
});

test("no resolver + no formId still refuses to fake success", async () => {
  const client = fakeClient(async () => ({ ok: true, responseId: "r1" }));
  const c = createFormController({ form, client });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "error");
});
