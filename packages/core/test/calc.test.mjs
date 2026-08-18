import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCalculated,
  createBlock,
  createFormController,
  evaluateCalc,
  formatAnswer,
  isTerminalPage,
  needsExplicitSubmit,
  normalizeFormSchema,
  prefillFromParams,
  reachablePageIds,
  resolveNextPage,
  resolveText,
  validateField,
  validateResponse,
  visibleFields,
} from "../dist/index.js";

// ---------- Evaluator semantics table ----------

// The evaluator's field resolver in these unit tests is a plain lookup — the
// visibility discipline itself is exercised in the fixpoint tests below.
const over = (data) => (fieldId) => data[fieldId];

test("evaluateCalc: semantics table for every op", () => {
  const data = { a: 6, b: 4, s: "18", pad: " 2.5 ", text: "abc", inf: "Infinity" };
  const cases = [
    // const
    [{ op: "const", value: 5 }, 5],
    [{ op: "const", value: -0.5 }, -0.5],
    [{ op: "const", value: Infinity }, null], // non-finite never leaks
    // value refs: numbers pass, numeric strings bridge EXACTLY like gt/lt
    // conditions (conditionNumber), nothing else coerces
    [{ op: "value", fieldId: "a" }, 6],
    [{ op: "value", fieldId: "s" }, 18],
    [{ op: "value", fieldId: "pad" }, 2.5],
    [{ op: "value", fieldId: "text" }, null],
    [{ op: "value", fieldId: "inf" }, null],
    [{ op: "value", fieldId: "unanswered" }, null],
    // n-ary ops
    [{ op: "add", args: [{ op: "value", fieldId: "a" }, { op: "value", fieldId: "b" }, { op: "const", value: 1 }] }, 11],
    [{ op: "mul", args: [{ op: "value", fieldId: "a" }, { op: "value", fieldId: "b" }] }, 24],
    [{ op: "min", args: [{ op: "value", fieldId: "a" }, { op: "value", fieldId: "b" }] }, 4],
    [{ op: "max", args: [{ op: "value", fieldId: "a" }, { op: "value", fieldId: "b" }] }, 6],
    // binary ops
    [{ op: "sub", left: { op: "value", fieldId: "a" }, right: { op: "value", fieldId: "b" } }, 2],
    [{ op: "div", left: { op: "value", fieldId: "a" }, right: { op: "value", fieldId: "b" } }, 1.5],
    // round: half-away-from-zero, default 0 decimals
    [{ op: "round", arg: { op: "const", value: 2.5 } }, 3],
    [{ op: "round", arg: { op: "const", value: -2.5 } }, -3],
    [{ op: "round", arg: { op: "const", value: 1.25 }, decimals: 1 }, 1.3],
    [{ op: "round", arg: { op: "const", value: -1.25 }, decimals: 1 }, -1.3],
    [{ op: "round", arg: { op: "const", value: 2.4 } }, 2],
    // if: standard condition semantics (AND; empty when = always)
    [{ op: "if", when: [{ fieldId: "a", op: "gt", value: 5 }], then: { op: "const", value: 1 }, else: { op: "const", value: 0 } }, 1],
    [{ op: "if", when: [{ fieldId: "a", op: "lt", value: 5 }], then: { op: "const", value: 1 }, else: { op: "const", value: 0 } }, 0],
    [{ op: "if", when: [], then: { op: "const", value: 7 }, else: { op: "const", value: 0 } }, 7],
    // a null-dependent condition follows existing condition semantics:
    // `answered` on an unanswered ref is simply false → else branch
    [{ op: "if", when: [{ fieldId: "unanswered", op: "answered" }], then: { op: "const", value: 1 }, else: { op: "const", value: 0 } }, 0],
  ];
  for (const [expr, expected] of cases) {
    assert.equal(evaluateCalc(expr, over(data)), expected, JSON.stringify(expr));
  }
});

test("evaluateCalc: strict null propagation — no silent zeros", () => {
  const resolve = over({ a: 6 });
  const missing = { op: "value", fieldId: "unanswered" };
  const someA = { op: "value", fieldId: "a" };
  assert.equal(evaluateCalc({ op: "add", args: [someA, missing] }, resolve), null);
  assert.equal(evaluateCalc({ op: "mul", args: [someA, missing] }, resolve), null);
  assert.equal(evaluateCalc({ op: "min", args: [missing] }, resolve), null);
  assert.equal(evaluateCalc({ op: "sub", left: missing, right: someA }, resolve), null);
  assert.equal(evaluateCalc({ op: "div", left: someA, right: missing }, resolve), null);
  assert.equal(evaluateCalc({ op: "round", arg: missing }, resolve), null);
  // ...and it propagates through nesting
  assert.equal(
    evaluateCalc({ op: "add", args: [{ op: "mul", args: [someA, missing] }, someA] }, resolve),
    null,
  );
});

test("evaluateCalc: division by zero and non-finite results read as null", () => {
  const resolve = over({ zero: 0, big: 1e308 });
  const zero = { op: "value", fieldId: "zero" };
  const big = { op: "value", fieldId: "big" };
  assert.equal(evaluateCalc({ op: "div", left: { op: "const", value: 10 }, right: zero }, resolve), null);
  assert.equal(evaluateCalc({ op: "div", left: zero, right: zero }, resolve), null);
  assert.equal(evaluateCalc({ op: "mul", args: [big, big] }, resolve), null, "overflow to Infinity");
  assert.equal(evaluateCalc({ op: "add", args: [big, big] }, resolve), null);
});

// ---------- Schema normalization + the hard-error catalog ----------

const calcForm = (blocks) => ({
  version: 1,
  title: "Calc",
  settings: {},
  pages: [{ id: "p1", blocks }],
});

const num = (id) => ({ id, kind: "number", label: id });
const calc = (id, calcExpr, extra = {}) => ({
  id,
  kind: "calculated",
  label: id,
  calc: calcExpr,
  ...extra,
});
const ref = (fieldId) => ({ op: "value", fieldId });

test("hard error: a value ref to a missing field, with a fix-it message", () => {
  const result = normalizeFormSchema(calcForm([num("a"), calc("total", ref("gone"))]));
  assert.equal(result.ok, false);
  assert.match(result.error, /Calculated field total references a missing field: gone/);
  assert.match(result.error, /remove the reference or restore that field/);
});

test("hard error: a value ref to a non-numeric kind, naming the kind", () => {
  const result = normalizeFormSchema(
    calcForm([{ id: "name", kind: "short_text", label: "Name" }, calc("total", ref("name"))]),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /references non-numeric field name \(short_text\)/);
  assert.match(result.error, /number, rating, linear_scale, and calculated fields only/);
});

test("hard error: self-reference is a cycle", () => {
  const result = normalizeFormSchema(calcForm([calc("total", ref("total"))]));
  assert.equal(result.ok, false);
  assert.match(result.error, /Calculated field total depends on its own result \(total → total\)/);
  assert.match(result.error, /break the cycle/);
});

test("hard error: a chained reference cycle through another calculated field", () => {
  const result = normalizeFormSchema(
    calcForm([calc("x", { op: "add", args: [ref("y"), { op: "const", value: 1 }] }), calc("y", ref("x"))]),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /depends on its own result \(x → y → x\)/);
});

test("hard error: a cycle hidden inside if/round/args nesting (including if.when)", () => {
  // The self-dependence is buried: round(if(when reads x, …)) inside args.
  const result = normalizeFormSchema(
    calcForm([
      num("a"),
      calc("x", {
        op: "add",
        args: [
          {
            op: "round",
            arg: {
              op: "if",
              when: [{ fieldId: "x", op: "gt", value: 5 }],
              then: ref("a"),
              else: { op: "const", value: 0 },
            },
          },
        ],
      }),
    ]),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /depends on its own result/);
});

test("hard error: malformed calc nodes never silently degrade", () => {
  const malformed = [
    undefined, // calc missing entirely
    { op: "pow", left: ref("a"), right: ref("a") }, // unknown op
    { op: "add", args: [] }, // empty n-ary
    { op: "add", args: "nope" }, // non-array args
    { op: "const", value: "5" }, // non-numeric const
    { op: "value", fieldId: "" }, // blank ref
    { op: "sub", left: ref("a") }, // missing operand
    { op: "if", when: { fieldId: "a", op: "gt", value: 1 }, then: ref("a"), else: ref("a") }, // non-array when
    { op: "if", when: [{ fieldId: "a", op: "bogus" }], then: ref("a"), else: ref("a") }, // condition that sanitizes away
  ];
  for (const bad of malformed) {
    const result = normalizeFormSchema(calcForm([num("a"), calc("total", bad)]));
    assert.equal(result.ok, false, `must reject: ${JSON.stringify(bad)}`);
    assert.match(
      result.error,
      /Field total has a malformed calc expression — build it from value\/const\/add\/sub\/mul\/div\/min\/max\/round\/if nodes/,
    );
  }
});

test("normalization: required is forced off, decimals clamp to 0–6, prefix/suffix cap", () => {
  const result = normalizeFormSchema(
    calcForm([
      num("a"),
      calc("total", { op: "round", arg: ref("a"), decimals: 99 }, {
        required: true,
        decimals: 9.7,
        prefix: "$".repeat(500),
        suffix: " kg",
      }),
    ]),
  );
  assert.equal(result.ok, true, result.error);
  const block = result.schema.pages[0].blocks[1];
  assert.equal(block.required, false, "a derived value can never be required");
  assert.equal(block.decimals, 6);
  assert.equal(block.calc.decimals, 6, "round decimals clamp too");
  assert.equal(block.prefix.length, 100);
  // Affixes keep edge spacing (2026-07-19 refinement): ` kg` renders "3 kg".
  assert.equal(block.suffix, " kg");
});

test("createBlock('calculated') is valid as freshly added (const 0, never an empty add)", () => {
  const block = createBlock("calculated");
  assert.deepEqual(block.calc, { op: "const", value: 0 });
  const result = normalizeFormSchema(calcForm([block]));
  assert.equal(result.ok, true, result.error);
});

// ---------- The shared fixpoint: calc ⇄ visibility ⇄ jumps ----------

test("fixpoint: a calc value drives visibility, which drives another calc", () => {
  const form = normalizeFormSchema({
    version: 1,
    title: "Chain",
    settings: {},
    pages: [{
      id: "p1",
      blocks: [
        num("a"),
        calc("calcA", { op: "add", args: [ref("a"), { op: "const", value: 0 }] }),
        // b only exists once calcA exceeds 5…
        { id: "b", kind: "number", label: "b", visibleIf: [{ fieldId: "calcA", op: "gt", value: 5 }] },
        // …and calcB reads b through the same visibility discipline.
        calc("calcB", { op: "mul", args: [ref("b"), { op: "const", value: 2 }] }),
      ],
    }],
  }).schema;

  const shown = computeCalculated(form, { a: 10, b: 4 });
  assert.equal(shown.calcA, 10);
  assert.equal(shown.calcB, 8);
  assert.deepEqual(visibleFields(form, { a: 10, b: 4 }).map((f) => f.id), ["a", "calcA", "b", "calcB"]);

  // a=1 hides b, so its stale answer reads as unanswered → calcB nulls out.
  const hidden = computeCalculated(form, { a: 1, b: 4 });
  assert.equal(hidden.calcA, 1);
  assert.equal(hidden.calcB, undefined, "null result = key absent (unanswered)");
  assert.equal(visibleFields(form, { a: 1, b: 4 }).some((f) => f.id === "b"), false);
});

test("fixpoint: a logic-hidden source nulls out a whole calc chain", () => {
  const form = normalizeFormSchema({
    version: 1,
    title: "Chain",
    settings: {},
    pages: [{
      id: "p1",
      blocks: [
        { id: "trigger", kind: "short_text", label: "T" },
        { id: "src", kind: "number", label: "S", visibleIf: [{ fieldId: "trigger", op: "eq", value: "show" }] },
        calc("c1", { op: "mul", args: [ref("src"), { op: "const", value: 1 }] }),
        calc("c2", { op: "add", args: [ref("c1"), { op: "const", value: 1 }] }),
      ],
    }],
  }).schema;

  const live = computeCalculated(form, { trigger: "show", src: 4 });
  assert.equal(live.c1, 4);
  assert.equal(live.c2, 5);

  // trigger flips away: src's stale answer must read unanswered form-wide.
  const stale = computeCalculated(form, { trigger: "hide", src: 4 });
  assert.equal(stale.c1, undefined);
  assert.equal(stale.c2, undefined);
});

test("fixpoint: a logic-hidden CALCULATED field reads as unanswered (key absent)", () => {
  const form = normalizeFormSchema({
    version: 1,
    title: "HiddenCalc",
    settings: {},
    pages: [{
      id: "p1",
      blocks: [
        num("a"),
        {
          ...calc("total", ref("a")),
          visibleIf: [{ fieldId: "a", op: "gt", value: 100 }],
        },
      ],
    }],
  }).schema;
  assert.equal(computeCalculated(form, { a: 5 }).total, undefined, "hidden calc = unanswered");
  assert.equal(computeCalculated(form, { a: 500 }).total, 500);
});

test("fixpoint: a client-forged value under a calculated id is ignored by the engine", () => {
  const form = normalizeFormSchema(
    calcForm([
      num("a"),
      calc("total", ref("a")),
      { id: "vip", kind: "short_text", label: "V", visibleIf: [{ fieldId: "total", op: "gt", value: 100 }] },
    ]),
  ).schema;
  // The forged total=999 must not reveal vip: the resolver never reads raw
  // data for a calculated id.
  assert.equal(visibleFields(form, { a: 1, total: 999 }).some((f) => f.id === "vip"), false);
  assert.equal(computeCalculated(form, { a: 1, total: 999 }).total, 1);
});

const jumpCalcForm = normalizeFormSchema({
  version: 1,
  title: "JumpCalc",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        num("qty"),
        calc("total", { op: "mul", args: [ref("qty"), { op: "const", value: 5 }] }),
      ],
      next: [{ when: [{ fieldId: "total", op: "gt", value: 20 }], to: "end" }],
    },
    { id: "p2", blocks: [{ id: "detail", kind: "short_text", label: "D", required: true }] },
  ],
}).schema;

test("fixpoint: jump rules read calculated values (resolveNextPage/reachable*/isTerminalPage)", () => {
  // qty=10 → total=50 → the p1 rule ends the form; p2 is unreachable.
  assert.deepEqual(resolveNextPage(jumpCalcForm, "p1", { qty: 10 }), { end: true });
  assert.deepEqual([...reachablePageIds(jumpCalcForm, { qty: 10 })], ["p1"]);
  assert.equal(isTerminalPage(jumpCalcForm, "p1", { qty: 10 }), true);
  // qty=2 → total=10 → linear; p2's required field is enforced.
  assert.deepEqual(resolveNextPage(jumpCalcForm, "p1", { qty: 2 }), { linear: true });
  assert.equal(isTerminalPage(jumpCalcForm, "p1", { qty: 2 }), false);
  const linear = validateResponse(jumpCalcForm, { qty: 2 });
  assert.equal(linear.ok, false);
  assert.ok(linear.errors.detail);
  // …and the jumped fill never demands it.
  assert.equal(validateResponse(jumpCalcForm, { qty: 10 }).ok, true);
});

// ---------- Client/server parity: the canonical evaluation input ----------
// The contract: identical evaluation on both sides — a source that is
// logic-hidden OR UNREACHABLE reads as unanswered, over the value shape the
// server keeps. `serverStored` below runs the submit route's exact pipeline
// (validateResponse → computeCalculated); every test pins client === server.

const serverStored = (form, wire) => {
  const result = validateResponse(form, wire);
  assert.equal(result.ok, true, "parity fixtures must be submittable");
  return computeCalculated(form, result.data);
};

const backNavForm = normalizeFormSchema({
  version: 1,
  title: "BackNav",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [{
        id: "mode", kind: "select", label: "Mode",
        options: [{ id: "std", label: "Standard" }, { id: "exp", label: "Express" }],
      }],
      next: [{ when: [{ fieldId: "mode", op: "eq", value: "exp" }], to: "p3" }],
    },
    { id: "p2", blocks: [num("qty")] },
    {
      id: "p3",
      blocks: [calc("total", { op: "mul", args: [ref("qty"), { op: "const", value: 10 }] })],
    },
  ],
}).schema;

test("reachability: an answer behind a flipped jump reads as unanswered (client === server)", () => {
  // Linear path: qty reachable, total computes on both sides.
  assert.equal(computeCalculated(backNavForm, { mode: "std", qty: 5 }).total, 50);
  assert.equal(serverStored(backNavForm, { mode: "std", qty: 5 }).total, 50);
  // Back-navigation repro: the respondent answered qty, went back, flipped
  // mode to "exp" — p2 is now jump-skipped, so its qty must read UNANSWERED
  // on the client exactly as validateResponse drops it on the server.
  const flipped = { mode: "exp", qty: 5 };
  const live = computeCalculated(backNavForm, flipped);
  assert.equal("total" in live, false, "client must not pipe a total from an unreachable qty");
  assert.equal("total" in serverStored(backNavForm, flipped), false);
  // The raw answer itself survives client-side (evaluation input only), so
  // flipping back to the linear path restores it without re-typing.
  assert.equal(live.qty, 5);
});

test("controller: back-navigated jump flip recomputes to the server-stored value", () => {
  const c = createFormController({ form: backNavForm });
  c.setValue("mode", "std");
  c.setValue("qty", 5);
  assert.equal(c.getState().data.total, 50);
  c.setValue("mode", "exp"); // p2 now jump-skipped — its answer is unreachable
  const state = c.getState();
  assert.equal(state.data.total, undefined, "display/piping shows unanswered, like the server");
  assert.equal(state.data.qty, 5, "the answer is kept for a flip back");
  assert.deepEqual(
    Object.entries(serverStored(backNavForm, state.data)).filter(([k]) => k === "total"),
    [],
    "what the controller shows is what the server stores",
  );
  c.setValue("mode", "std"); // flip back — the kept answer feeds the calc again
  assert.equal(c.getState().data.total, 50);
});

test("a calculated field on an unreachable page is unanswered client-side too", () => {
  // total < 100 ends the form on p1, so p2's chained calc must not appear in
  // the client's data either (it was already dropped from stored data).
  const form = normalizeFormSchema({
    version: 1,
    title: "SkipCalc",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [num("qty"), calc("total", { op: "mul", args: [ref("qty"), { op: "const", value: 4 }] })],
        next: [{ when: [{ fieldId: "total", op: "lt", value: 100 }], to: "end" }],
      },
      { id: "p2", blocks: [calc("bonus", { op: "mul", args: [ref("total"), { op: "const", value: 0.1 }] })] },
    ],
  }).schema;
  const small = computeCalculated(form, { qty: 3 });
  assert.equal(small.total, 12);
  assert.equal("bonus" in small, false, "jump-skipped calc = unanswered");
  assert.equal("bonus" in serverStored(form, { qty: 3 }), false);
  const large = computeCalculated(form, { qty: 30 });
  assert.equal(large.total, 120);
  assert.equal(large.bonus, 12);
});

test("canonical values: checkbox false and padded strings resolve identically (client === server)", () => {
  const form = normalizeFormSchema({
    version: 1,
    title: "Canon",
    settings: {},
    pages: [{
      id: "p1",
      blocks: [
        { id: "member", kind: "checkbox", label: "Member" },
        { id: "tier", kind: "short_text", label: "Tier" },
        calc("fee", {
          op: "if",
          when: [{ fieldId: "member", op: "eq", value: false }],
          then: { op: "const", value: 10 },
          else: { op: "const", value: 0 },
        }),
        calc("price", {
          op: "if",
          when: [{ fieldId: "tier", op: "eq", value: "vip" }],
          then: { op: "const", value: 20 },
          else: { op: "const", value: 0 },
        }),
      ],
    }],
  }).schema;
  // An unchecked checkbox is EMPTY in stored data (isEmpty drops false), so
  // `eq false` can never match there — the live engine must agree, not show a
  // fee the stored response won't carry.
  const unchecked = { member: false, tier: "vip " };
  assert.equal(computeCalculated(form, unchecked).fee, 0);
  assert.equal(serverStored(form, unchecked).fee, 0);
  // A padded "vip " is trimmed in stored data; the live engine trims too.
  assert.equal(computeCalculated(form, unchecked).price, 20);
  assert.equal(serverStored(form, unchecked).price, 20);
  // Checked member: present on both sides, `eq false` still no → 0.
  assert.equal(computeCalculated(form, { member: true }).fee, 0);
  assert.equal(serverStored(form, { member: true }).fee, 0);
});

test("the reachability prune cascades deterministically to the same fixed point", () => {
  // Pruning the skipped page's answer hides a dependent field, which in turn
  // un-fires the jump that skipped it — the joint iteration must settle (the
  // view only ever shrinks) and land where the server lands.
  const form = normalizeFormSchema({
    version: 1,
    title: "Cascade",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "a", kind: "short_text", label: "A", visibleIf: [{ fieldId: "late", op: "answered" }] },
          calc("score", {
            op: "if",
            when: [{ fieldId: "a", op: "answered" }],
            then: { op: "const", value: 1 },
            else: { op: "const", value: 0 },
          }),
        ],
        next: [{ when: [{ fieldId: "a", op: "eq", value: "x" }], to: "end" }],
      },
      { id: "p2", blocks: [{ id: "late", kind: "short_text", label: "Late" }] },
    ],
  }).schema;
  const wire = { a: "x", late: "y" };
  assert.equal(computeCalculated(form, wire).score, 0);
  assert.equal(serverStored(form, wire).score, 0);
});

// ---------- Jump rules may not depend on later-page answers through a calc ----------

test("normalization drops a jump conditioned on a calc that reads a LATER page", () => {
  // The finding-2 repro: p1 jumps on c, but c's value ref reads p3's field —
  // filling `late` would fire the p1 jump retroactively and silently drop the
  // answered required `mid`. The rule must fall back to linear (the
  // later-page-field precedent), keeping `mid` enforced.
  const result = normalizeFormSchema({
    version: 1,
    title: "LateCalc",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [num("a"), calc("c", ref("late"))],
        next: [{ when: [{ fieldId: "c", op: "gt", value: 10 }], to: "end" }],
      },
      { id: "p2", blocks: [{ id: "mid", kind: "short_text", label: "Mid", required: true }] },
      { id: "p3", blocks: [num("late")] },
    ],
  });
  assert.equal(result.ok, true, result.error);
  assert.equal("next" in result.schema.pages[0], false, "calc-on-later-page rule dropped → linear");
  const filled = validateResponse(result.schema, { a: 1, late: 50 });
  assert.equal(filled.ok, false, "linear flow keeps p2's required mid enforced");
  assert.ok(filled.errors.mid);
});

test("the transitive check walks calc chains and if.when refs, not just value refs", () => {
  const pages = (firstPageBlocks) => ({
    version: 1,
    title: "Chain",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: firstPageBlocks,
        next: [{ when: [{ fieldId: "gate", op: "gt", value: 0 }], to: "end" }],
      },
      { id: "p2", blocks: [{ id: "mid", kind: "short_text", label: "Mid" }] },
      { id: "p3", blocks: [num("late")] },
    ],
  });
  // gate → inner → late: the later-page dependency is two hops away.
  const chained = normalizeFormSchema(
    pages([num("a"), calc("inner", ref("late")), calc("gate", { op: "add", args: [ref("inner"), { op: "const", value: 1 }] })]),
  );
  assert.equal(chained.ok, true, chained.error);
  assert.equal("next" in chained.schema.pages[0], false, "chained later-page ref dropped");
  // gate's VALUE refs are fine but its if.when reads the later page.
  const whenRef = normalizeFormSchema(
    pages([num("a"), calc("gate", {
      op: "if",
      when: [{ fieldId: "late", op: "answered" }],
      then: ref("a"),
      else: { op: "const", value: 0 },
    })]),
  );
  assert.equal(whenRef.ok, true, whenRef.error);
  assert.equal("next" in whenRef.schema.pages[0], false, "if.when later-page ref dropped");
});

test("a jump on a calc whose sources are all on the source page or earlier is kept", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "OkCalc",
    settings: {},
    pages: [
      { id: "p0", blocks: [num("base")] },
      {
        id: "p1",
        blocks: [num("a"), calc("gate", { op: "add", args: [ref("a"), ref("base")] })],
        next: [{ when: [{ fieldId: "gate", op: "gt", value: 10 }], to: "end" }],
      },
      { id: "p2", blocks: [{ id: "mid", kind: "short_text", label: "Mid", required: true }] },
    ],
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.schema.pages[1].next, [
    { when: [{ fieldId: "gate", op: "gt", value: 10 }], to: "end" },
  ]);
  // …and a constant-only calc depends on nothing, so it may gate any jump.
  const constant = normalizeFormSchema({
    version: 1,
    title: "ConstCalc",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [num("a")],
        next: [{ when: [{ fieldId: "k", op: "gt", value: 0 }], to: "end" }],
      },
      { id: "p2", blocks: [calc("k", { op: "const", value: 1 })] },
    ],
  });
  assert.equal(constant.ok, true, constant.error);
  assert.equal(Array.isArray(constant.schema.pages[0].next), true, "const calc rule kept");
});

// ---------- validateResponse: the tamper rule ----------

test("validateResponse drops client-sent calculated values and never 422s on them", () => {
  const form = normalizeFormSchema(calcForm([num("a"), calc("total", ref("a"))])).schema;
  const result = validateResponse(form, { a: 2, total: "12345 tampered" });
  assert.equal(result.ok, true, "a forged calc value must not 422");
  assert.equal(result.errors.total, undefined);
  assert.deepEqual(result.data, { a: 2 }, "calc ids are excluded from the kept set");
});

test("required-missing can never trigger for a calculated field", () => {
  // Even unnormalized (required: true survives nowhere after normalization,
  // but validateField is a public API) an empty computed value is fine.
  const field = { id: "t", kind: "calculated", label: "T", required: true, calc: { op: "const", value: 0 } };
  assert.equal(validateField(field, undefined), null);
  assert.equal(validateField(field, 12), null);
});

// ---------- formatAnswer: decimals / prefix / suffix ----------

test("formatAnswer renders a calculated number honoring decimals/prefix/suffix", () => {
  const field = { id: "t", kind: "calculated", label: "T", calc: { op: "const", value: 0 } };
  assert.equal(formatAnswer(field, 12.5), "12.5");
  assert.equal(formatAnswer({ ...field, decimals: 2 }, 12.5), "12.50", "toFixed pads the display");
  assert.equal(formatAnswer({ ...field, prefix: "$", decimals: 2 }, 12.5), "$12.50");
  assert.equal(formatAnswer({ ...field, suffix: " kg" }, 3), "3 kg");
  assert.equal(formatAnswer(field, undefined), "", "unanswered renders empty");
});

// ---------- formatAnswer: number (decimals/prefix/suffix, never grouped) ----------

test("formatAnswer renders a number field honoring decimals/prefix/suffix, never grouped", () => {
  const field = { id: "n", kind: "number", label: "N" };
  assert.equal(formatAnswer(field, 6), "6", "plain value unchanged");
  assert.equal(formatAnswer({ ...field, decimals: 2 }, 6), "6.00", "decimals pads the display");
  assert.equal(formatAnswer({ ...field, prefix: "$", decimals: 2 }, 12.5), "$12.50");
  assert.equal(formatAnswer({ ...field, suffix: " kg" }, 3), "3 kg");
  assert.equal(formatAnswer({ ...field, prefix: "$", suffix: " USD" }, 42), "$42 USD");
  assert.equal(formatAnswer(field, undefined), "", "unanswered renders empty");
  assert.equal(formatAnswer(field, "not-a-number"), "not-a-number", "kind-reuse fail-soft guard");
  // Decision 4: the server has no respondent locale, so number formatting is
  // NEVER grouped, even for a value that would clearly benefit from it.
  assert.equal(formatAnswer(field, 1234567), "1234567", "never grouped");
  assert.equal(formatAnswer({ ...field, decimals: 2 }, 1234567), "1234567.00", "never grouped, even padded");
});

// ---------- URL prefill + auto-submit exclusions ----------

test("a calculated field is never prefilled from the URL", () => {
  const form = normalizeFormSchema(calcForm([num("a"), calc("total", ref("a"))])).schema;
  assert.deepEqual(prefillFromParams(form, { a: "3", total: "999" }), { a: 3 });
});

test("auto-submit ignores calculated fields when counting interactive questions", () => {
  const rating = { id: "vote", kind: "rating", label: "Vote" };
  const calcRow = { id: "t", kind: "calculated", label: "T", calc: { op: "const", value: 0 } };
  assert.equal(needsExplicitSubmit([rating, calcRow]), false, "calc row doesn't force a button");
  assert.equal(needsExplicitSubmit([calcRow]), true, "a calc row alone can't auto-submit");
});

// ---------- Controller: recompute before notify, in the same tick ----------

test("controller setValue recomputes calc + piping + isLastPage in ONE notify", () => {
  const c = createFormController({ form: jumpCalcForm });
  let notifications = 0;
  c.subscribe(() => notifications++);

  const before = notifications;
  c.setValue("qty", 10);
  assert.equal(notifications, before + 1, "exactly one notify for the whole update");

  const state = c.getState();
  assert.equal(state.data.total, 50, "calc value is in data in the same snapshot");
  assert.equal(state.isLastPage, true, "the jump→end rule read the fresh calc value");
  assert.equal(
    resolveText("Total is {{total}}", state.data, jumpCalcForm),
    "Total is 50",
    "piping sees the calc value in the same tick",
  );

  c.setValue("qty", 2);
  const idle = c.getState();
  assert.equal(idle.data.total, 10);
  assert.equal(idle.isLastPage, false, "back below the threshold → linear again");
});

test("controller drops a forged calculated value from initialData at mount", () => {
  const c = createFormController({ form: jumpCalcForm, initialData: { total: 999 } });
  assert.equal(c.getState().data.total, undefined, "qty unanswered → total unanswered");
  assert.equal(c.getState().isLastPage, false, "the forged value can't end the form early");
});

test("controller recompute survives a schema swap (builder live preview)", () => {
  const c = createFormController({ form: jumpCalcForm, initialData: { qty: 4 } });
  assert.equal(c.getState().data.total, 20);
  // Swap the multiplier: same answers, new calc definition → new value.
  const edited = JSON.parse(JSON.stringify(jumpCalcForm));
  edited.pages[0].blocks[1].calc = { op: "mul", args: [ref("qty"), { op: "const", value: 7 }] };
  c.setContext({ form: edited });
  assert.equal(c.getState().data.total, 28, "setContext recomputed with the new schema");
});

// ---------- Schema drift: calc-free forms are byte-identical ----------

test("a calc-free form normalizes byte-identically to the pre-calc engine", () => {
  // Expected output captured from the pre-change build (commit before the
  // calculated kind landed) over a fixture touching every other kind, jumps,
  // conditions, and every settings branch. If this fails, the calc change
  // altered normalization for forms that never asked for it.
  const fixture = {
    version: 1,
    title: "  Every kind  ",
    description: "Drift fixture",
    pages: [
      {
        id: "p1",
        title: "First",
        blocks: [
          { id: "h", kind: "heading", text: "Hello" },
          { id: "para", kind: "paragraph", text: "Context" },
          { id: "div", kind: "divider" },
          { id: "st", kind: "short_text", label: "Short", maxLength: 50, placeholder: " hi " },
          { id: "lt", kind: "long_text", label: "Long", maxLength: 99999 },
          { id: "em", kind: "email", label: "Email", required: true },
          { id: "u", kind: "url", label: "Url" },
          { id: "ph", kind: "phone", label: "Phone", defaultCountry: "us" },
          { id: "n", kind: "number", label: "Num", min: 0, max: 10 },
        ],
        next: [{ when: [{ fieldId: "n", op: "gt", value: 5 }], to: "p3" }],
      },
      {
        id: "p2",
        blocks: [
          { id: "sel", kind: "select", label: "Sel", options: [{ id: "a", label: "A" }, { id: "b", label: "B", icon: "thumbs_up" }], allowOther: true },
          { id: "ms", kind: "multi_select", label: "MS", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], shuffleOptions: true },
          { id: "dd", kind: "dropdown", label: "DD", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          { id: "cb", kind: "checkbox", label: "CB", appearance: "toggle" },
          { id: "rt", kind: "rating", label: "Rate", max: 5, insightsMetric: "csat" },
          { id: "ls", kind: "linear_scale", label: "Scale", min: 0, max: 10, minLabel: "lo", maxLabel: "hi", insightsMetric: "nps" },
        ],
      },
      {
        id: "p3",
        blocks: [
          { id: "rk", kind: "ranking", label: "Rank", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          { id: "mx", kind: "matrix", label: "Grid", rows: [{ id: "r1", label: "R1" }], columns: [{ id: "c1", label: "C1" }] },
          { id: "sig", kind: "signature", label: "Sign" },
          { id: "dt", kind: "date", label: "Date", visibleIf: [{ fieldId: "cb", op: "eq", value: true }] },
          { id: "fu", kind: "file_upload", label: "Files", maxFiles: 3, maxFileSizeMb: 100, accept: ["image/*", ".pdf"] },
          { id: "hid", kind: "hidden", label: "Hid", paramName: "src", defaultValue: "x", required: true },
          { id: "cu", kind: "custom", label: "Cu", component: "color", config: { deep: { ok: 1 } } },
        ],
      },
    ],
    settings: {
      submitMode: "auto", submitLabel: "Go", successTitle: "T", successMessage: "M",
      redirectUrl: "https://example.com/done", showProgress: true,
      responseLimit: { by: "identify", onRepeat: "update", scopeField: "hid" },
      trust: { unverified: "quarantine", challenge: "turnstile" },
      notifyEmail: "a@b.co", sendReceipt: true, saveProgress: true,
      draftAnswersVisible: false, resumeEmails: true, resumeUrl: "https://example.com/resume",
      draftDigest: true,
    },
  };
  const expected =
    '{"version":1,"title":"Every kind","pages":[{"id":"p1","title":"First","blocks":[{"id":"h","kind":"heading","text":"Hello"},{"id":"para","kind":"paragraph","text":"Context"},{"id":"div","kind":"divider"},{"id":"st","kind":"short_text","label":"Short","placeholder":"hi","maxLength":50},{"id":"lt","kind":"long_text","label":"Long","maxLength":20000},{"id":"em","kind":"email","label":"Email","required":true},{"id":"u","kind":"url","label":"Url"},{"id":"ph","kind":"phone","label":"Phone","defaultCountry":"US"},{"id":"n","kind":"number","label":"Num","min":0,"max":10}],"next":[{"when":[{"fieldId":"n","op":"gt","value":5}],"to":"p3"}]},{"id":"p2","blocks":[{"id":"sel","kind":"select","label":"Sel","options":[{"id":"a","label":"A"},{"id":"b","label":"B","icon":"thumbs_up"}],"allowOther":true},{"id":"ms","kind":"multi_select","label":"MS","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"shuffleOptions":true},{"id":"dd","kind":"dropdown","label":"DD","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]},{"id":"cb","kind":"checkbox","label":"CB","appearance":"toggle"},{"id":"rt","kind":"rating","label":"Rate","max":5,"insightsMetric":"csat"},{"id":"ls","kind":"linear_scale","label":"Scale","min":0,"max":10,"minLabel":"lo","maxLabel":"hi","insightsMetric":"nps"}]},{"id":"p3","blocks":[{"id":"rk","kind":"ranking","label":"Rank","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]},{"id":"mx","kind":"matrix","label":"Grid","rows":[{"id":"r1","label":"R1"}],"columns":[{"id":"c1","label":"C1"}]},{"id":"sig","kind":"signature","label":"Sign"},{"id":"dt","visibleIf":[{"fieldId":"cb","op":"eq","value":true}],"kind":"date","label":"Date"},{"id":"fu","kind":"file_upload","label":"Files","maxFiles":3,"maxFileSizeMb":100,"accept":["image/*",".pdf"]},{"id":"hid","kind":"hidden","label":"Hid","required":false,"paramName":"src","defaultValue":"x"},{"id":"cu","kind":"custom","label":"Cu","component":"color","config":{"deep":{"ok":1}}}]}],"settings":{"submitMode":"auto","submitLabel":"Go","successTitle":"T","successMessage":"M","redirectUrl":"https://example.com/done","showProgress":true,"responseLimit":{"by":"identify","scopeField":"hid","onRepeat":"update"},"trust":{"unverified":"quarantine","challenge":"turnstile"},"notifyEmail":"a@b.co","sendReceipt":true,"saveProgress":true,"draftAnswersVisible":false,"resumeEmails":true,"resumeUrl":"https://example.com/resume","draftDigest":true},"description":"Drift fixture"}';
  const result = normalizeFormSchema(fixture);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.schema), expected);
});

test("<Fillo.Calculated> compiles through the JSX walk and passes server validation", async () => {
  const { JSX_BLOCK_COMPONENTS: B, schemaFromJsx, validateFormSchema } = await import("../dist/index.js");
  const el = (type, props) => ({ type, props });
  const schema = schemaFromJsx(
    [
      el(B.Number, { id: "qty", label: "Quantity" }),
      el(B.Calculated, {
        id: "total",
        label: "Total",
        calc: { op: "mul", args: [ref("qty"), { op: "const", value: 19.5 }] },
        decimals: 2,
        prefix: "$",
        suffix: " USD",
      }),
    ],
    { id: "shop", title: "Shop" },
  );
  assert.deepEqual(schema.pages[0].blocks[1], {
    id: "total",
    kind: "calculated",
    label: "Total",
    calc: { op: "mul", args: [{ op: "value", fieldId: "qty" }, { op: "const", value: 19.5 }] },
    decimals: 2,
    prefix: "$",
    suffix: " USD",
  });
  const validated = validateFormSchema(schema);
  assert.equal(validated.ok, true, validated.error);
});

test("computeCalculated returns data UNCHANGED (same reference) for a calc-free form", () => {
  const form = normalizeFormSchema({
    version: 1,
    title: "Plain",
    settings: {},
    pages: [{ id: "p1", blocks: [num("a")] }],
  }).schema;
  const data = { a: 1 };
  assert.equal(computeCalculated(form, data), data);
});
