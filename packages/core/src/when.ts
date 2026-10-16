import type { Condition } from "./types.js";

/**
 * Typed builder for visibleIf conditions — pure data out, canonical key order
 * ({fieldId, op, value?}) so it participates in content hashing unchanged.
 * Conditions AND together (schema semantics); there is deliberately no OR.
 *
 *   visibleIf={when("topic").eq("sales")}
 *   visibleIf={[when("topic").answered(), when("score").lt(5)]}
 */
export interface WhenBuilder {
  eq(value: string | number | boolean): Condition;
  neq(value: string | number | boolean): Condition;
  contains(value: string | number | boolean): Condition;
  gt(value: number): Condition;
  lt(value: number): Condition;
  answered(): Condition;
  notAnswered(): Condition;
}

export function when(fieldId: string): WhenBuilder {
  const cond = (op: Condition["op"], value?: Condition["value"]): Condition =>
    Object.freeze(value === undefined ? { fieldId, op } : { fieldId, op, value });
  return {
    eq: (value) => cond("eq", value),
    neq: (value) => cond("neq", value),
    contains: (value) => cond("contains", value),
    gt: (value) => cond("gt", value),
    lt: (value) => cond("lt", value),
    answered: () => cond("answered"),
    notAnswered: () => cond("not_answered"),
  };
}
