import test from "node:test";
import assert from "node:assert/strict";
import { createFormController, FilloError } from "../dist/index.js";

const onePage = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    { id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }] },
  ],
};

const twoPage = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    { id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }] },
    { id: "p2", blocks: [{ id: "email", kind: "email", label: "Email" }] },
  ],
};

// A block on p1 that only appears once `kind === "bug"`.
const conditional = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "kind", kind: "short_text", label: "Kind" },
        {
          id: "detail",
          kind: "short_text",
          label: "Detail",
          required: true,
          visibleIf: [{ fieldId: "kind", op: "eq", value: "bug" }],
        },
      ],
    },
  ],
};

test("initial snapshot is stable and well-formed", () => {
  const c = createFormController({ form: onePage });
  const a = c.getState();
  assert.equal(a.status, "idle");
  assert.equal(a.pageCount, 1);
  assert.equal(a.isFirstPage, true);
  assert.equal(a.isLastPage, true);
  assert.equal(a.blocks.length, 1);
  assert.equal(c.getState(), a, "getState returns a stable reference until a change");
});

test("setValue updates data, notifies, clears field error", async () => {
  const c = createFormController({ form: onePage });
  let notifications = 0;
  c.subscribe(() => notifications++);
  await c.submit(); // fails required → populates error, stays idle
  assert.equal(c.getState().status, "idle");
  assert.ok(c.getState().errors.name, "required error present");
  c.setValue("name", "Ada");
  assert.equal(c.getState().data.name, "Ada");
  assert.equal(c.getState().errors.name, undefined, "error cleared on change");
  assert.ok(notifications >= 2);
});

test("starting a valid upload clears its stale field error without changing data", async () => {
  const changes = [];
  const uploadRequired = {
    version: 1,
    title: "Upload",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "attachment", kind: "file_upload", label: "Attachment", required: true }],
      },
    ],
  };
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async () => ({ ok: true, responseId: "unexpected" }),
  };
  const c = createFormController({
    form: uploadRequired,
    formId: "f-upload",
    client,
    onChange: (data) => changes.push(data),
  });

  await c.submit();
  assert.ok(c.getState().errors.attachment, "required error is present after submit");

  c.setUploading("attachment", false);
  assert.ok(c.getState().errors.attachment, "an idle notification is not a correction");

  c.setUploading("attachment", true);
  assert.equal(c.getState().errors.attachment, undefined);
  assert.equal(c.getState().uploading, true);
  assert.deepEqual(c.getState().data, {}, "upload start does not invent a completed value");
  assert.equal(changes.length, 0, "upload start does not emit a fake answer change");

  c.setUploading("attachment", false);
  assert.equal(c.getState().uploading, false);
});

test("submit posts through the client and reaches submitted", async () => {
  let received = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      received = data;
      return { ok: true, responseId: "r1" };
    },
  };
  const c = createFormController({ form: onePage, formId: "f1", client });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.deepEqual(received, { name: "Ada" });
});

test("submit captures page context and an existing HubSpot tracking cookie", async () => {
  let meta = null;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    location: { href: "https://product.example/pricing?utm_source=search#plans" },
  };
  globalThis.document = {
    title: "Pricing",
    cookie: "session=ignored; hubspotutk=0123456789abcdef0123456789abcdef",
  };
  try {
    const client = {
      startSession: async () => null,
      reportProgress() {},
      submit: async (_formId, _data, receivedMeta) => {
        meta = receivedMeta;
        return { ok: true, responseId: "r1" };
      },
    };
    const c = createFormController({ form: onePage, formId: "f1", client });
    c.setValue("name", "Ada");
    await c.submit();
    assert.deepEqual(meta.attribution, {
      pageUri: "https://product.example/pricing?utm_source=search",
      pageName: "Pricing",
      hubspotutk: "0123456789abcdef0123456789abcdef",
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("submit with no client is render-only — does not fake success", async () => {
  const c = createFormController({ form: onePage });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "error");
});

test("challenge: token flows into the submit meta when required", async () => {
  let meta = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, _data, m) => {
      meta = m;
      return { ok: true, responseId: "r1" };
    },
  };
  const c = createFormController({
    form: onePage,
    formId: "f1",
    client,
    challengeRequired: true,
    getChallengeToken: () => "solved-token",
  });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.equal(meta.challengeToken, "solved-token");
});

test("challenge: required-but-unsolved blocks the submit (no client call)", async () => {
  let called = false;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async () => {
      called = true;
      return { ok: true, responseId: "r1" };
    },
  };
  const c = createFormController({
    form: onePage,
    formId: "f1",
    client,
    challengeRequired: true,
    getChallengeToken: () => undefined,
    respondentErrorStrings: { challengeIncomplete: "Localized challenge prompt." },
  });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(called, false, "must not fire a submit the server would reject");
  assert.equal(c.getState().status, "idle");
  assert.equal(c.getState().submitError, "Localized challenge prompt.");
});

test("challenge off: no token is attached (degrade)", async () => {
  let meta = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, _data, m) => {
      meta = m;
      return { ok: true, responseId: "r1" };
    },
  };
  const c = createFormController({ form: onePage, formId: "f1", client });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.equal(meta.challengeToken, undefined);
});

test("challenge: a server challenge_failed resets the widget and prompts a retry", async () => {
  let reset = 0;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async () => {
      throw new FilloError("nope", 403, undefined, "challenge_failed");
    },
  };
  const c = createFormController({
    form: onePage,
    formId: "f1",
    client,
    challengeRequired: true,
    getChallengeToken: () => "stale-token",
    onChallengeFailed: () => {
      reset += 1;
    },
    respondentErrorStrings: { challengeRetry: "Localized verification retry." },
  });
  c.setValue("name", "Ada");
  await c.submit(); // must be handled, not thrown
  assert.equal(reset, 1, "widget reset for a fresh token");
  assert.equal(c.getState().status, "idle");
  assert.equal(c.getState().submitError, "Localized verification retry.");
});

test("a throwing onSubmitted handler never reverts Fillo's submitted state", async () => {
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async () => ({ ok: true, responseId: "r1" }),
  };
  const c = createFormController({
    form: onePage,
    formId: "f1",
    client,
    onSubmitted: () => {
      throw new Error("my own API failed");
    },
  });
  c.setValue("name", "Ada");
  await c.submit(); // must not throw out of submit, must stay submitted
  assert.equal(c.getState().status, "submitted");
});

test("multi-page: next validates current page before advancing", () => {
  const c = createFormController({ form: twoPage });
  c.next(); // p1 invalid (name required) → must not advance
  assert.equal(c.getState().pageIndex, 0);
  c.setValue("name", "Ada");
  c.next();
  assert.equal(c.getState().pageIndex, 1);
  assert.equal(c.getState().isLastPage, true);
  c.back();
  assert.equal(c.getState().pageIndex, 0);
});

test("skipValidation only bypasses page navigation, not submit validation", async () => {
  const calls = [];
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      calls.push(data);
      return { ok: true, responseId: "r1" };
    },
  };
  const c = createFormController({ form: twoPage, formId: "f1", client, skipValidation: true });
  c.next();
  assert.equal(c.getState().pageIndex, 1, "preview navigation can advance without required data");

  await c.submit();
  assert.equal(c.getState().status, "idle");
  assert.equal(c.getState().pageIndex, 0, "submit jumps back to the invalid page");
  assert.ok(c.getState().errors.name);
  assert.equal(calls.length, 0, "invalid data is never posted");
});

test("a transportless preview does not require a file its disabled picker cannot upload", async () => {
  const previewForm = {
    version: 1,
    title: "Preview",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "name", kind: "short_text", label: "Name", required: true },
          { id: "attachment", kind: "file_upload", label: "Attachment", required: true },
        ],
      },
    ],
  };
  const c = createFormController({ form: previewForm, skipValidation: true });

  await c.submit();
  assert.equal(c.getState().status, "idle", "answerable required fields still validate");
  assert.ok(c.getState().errors.name);
  assert.equal(
    c.getState().errors.attachment,
    undefined,
    "the disabled preview upload never becomes an impossible required error",
  );

  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted", "the preview can show its local success state");
});

test("conditional logic hides blocks and their validation", async () => {
  const okClient = {
    startSession: async () => null,
    reportProgress() {},
    submit: async () => ({ ok: true, responseId: "r1" }),
  };
  const c = createFormController({ form: conditional, formId: "f1", client: okClient });
  assert.equal(c.getState().blocks.length, 1, "detail hidden until kind === bug");
  await c.submit();
  assert.equal(c.getState().status, "submitted", "hidden required field is not enforced");

  const c2 = createFormController({ form: conditional });
  c2.setValue("kind", "bug");
  assert.equal(c2.getState().blocks.length, 2, "detail now visible");
  await c2.submit();
  assert.equal(c2.getState().status, "idle", "now-visible required field blocks submit");
  assert.ok(c2.getState().errors.detail);
});

test("setContext late-binds the client/formId used at submit", async () => {
  const calls = [];
  const client = {
    submit: async (formId, data) => {
      calls.push({ formId, data });
      return { ok: true, responseId: "r1" };
    },
    startSession: async () => "s1",
    reportProgress: () => {},
  };
  const c = createFormController({ form: onePage }); // created with no formId/client
  c.setContext({ formId: "f1", client });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].formId, "f1");
  assert.deepEqual(calls[0].data, { name: "Ada" });
});

test("setContext({ form }) updates the rendered schema in place (builder preview)", () => {
  const c = createFormController({ form: onePage });
  let notified = 0;
  c.subscribe(() => notified++);
  assert.equal(c.getState().blocks.length, 1);
  // Edit the schema as the builder would — add a field — without remounting.
  const edited = {
    ...onePage,
    pages: [
      {
        id: "p1",
        blocks: [...onePage.pages[0].blocks, { id: "extra", kind: "short_text", label: "Extra" }],
      },
    ],
  };
  c.setContext({ form: edited });
  assert.equal(c.getState().blocks.length, 2, "preview reflects the edited schema");
  assert.ok(notified >= 1, "schema change notifies subscribers");
});

// Page 2 field gated by a page-1 answer that is itself logic-gated — used to
// prove the renderer's page blocks and the submit validator agree.
const crossPage = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "trigger", kind: "short_text", label: "Trigger" },
        {
          id: "controller",
          kind: "short_text",
          label: "Controller",
          visibleIf: [{ fieldId: "trigger", op: "eq", value: "show" }],
        },
      ],
    },
    {
      id: "p2",
      blocks: [
        {
          id: "dependent",
          kind: "short_text",
          label: "Dependent",
          required: true,
          visibleIf: [{ fieldId: "controller", op: "eq", value: "yes" }],
        },
      ],
    },
  ],
};

function okClient(over = {}) {
  return {
    startSession: async () => null,
    reportProgress() {},
    submit: async () => ({ ok: true, responseId: "r1" }),
    ...over,
  };
}

test("cross-page: a logic-hidden controller hides its page-2 dependent in render and submit alike", async () => {
  const c = createFormController({
    form: crossPage,
    formId: "f1",
    client: okClient(),
    initialData: { controller: "yes" }, // stale — trigger isn't "show"
  });
  c.next(); // page 1 has no blocking required field → advance
  assert.equal(c.getState().pageIndex, 1);
  assert.deepEqual(
    c.getState().blocks.map((b) => b.id),
    [],
    "dependent not rendered",
  );
  await c.submit();
  assert.equal(
    c.getState().status,
    "submitted",
    "hidden cross-page required field is not enforced — validatePage agrees with validateResponse",
  );
});

test("cross-page: a genuinely visible controller enforces its page-2 dependent", async () => {
  const c = createFormController({
    form: crossPage,
    formId: "f1",
    client: okClient(),
    initialData: { trigger: "show", controller: "yes" },
  });
  c.next();
  assert.equal(c.getState().pageIndex, 1);
  assert.deepEqual(
    c.getState().blocks.map((b) => b.id),
    ["dependent"],
  );
  await c.submit();
  assert.equal(c.getState().status, "idle", "now-visible required field blocks submit");
  assert.ok(c.getState().errors.dependent);
});

test("a server 422 on a field on another page jumps to that page (never a silent dead button)", async () => {
  const client = okClient({
    submit: async () => ({ ok: false, errors: { name: "Server says invalid" } }),
  });
  const c = createFormController({ form: twoPage, formId: "f1", client });
  c.setValue("name", "Ada"); // passes local validation so submit reaches the server
  c.next();
  assert.equal(c.getState().pageIndex, 1, "on the last page when submitting");
  await c.submit();
  assert.equal(c.getState().status, "idle");
  assert.equal(c.getState().pageIndex, 0, "jumped back to the page showing the rejected field");
  assert.equal(c.getState().errors.name, "Server says invalid");
});

test("a server 422 on a currently-hidden field surfaces a submit error instead of a silent no-op", async () => {
  const client = okClient({
    submit: async () => ({ ok: false, errors: { detail: "Server rejected it" } }),
  });
  // `conditional`: detail is required + hidden until kind === "bug". Left hidden,
  // no page can display the error — the button would otherwise do nothing.
  const c = createFormController({
    form: conditional,
    formId: "f1",
    client,
    respondentErrorStrings: { reviewAnswers: "Localized answer review." },
  });
  await c.submit();
  assert.equal(c.getState().status, "idle");
  assert.equal(c.getState().pageIndex, 0);
  assert.equal(c.getState().submitError, "Localized answer review.");
});

test("a transport failure gives respondents retry guidance without exposing diagnostics", async () => {
  const diagnostic = new Error("fetch failed: browser extension blocked by CSP");
  const client = okClient({
    submit: async () => {
      throw diagnostic;
    },
  });
  const c = createFormController({ form: onePage, formId: "f1", client });
  c.setValue("name", "Ada");

  await assert.rejects(c.submit(), (error) => error === diagnostic);

  assert.equal(c.getState().status, "idle");
  assert.equal(
    c.getState().submitError,
    "Couldn't reach the server — check your connection and try again.",
  );
  assert.doesNotMatch(c.getState().submitError, /CSP|firewall|browser extension/i);
});

test("a verified duplicate submit reaches submitted and flags duplicateSubmission only", async () => {
  const client = okClient({
    submit: async () => ({ ok: true, responseId: "r1", duplicate: true }),
  });
  const c = createFormController({ form: onePage, formId: "f1", client });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.equal(c.getState().duplicateSubmission, true);
  assert.equal(c.getState().updatedSubmission, false);
});

test("an in-place update submit flags updatedSubmission only", async () => {
  const client = okClient({ submit: async () => ({ ok: true, responseId: "r1", updated: true }) });
  const c = createFormController({ form: onePage, formId: "f1", client });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.equal(c.getState().updatedSubmission, true);
  assert.equal(c.getState().duplicateSubmission, false);
});

test("a plain successful submit flags neither duplicate nor updated", async () => {
  const c = createFormController({ form: onePage, formId: "f1", client: okClient() });
  c.setValue("name", "Ada");
  await c.submit();
  assert.equal(c.getState().status, "submitted");
  assert.equal(c.getState().duplicateSubmission, false);
  assert.equal(c.getState().updatedSubmission, false);
});

// ---------- Page jumps + early end (P1 logic depth) ----------

// p1 routes: "skip" → jump past p2 to p3; "stop" → end after p1; else linear.
// p2 holds a required field that a jumped/ended fill must not be forced to answer.
const jumpForm = {
  version: 1,
  title: "Jump",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [{ id: "route", kind: "short_text", label: "Route" }],
      next: [
        { when: [{ fieldId: "route", op: "eq", value: "skip" }], to: "p3" },
        { when: [{ fieldId: "route", op: "eq", value: "stop" }], to: "end" },
      ],
    },
    { id: "p2", blocks: [{ id: "detail", kind: "short_text", label: "Detail", required: true }] },
    { id: "p3", blocks: [{ id: "wrap", kind: "short_text", label: "Wrap" }] },
  ],
};

test("next() follows a jump — skipping the intermediate page", () => {
  const c = createFormController({ form: jumpForm });
  c.setValue("route", "skip");
  c.next();
  assert.equal(c.getState().pageIndex, 2, "jumped straight to p3, skipping p2");
  assert.deepEqual(
    c.getState().blocks.map((b) => b.id),
    ["wrap"],
  );
  assert.equal(c.getState().isLastPage, true, "p3 is terminal");
});

test("next() default-linear when no rule matches", () => {
  const c = createFormController({ form: jumpForm });
  c.setValue("route", "other");
  c.next();
  assert.equal(c.getState().pageIndex, 1, "linear to p2");
  assert.equal(c.getState().isLastPage, false);
});

test("an early-end page is terminal (isLastPage) and next() submits it", async () => {
  const calls = [];
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      calls.push(data);
      return { ok: true, responseId: "r1" };
    },
  };
  const c = createFormController({ form: jumpForm, formId: "f1", client });
  c.setValue("route", "stop");
  assert.equal(c.getState().isLastPage, true, "matched jump→end makes p1 terminal");
  c.next(); // an 'end' outcome submits, exactly like pressing Submit
  // submit() is async; let it settle.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(c.getState().status, "submitted");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { route: "stop" }, "no skipped-page field required or sent");
});

test("a jumped submission validates WITHOUT the skipped page's required field", async () => {
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async () => ({ ok: true, responseId: "r1" }),
  };
  const c = createFormController({ form: jumpForm, formId: "f1", client });
  c.setValue("route", "skip");
  c.next();
  assert.equal(c.getState().pageIndex, 2);
  await c.submit();
  assert.equal(
    c.getState().status,
    "submitted",
    "p2's required detail is not enforced on a jumped fill",
  );
});

test("back() pops the visited stack across a jump (not index-1)", () => {
  const c = createFormController({ form: jumpForm });
  c.setValue("route", "skip");
  c.next();
  assert.equal(c.getState().pageIndex, 2, "on p3 after the jump");
  c.back();
  assert.equal(c.getState().pageIndex, 0, "back returns to p1, the page actually visited (not p2)");
  assert.equal(c.getState().isFirstPage, true);
});

test("linear back() still steps one page (no jumps, regression guard)", () => {
  const c = createFormController({ form: jumpForm });
  c.setValue("route", "other");
  c.next(); // p2
  assert.equal(c.getState().pageIndex, 1);
  c.back();
  assert.equal(c.getState().pageIndex, 0);
});

// A backward jump forms a cycle. Navigation is stateless over the reachable
// sequence, which stops at the revisit — so the pre-revisit page is terminal and
// pressing Next submits, rather than looping forever (liveness, fail-safe).
const cycleForm = {
  version: 1,
  title: "Cycle",
  settings: {},
  pages: [
    { id: "p1", blocks: [{ id: "a", kind: "short_text", label: "A" }] },
    {
      id: "p2",
      blocks: [{ id: "b", kind: "short_text", label: "B" }],
      next: [{ when: [{ fieldId: "b", op: "eq", value: "loop" }], to: "p1" }],
    },
  ],
};

test("a backward-jump cycle never loops — the pre-revisit page is terminal and submit() works", async () => {
  const calls = [];
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      calls.push(data);
      return { ok: true, responseId: "r1" };
    },
  };
  const c = createFormController({ form: cycleForm, formId: "f1", client });
  c.next(); // p1 → p2 (linear)
  assert.equal(c.getState().pageIndex, 1);
  c.setValue("b", "loop"); // p2 would jump back to p1 — a cycle
  assert.equal(c.getState().isLastPage, true, "cycle broken at the revisit → p2 is terminal");
  c.next(); // terminal → submit; must NOT loop back to p1
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(c.getState().status, "submitted");
  assert.equal(c.getState().pageIndex, 1, "stayed put — no infinite backward loop");
  assert.deepEqual(calls, [{ b: "loop" }]);
});

test("failed-submit reposition then back() steps one page earlier on a NO-JUMP form (stateless, regression)", async () => {
  const threePage = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "a", kind: "short_text", label: "A" }] },
      { id: "p2", blocks: [{ id: "b", kind: "short_text", label: "B", required: true }] },
      { id: "p3", blocks: [{ id: "cc", kind: "short_text", label: "C", required: true }] },
    ],
  };
  // Preview-advance (skipValidation) past the unfilled pages to land on p3, then
  // submit: validation still runs and repositions to the first erroring page.
  const c = createFormController({ form: threePage, skipValidation: true });
  c.next(); // p2
  c.next(); // p3
  assert.equal(c.getState().pageIndex, 2);
  await c.submit(); // b & cc required and empty → repositions to the first bad page
  assert.equal(c.getState().status, "idle");
  assert.equal(c.getState().pageIndex, 1, "submit jumped to p2, the first page with an error");
  // With the old visited stack, back() popped a stale entry and stayed on p2.
  // Stateless back() recomputes from the sequence and steps to p1.
  c.back();
  assert.equal(c.getState().pageIndex, 0, "back steps to p1, not a stale stack entry");
});

const HASH = "a".repeat(64);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function draftStub(overrides = {}) {
  return {
    startSession: async () => null,
    reportProgress: () => {},
    submit: async () => ({ ok: true, responseId: "r1" }),
    createDraft: async () => overrides.createDraft ?? { id: "d1", token: "t1" },
    getDraft: async () => {
      if (overrides.getDraft) return overrides.getDraft;
      throw Object.assign(new Error("not found"), { name: "FilloError", status: 404 });
    },
    saveDraft: async () => {},
    deleteDraft: async () => {},
    fetchOwnResponse: async () => null,
  };
}

test("draft resume onto a jumped-to page: back() returns to the source, skipped required field not forced", async () => {
  // Resume lands on p3 (index 2) with route="skip" — the fill that jumps past p2.
  const client = draftStub({
    createDraft: { id: "dj", token: "tj", existing: true },
    getDraft: { data: { route: "skip" }, page: 2 },
  });
  const c = createFormController({
    form: { ...jumpForm, settings: { saveProgress: true } },
    formId: "form-jump-draft-resume",
    client,
    respondent: { id: "u1", hash: HASH },
  });
  await settle();
  await settle();
  assert.equal(c.getState().resumedDraft, true, "draft restored");
  assert.equal(c.getState().pageIndex, 2, "resumed onto the jumped-to page p3");
  // Stateless back() recomputes the sequence [p1, p3] from the resumed answers
  // and returns to p1 (the source), never the skipped p2.
  c.back();
  assert.equal(c.getState().pageIndex, 0, "back lands on p1, the source — not the skipped p2");
  // The skipped page's required `detail` is not enforced on submit.
  await c.submit();
  assert.equal(
    c.getState().status,
    "submitted",
    "p2's required field is not forced on a jumped fill",
  );
});

test("embeds prefill from the page URL (hidden paramName + field id)", async () => {
  const prev = globalThis.location;
  globalThis.location = { search: "?src=tag&name=Ada" };
  try {
    const c = createFormController({
      form: {
        version: 1,
        title: "T",
        settings: {},
        pages: [
          {
            id: "p1",
            blocks: [
              { id: "name", kind: "short_text", label: "Name" },
              { id: "campaign", kind: "hidden", label: "C", paramName: "src" },
            ],
          },
        ],
      },
    });
    await Promise.resolve(); // deferred past hydration
    assert.equal(c.getState().data.campaign, "tag");
    assert.equal(c.getState().data.name, "Ada");
  } finally {
    if (prev === undefined) delete globalThis.location;
    else globalThis.location = prev;
  }
});
