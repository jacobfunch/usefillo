import type {
  CalcExpr,
  CalculatedField,
  FieldValue,
  FormSchema,
  ResponseData,
} from "./types.js";
import {
  allFields,
  conditionNumber,
  conditionsMet,
  reachableFieldIds,
  resolveLogicState,
} from "./logic.js";

/**
 * The calculated-field evaluator (logic depth P2). Deterministic and identical
 * on the client and the server: the controller runs it live so piping,
 * conditions, jumps, and the display row update in the same tick, and the
 * submit route reruns the very same functions over the validated answers so a
 * tampered client value is ignored by construction.
 *
 * This module and logic.ts import each other on purpose: the joint
 * {visible set, calc values} fixpoint lives in logic.ts (ONE shared engine, no
 * second copy) and calls back into `evaluateCalculatedField`, while the
 * evaluator reuses logic.ts's condition machinery (`conditionsMet`,
 * `conditionNumber`) so numeric-string bridging and `if` semantics can never
 * drift from visibility/jump conditions. Both modules only export hoisted
 * function declarations used at call time, so the cycle is safe.
 */

/** Clamp a round/field `decimals` to the supported integer range 0–6. */
function clampDecimals(decimals: number | undefined): number {
  if (decimals === undefined || !Number.isFinite(decimals)) return 0;
  return Math.max(0, Math.min(6, Math.round(decimals)));
}

/** Half-away-from-zero at `decimals` — 0.5 → 1, -0.5 → -1 (Math.round alone
 *  rounds halves toward +Infinity, which would make -0.5 → -0). */
function roundHalfAwayFromZero(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  return value < 0 ? -rounded : rounded;
}

/** Any non-finite intermediate (overflow, 0/0 survivors) reads as null —
 *  strict propagation, never a silent Infinity in someone's stored data. */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Evaluate a calc expression to a number, or null for "unanswered".
 * `resolve` maps a fieldId to its effective value and must apply the SAME
 * visibility discipline as conditions (a logic-hidden source resolves to
 * undefined) — the shared fixpoint's resolver does exactly that. Semantics:
 * - an unanswered `value` ref → null; numeric strings bridge exactly like
 *   condition gt/lt (shared `conditionNumber`), nothing else coerces;
 * - any null operand → null result (strict propagation, no silent zero);
 * - division by zero and non-finite results → null;
 * - `round` is half-away-from-zero at `decimals` (default 0);
 * - `if` runs its `when` through the standard condition evaluator (AND), so
 *   unanswered behavior is identical to visibility/jump rules.
 */
export function evaluateCalc(
  expr: CalcExpr,
  resolve: (fieldId: string) => FieldValue,
): number | null {
  switch (expr.op) {
    case "value":
      return conditionNumber(resolve(expr.fieldId));
    case "const":
      return finiteOrNull(expr.value);
    case "add":
    case "mul":
    case "min":
    case "max": {
      // Normalization guarantees length >= 1; defensively treat an empty
      // n-ary node as unanswered rather than inventing an identity element.
      if (expr.args.length === 0) return null;
      const values: number[] = [];
      for (const arg of expr.args) {
        const value = evaluateCalc(arg, resolve);
        if (value === null) return null;
        values.push(value);
      }
      if (expr.op === "add") return finiteOrNull(values.reduce((a, b) => a + b, 0));
      if (expr.op === "mul") return finiteOrNull(values.reduce((a, b) => a * b, 1));
      return expr.op === "min" ? Math.min(...values) : Math.max(...values);
    }
    case "sub":
    case "div": {
      const left = evaluateCalc(expr.left, resolve);
      if (left === null) return null;
      const right = evaluateCalc(expr.right, resolve);
      if (right === null) return null;
      if (expr.op === "sub") return finiteOrNull(left - right);
      return right === 0 ? null : finiteOrNull(left / right);
    }
    case "round": {
      const value = evaluateCalc(expr.arg, resolve);
      return value === null ? null : finiteOrNull(roundHalfAwayFromZero(value, clampDecimals(expr.decimals)));
    }
    case "if":
      return evaluateCalc(conditionsMet(expr.when, resolve) ? expr.then : expr.else, resolve);
  }
}

/**
 * A calculated field's STORED value: the evaluated expression with the
 * field-level `decimals` applied (half-away-from-zero). Rounding here — inside
 * the shared fixpoint's per-field evaluation — is what makes chained calcs,
 * conditions, piping, and exports all see the one deterministic number.
 * @internal shared with logic.ts's fixpoint; not part of the public barrel.
 */
export function evaluateCalculatedField(
  field: CalculatedField,
  resolve: (fieldId: string) => FieldValue,
): number | null {
  const value = evaluateCalc(field.calc, resolve);
  if (value === null || field.decimals === undefined) return value;
  return finiteOrNull(roundHalfAwayFromZero(value, clampDecimals(field.decimals)));
}

/**
 * Response data with every calculated field's value written in (null or
 * logic-hidden → key absent, i.e. unanswered) and any client-supplied value
 * for a calculated id dropped — the engine, never the wire, owns these keys.
 * Returns `data` unchanged for a calc-free form.
 *
 * THE canonical evaluator, shared verbatim by the controller (live display,
 * piping, conditions) and the server's submit recompute — the contract's
 * "deterministic, identical evaluation on client and server". Before the
 * joint {visible set, calc values} fixpoint runs, answers are reduced to the
 * canonical form the server stores:
 * - value shape: resolveLogicState reads canonical values (trimmed, coerced,
 *   empty-as-unanswered — canonical.ts), so `if.when` conditions match the
 *   kept answers, never a divergent live shape;
 * - reachability: an answer on a jump-skipped page reads as unanswered, the
 *   same pruning validateResponse applies before the server recompute. The
 *   prune below can itself flip a jump or visibility rule, so it iterates to
 *   a fixed point — each pass keeps a SUBSET of the previous keys (pruning
 *   only ever removes), so the loop is monotone, terminates within the key
 *   count, and the client (raw live data) and the server (the once-pruned
 *   kept set) walk the same shrinking chain to the SAME view.
 *
 * The pruned view is EVALUATION input only: non-calc answers pass through to
 * the output untouched, so the controller keeps a stale answer behind a
 * flipped jump (navigating back restores it) while its calc display, piping,
 * and jump decisions read it as unanswered — exactly what the server stores.
 */
export function computeCalculated(form: FormSchema, data: ResponseData): ResponseData {
  const fields = allFields(form);
  if (!fields.some((field) => field.kind === "calculated")) return data;
  let view = data;
  let reachable = reachableFieldIds(form, view);
  for (let i = 0; i <= fields.length; i++) {
    const next: ResponseData = {};
    let pruned = false;
    for (const [key, value] of Object.entries(view)) {
      if (reachable.has(key)) next[key] = value;
      else pruned = true;
    }
    if (!pruned) break;
    view = next;
    reachable = reachableFieldIds(form, view);
  }
  const state = resolveLogicState(fields, view);
  const out: ResponseData = {};
  for (const [key, value] of Object.entries(data)) {
    if (!state.calcIds.has(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(state.calc)) {
    // A calculated field on an unreachable page is unanswered like any other
    // field there — its computed value still feeds jumps/visibility above,
    // but never the stored/displayed data.
    if (reachable.has(key)) out[key] = value;
  }
  return out;
}
