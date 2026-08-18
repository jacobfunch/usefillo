import test from "node:test";
import assert from "node:assert/strict";
import {
  createId,
  isTerminalPage,
  needsExplicitSubmit,
  normalizeFormSchema,
  prefillFromParams,
  reachableFieldIds,
  reachablePageIds,
  reachablePageSequence,
  resolveNextPage,
  validateField,
  validateResponse,
  visibleFields,
  visiblePageBlocks,
} from "../dist/index.js";

// Page 2's field depends on a page-1 answer that is ITSELF gated by another
// page-1 answer. When the controller is logic-hidden, its stored value must
// read as unanswered form-wide — so the dependent hides on both render and
// submit rather than the client showing a field the server then drops.
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

test("visiblePageBlocks hides a cross-page field when its controller is logic-hidden", () => {
  // controller="yes" is stale: its own page-1 trigger isn't "show", so the
  // whole-form fixpoint treats controller as unanswered and hides dependent.
  const data = { controller: "yes" };
  const p2 = crossPage.pages[1];
  assert.deepEqual(visiblePageBlocks(crossPage, p2, data).map((b) => b.id), []);
  // Render and submit agree — the server (visibleFields/validateResponse) drops it too.
  assert.equal(visibleFields(crossPage, data).some((f) => f.id === "dependent"), false);
  assert.equal(validateResponse(crossPage, data).errors.dependent, undefined);
});

test("visiblePageBlocks shows a cross-page field when its controller is genuinely visible and set", () => {
  const data = { trigger: "show", controller: "yes" };
  const p2 = crossPage.pages[1];
  assert.deepEqual(visiblePageBlocks(crossPage, p2, data).map((b) => b.id), ["dependent"]);
  assert.equal(visibleFields(crossPage, data).some((f) => f.id === "dependent"), true);
});

const numericLogicForm = {
  version: 1,
  title: "T",
  settings: {},
  pages: [{
    id: "p1",
    blocks: [
      { id: "age", kind: "number", label: "Age" },
      {
        id: "adult",
        kind: "short_text",
        label: "Adult detail",
        visibleIf: [{ fieldId: "age", op: "gt", value: 17 }],
      },
    ],
  }],
};

test("numeric conditions work before wire-format strings are normalized", () => {
  assert.deepEqual(visibleFields(numericLogicForm, { age: "18" }).map((field) => field.id), ["age", "adult"]);
  assert.deepEqual(visibleFields(numericLogicForm, { age: "17" }).map((field) => field.id), ["age"]);
  assert.deepEqual(visibleFields(numericLogicForm, { age: "Infinity" }).map((field) => field.id), ["age"]);
});

test("auto-submit keeps a button when no interactive question can trigger it", () => {
  assert.equal(needsExplicitSubmit([]), true);
  assert.equal(needsExplicitSubmit([{ id: "h", kind: "heading", text: "Hello" }]), true);
  assert.equal(
    needsExplicitSubmit([
      { id: "h", kind: "heading", text: "Hello" },
      { id: "vote", kind: "rating", label: "Vote" },
    ]),
    false,
  );
});

test("email/url maxLength and duplicate multi-select answers are enforced", () => {
  assert.match(
    validateField({ id: "e", kind: "email", label: "E", maxLength: 5 }, "a@b.co") ?? "",
    /at most 5/,
  );
  assert.match(
    validateField({ id: "u", kind: "url", label: "U", maxLength: 8 }, "https://example.com") ?? "",
    /at most 8/,
  );
  assert.match(
    validateField({
      id: "m",
      kind: "multi_select",
      label: "M",
      options: [{ id: "x", label: "X" }],
    }, ["x", "x"]) ?? "",
    /only once/,
  );
});

test("URL prefill de-duplicates multi-select values into a valid answer", () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{
      id: "m",
      kind: "multi_select",
      label: "M",
      options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }],
    }] }],
  };
  assert.deepEqual(prefillFromParams(form, { m: "x,x,y" }), { m: ["x", "y"] });
});

test("custom string values remain byte-for-byte owned by the custom component", () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "custom", kind: "custom", component: "raw", label: "Raw" }] }],
  };
  const result = validateResponse(form, { custom: "  padded  " });
  assert.equal(result.ok, true);
  assert.equal(result.data.custom, "  padded  ");
});

test("createId rejects sizes that could return an empty or surprising id", () => {
  assert.throws(() => createId(0), /positive safe integer/);
  assert.throws(() => createId(1.5), /positive safe integer/);
  assert.equal(createId(4).length, 4);
});

// ---------- Page jumps + early end (P1 logic depth) ----------

// p1 branches: "skip" jumps straight past p2 to p3; "end" ends the form after
// p1; anything else falls through to linear (p1 → p2 → p3). p2 carries a
// REQUIRED field that a jumped/ended submission must never be forced to answer.
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
    {
      id: "p2",
      blocks: [{ id: "detail", kind: "short_text", label: "Detail", required: true }],
    },
    {
      id: "p3",
      blocks: [{ id: "wrap", kind: "short_text", label: "Wrap" }],
    },
  ],
};

test("resolveNextPage: first matching rule wins, else linear", () => {
  assert.deepEqual(resolveNextPage(jumpForm, "p1", { route: "skip" }), { to: "p3" });
  assert.deepEqual(resolveNextPage(jumpForm, "p1", { route: "stop" }), { end: true });
  assert.deepEqual(resolveNextPage(jumpForm, "p1", { route: "other" }), { linear: true });
  assert.deepEqual(resolveNextPage(jumpForm, "p1", {}), { linear: true });
  // A page with no `next` is always linear.
  assert.deepEqual(resolveNextPage(jumpForm, "p2", { route: "skip" }), { linear: true });
});

test("reachablePageIds follows the walk: jump skips p2, early-end stops at p1", () => {
  assert.deepEqual([...reachablePageIds(jumpForm, { route: "skip" })], ["p1", "p3"]);
  assert.deepEqual([...reachablePageIds(jumpForm, { route: "stop" })], ["p1"]);
  assert.deepEqual([...reachablePageIds(jumpForm, { route: "other" })], ["p1", "p2", "p3"]);
});

test("validateResponse drops a skipped page's required field on a jump", () => {
  // "skip" jumps past p2 — its required `detail` must NOT be demanded, and any
  // stale answer to it is dropped (same as a logic-hidden field).
  const jumped = validateResponse(jumpForm, { route: "skip", detail: "stale", wrap: "done" });
  assert.equal(jumped.ok, true, "skipped-page required field is not enforced");
  assert.equal(jumped.errors.detail, undefined);
  assert.equal(jumped.data.detail, undefined, "unreachable answer dropped");
  assert.equal(jumped.data.wrap, "done");
  assert.equal(reachableFieldIds(jumpForm, { route: "skip" }).has("detail"), false);
});

test("validateResponse drops both p2 and p3 on early-end", () => {
  const ended = validateResponse(jumpForm, { route: "stop", detail: "x", wrap: "y" });
  assert.equal(ended.ok, true);
  assert.deepEqual(ended.data, { route: "stop" });
});

test("validateResponse still enforces p2 on the linear (no-jump) path", () => {
  const linear = validateResponse(jumpForm, { route: "other", wrap: "z" });
  assert.equal(linear.ok, false, "p2's required detail is enforced when reached");
  assert.ok(linear.errors.detail);
});

test("a form with no jumps validates EXACTLY as today (regression guard)", () => {
  const plain = {
    version: 1,
    title: "Plain",
    settings: {},
    pages: [
      { id: "a", blocks: [{ id: "one", kind: "short_text", label: "One", required: true }] },
      { id: "b", blocks: [{ id: "two", kind: "short_text", label: "Two", required: true }] },
    ],
  };
  // Every page reachable → every required field enforced, exactly like before.
  assert.deepEqual([...reachablePageIds(plain, {})], ["a", "b"]);
  const empty = validateResponse(plain, {});
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.one && empty.errors.two);
  const full = validateResponse(plain, { one: "x", two: "y" });
  assert.equal(full.ok, true);
  assert.deepEqual(full.data, { one: "x", two: "y" });
});

test("normalizeFormSchema keeps valid jumps and drops dangling targets", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "N",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "route", kind: "short_text", label: "Route" }],
        next: [
          { when: [{ fieldId: "route", op: "eq", value: "skip" }], to: "p3" },
          { when: [{ fieldId: "route", op: "eq", value: "gone" }], to: "nope" }, // dangling → dropped
          { when: [{ fieldId: "route", op: "eq", value: "stop" }], to: "end" },
        ],
      },
      { id: "p2", blocks: [{ id: "detail", kind: "short_text", label: "Detail" }] },
      { id: "p3", blocks: [{ id: "wrap", kind: "short_text", label: "Wrap" }] },
    ],
  });
  assert.equal(result.ok, true);
  const p1 = result.schema.pages[0];
  assert.deepEqual(
    p1.next.map((r) => r.to),
    ["p3", "end"],
    "dangling 'nope' target dropped, valid targets kept",
  );
  // A page with no jumps stays free of a `next` key (backward-compatible shape).
  assert.equal("next" in result.schema.pages[1], false);
});

test("normalizeFormSchema drops a jump whose conditions all sanitize away", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "N",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "route", kind: "short_text", label: "Route" }],
        // op is invalid → the only condition is dropped → the whole rule is
        // dropped (fail safe), never promoted to an unconditional always-jump.
        next: [{ when: [{ fieldId: "route", op: "bogus", value: "x" }], to: "end" }],
      },
      { id: "p2", blocks: [{ id: "detail", kind: "short_text", label: "Detail" }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal("next" in result.schema.pages[0], false, "no surviving rules → no next key");
});

test("normalizeFormSchema drops a SELF-jump rule (would loop) → linear", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "N",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "route", kind: "short_text", label: "Route" }],
        next: [
          { when: [{ fieldId: "route", op: "eq", value: "again" }], to: "p1" }, // self → dropped
          { when: [{ fieldId: "route", op: "eq", value: "skip" }], to: "p2" },
        ],
      },
      { id: "p2", blocks: [{ id: "wrap", kind: "short_text", label: "Wrap" }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.schema.pages[0].next.map((r) => r.to),
    ["p2"],
    "self-jump dropped, the forward jump survives",
  );
});

test("normalizeFormSchema drops a jump whose condition references a LATER-page field → linear", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "N",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "route", kind: "short_text", label: "Route" }],
        // `laterField` is answered on p2 (a later page). A jump leaving p1 can't
        // depend on it — the client (answers so far) and server (final data)
        // would disagree about reachability — so the rule is dropped.
        next: [{ when: [{ fieldId: "laterField", op: "eq", value: "x" }], to: "end" }],
      },
      { id: "p2", blocks: [{ id: "laterField", kind: "short_text", label: "Later" }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal("next" in result.schema.pages[0], false, "later-page-field rule dropped → linear");
});

test("normalizeFormSchema keeps a jump that references a SOURCE-page field", () => {
  // The mirror of the drop above: a condition on the source page's own field is
  // an already-given answer, so it must survive (matches the builder's offered
  // condition fields: source-page-and-earlier).
  const result = normalizeFormSchema({
    version: 1,
    title: "N",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "route", kind: "short_text", label: "Route" },
          { id: "same", kind: "short_text", label: "Same page" },
        ],
        next: [{ when: [{ fieldId: "same", op: "answered" }], to: "p2" }],
      },
      { id: "p2", blocks: [{ id: "wrap", kind: "short_text", label: "Wrap" }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.schema.pages[0].next.map((r) => r.to), ["p2"]);
});

test("normalizeFormSchema drops a jump with a NON-ARRAY `when` (never an always-jump)", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "N",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "route", kind: "short_text", label: "Route" }],
        // `when` is an object, not an array — malformed. It must be dropped, not
        // fall through as an unconditional always-jump to p2.
        next: [{ when: { fieldId: "route", op: "eq", value: "x" }, to: "p2" }],
      },
      { id: "p2", blocks: [{ id: "wrap", kind: "short_text", label: "Wrap" }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal("next" in result.schema.pages[0], false, "non-array when dropped → linear");
});

test("reachablePageSequence is [p0…pN] for a no-jump form (linear backward-compat)", () => {
  const plain = {
    version: 1,
    title: "Plain",
    settings: {},
    pages: [
      { id: "a", blocks: [{ id: "one", kind: "short_text", label: "One" }] },
      { id: "b", blocks: [{ id: "two", kind: "short_text", label: "Two" }] },
      { id: "c", blocks: [{ id: "three", kind: "short_text", label: "Three" }] },
    ],
  };
  assert.deepEqual(reachablePageSequence(plain, {}), ["a", "b", "c"]);
  // reachablePageIds is exactly the set of that one walk.
  assert.deepEqual([...reachablePageIds(plain, {})], ["a", "b", "c"]);
});

test("reachablePageSequence terminates on a backward-jump cycle; the pre-revisit page is terminal", () => {
  const normalized = normalizeFormSchema({
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
  }).schema;
  // The backward jump survives normalization (p1 is a real, non-source target on
  // a source-page field), but the walk stops at the revisit rather than looping.
  assert.deepEqual(reachablePageSequence(normalized, { b: "loop" }), ["p1", "p2"]);
  assert.equal(
    isTerminalPage(normalized, "p2", { b: "loop" }),
    true,
    "the pre-revisit page becomes terminal → Submit appears, never an infinite loop",
  );
});
