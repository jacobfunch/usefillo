import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCalculated,
  normalizeFormSchema,
  validateResponse,
  visibleFields,
} from "../dist/index.js";

// ---------- Aggregate calc complexity caps (the submit-path DoS guard) ----------
//
// The joint {visible, calc} fixpoint re-evaluates every calc expression for up
// to fields.length passes, synchronously, on the PUBLIC submit endpoint — so
// normalization hard-caps aggregate complexity: at most 100 calculated fields
// and at most 5000 AST nodes across all calc expressions per form (nesting
// depth is separately capped at 32). A hostile-but-structurally-valid schema
// is rejected at authoring/sync time and never reaches a respondent recompute.

const form = (blocks) => ({
  version: 1,
  title: "Caps",
  settings: {},
  pages: [{ id: "p1", blocks }],
});

const num = (id) => ({ id, kind: "number", label: id });
const calc = (id, calcExpr, extra = {}) => ({ id, kind: "calculated", label: id, calc: calcExpr, ...extra });
const ref = (fieldId) => ({ op: "value", fieldId });
const constant = (value) => ({ op: "const", value });

/** An add-tree of exactly `nodes` AST nodes (1 add + (nodes-1) const args). */
const wideExpr = (nodes) => ({ op: "add", args: Array.from({ length: nodes - 1 }, () => constant(1)) });

test("cap: more than 100 calculated fields is a hard error with a fix-it message", () => {
  const blocks = Array.from({ length: 101 }, (_, i) => calc(`c${i}`, constant(i)));
  const result = normalizeFormSchema(form(blocks));
  assert.equal(result.ok, false);
  assert.match(result.error, /Form has 101 calculated fields — the maximum is 100/);
  assert.match(result.error, /remove some or consolidate/);
});

test("cap: exactly 100 calculated fields at exactly 5000 total nodes passes", () => {
  // 100 fields × 50 nodes each = 5000 — both bounds are inclusive.
  const blocks = Array.from({ length: 100 }, (_, i) => calc(`c${i}`, wideExpr(50)));
  const result = normalizeFormSchema(form(blocks));
  assert.equal(result.ok, true, result.error);
});

test("cap: crossing 5000 total AST nodes is a hard error naming the bound", () => {
  // 99 × 50 + 1 × 51 = 5001. Depth stays tiny — this trips ONLY the node cap.
  const blocks = Array.from({ length: 99 }, (_, i) => calc(`c${i}`, wideExpr(50)));
  blocks.push(calc("last", { op: "add", args: [wideExpr(50)] }));
  const result = normalizeFormSchema(form(blocks));
  assert.equal(result.ok, false);
  assert.match(result.error, /Calculated expressions total 5001 operations — the maximum is 5000 across the form/);
  assert.match(result.error, /simplify or split up the calculations/);
});

test("cap: a large-but-reasonable calc form passes untouched", () => {
  // 20 chained running totals over 20 numeric sources — bigger than any real
  // builder output, far under the caps.
  const blocks = Array.from({ length: 20 }, (_, i) => num(`n${i}`));
  for (let i = 0; i < 20; i++) {
    blocks.push(
      calc(`sum${i}`, {
        op: "add",
        args: [ref(`n${i}`), i === 0 ? constant(0) : ref(`sum${i - 1}`)],
      }),
    );
  }
  const result = normalizeFormSchema(form(blocks));
  assert.equal(result.ok, true, result.error);
  // All sources answered (strict null propagation would otherwise blank the
  // chain) → the last running total is the whole sum.
  const data = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, 1]));
  assert.equal(computeCalculated(result.schema, data).sum19, 20);
});

// ---------- Oscillation: a cycle routed through visibleIf ----------
//
// schema-validation only hard-errors calc→calc REFERENCE cycles. A cycle routed
// through visibility — calcA is visible-if calcB is unanswered, and calcB reads
// calcA — is legal and has NO fixpoint: each pass flips the state. The engine's
// contract for this class, locked here: the loop TERMINATES (hard-bounded by
// fields.length), and the result is a pure function of (schema, data) — every
// call returns the identical state, and client and server resolve through the
// same function over the same whole-form field list, so they always agree. The
// exact phase the loop halts on DOES depend on the total field count (the
// iteration bound), which the last test documents deliberately.

const oscillating = (extraBlocks = []) =>
  normalizeFormSchema(
    form([
      calc("calcA", constant(1), { visibleIf: [{ fieldId: "calcB", op: "not_answered" }] }),
      calc("calcB", ref("calcA")),
      ...extraBlocks,
    ]),
  );

test("oscillation: the visibleIf-routed cycle is legal (not a reference cycle)", () => {
  const result = oscillating();
  assert.equal(result.ok, true, result.error);
});

test("oscillation: resolution terminates and is deterministic — repeat calls identical", () => {
  const schema = oscillating().schema;
  // Terminates: the fixpoint loop is hard-bounded by fields.length, so this
  // returns (a hang here would time the test out).
  const first = computeCalculated(schema, {});
  const second = computeCalculated(schema, {});
  assert.deepEqual(second, first, "same schema+data must resolve to the identical calc state");
  const visibleFirst = visibleFields(schema, {}).map((f) => f.id);
  const visibleSecond = visibleFields(schema, {}).map((f) => f.id);
  assert.deepEqual(visibleSecond, visibleFirst, "…and the identical visible set");

  // Client/server agreement: the server recompute runs computeCalculated over
  // validateResponse's kept data; both sides are this same pure function, so
  // for identical inputs they cannot disagree.
  const validated = validateResponse(schema, {});
  assert.equal(validated.ok, true);
  assert.deepEqual(computeCalculated(schema, validated.data), first);
});

test("oscillation: the halting phase is fixed per schema — locked, parity-dependent", () => {
  // Two fields → the loop halts on the phase where both calcs carry a value
  // while calcA has just been hidden. This is NOT a converged fixpoint (none
  // exists for this schema); it is the well-defined last iterate. Locked so an
  // engine change that alters the halting phase surfaces as a conscious diff
  // — the CONTRACT is the determinism proven above, not these exact numbers.
  // 2026-07-18 (canonical-evaluation batch): computeCalculated now filters its
  // output through the final reachable∩visible set, so calcA — computed in the
  // last iterate but hidden by its final visibility pass — reads as unanswered
  // in the output instead of leaking the pre-hide value. Same halting phase,
  // one field fewer in the emitted data; visibleFields already said so below.
  const two = oscillating().schema;
  assert.deepEqual(computeCalculated(two, {}), { calcB: 1 });
  assert.deepEqual(visibleFields(two, {}).map((f) => f.id), ["calcB"]);

  // An unrelated extra field bumps fields.length, flipping which phase the
  // bounded loop halts on — the parity dependence, documented deliberately.
  // Determinism still holds: each schema resolves identically on every call.
  const three = oscillating([num("pad")]).schema;
  const state = computeCalculated(three, {});
  assert.deepEqual(state, {});
  assert.deepEqual(computeCalculated(three, {}), state);
  assert.deepEqual(visibleFields(three, {}).map((f) => f.id), ["calcA", "calcB", "pad"]);
});
