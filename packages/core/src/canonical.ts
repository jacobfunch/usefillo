import type { Field, FieldValue, GroupInstanceValue, RepeatingGroupField } from "./types.js";

/**
 * THE canonical answer-value discipline, shared by response validation
 * (validateResponse's clean/keep pass) and the logic engine (resolveLogicState's
 * resolver): client and server must reduce an answer to ONE canonical shape
 * before any condition or calculation reads it, or a value the client evaluates
 * live ("vip ", an unchecked checkbox's false) diverges from the value the
 * server keeps and recomputes over. This module is a leaf (types only) so both
 * validation.ts and logic.ts can import it without widening the deliberate
 * logic⇄calc module cycle.
 */

/** An "empty" answer is dropped from stored data and reads as unanswered:
 *  null/undefined, a blank/whitespace string, an empty array, `false`
 *  (an unchecked checkbox), or an empty object. */
export function isEmpty(value: FieldValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return value === false;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * The recursive repeating-group branch of {@link normalizeValue} (contract
 * decision 4 — one canonical engine, recursive from day one). Per instance,
 * per child, apply the EXACT top-level discipline: normalize + drop empties
 * (via {@link canonicalValue}), and drop unknown child keys (the calc tamper
 * precedent — the engine, never the wire, decides what a group carries). A
 * non-array value under a group id is forged/stale wire data and reads as
 * unanswered (undefined) — it must never flow onward as a scalar. A non-object
 * INSTANCE inside the array passes through untouched so validateField can
 * REJECT it per kind (a real 422, matching the forged-child-type tamper rule)
 * rather than this pass silently rewriting a bad count into a good one.
 *
 * Same-reference discipline: when nothing needed changing — every key a known
 * child, every value already canonical, nothing dropped — the ORIGINAL array
 * (and each original instance object) is returned untouched, so group-free
 * and already-canonical data flows through by reference (the calc no-op
 * precedent; drift-tested).
 */
function normalizeGroupValue(field: RepeatingGroupField, value: FieldValue): FieldValue {
  if (!Array.isArray(value)) return undefined;
  const childById = new Map(field.fields.map((child) => [child.id, child]));
  let changed = false;
  const instances = (value as GroupInstanceValue[]).map((instance): GroupInstanceValue => {
    if (!instance || typeof instance !== "object" || Array.isArray(instance)) return instance;
    let instanceChanged = false;
    const out: GroupInstanceValue = {};
    // Iterate the instance's OWN key order (kept keys keep their arrival
    // order — normalization never reorders, the top-level precedent).
    for (const [key, raw] of Object.entries(instance)) {
      const child = childById.get(key);
      if (!child) {
        instanceChanged = true; // unknown child key — dropped
        continue;
      }
      const canonical = canonicalValue(child, raw);
      if (canonical === undefined) {
        instanceChanged = true; // empty answer — dropped, reads unanswered
        continue;
      }
      out[key] = canonical;
      if (canonical !== raw) instanceChanged = true;
    }
    if (!instanceChanged) return instance;
    changed = true;
    return out;
  });
  return changed ? instances : value;
}

/** Coerce common wire-format quirks into the canonical value for a field. */
export function normalizeValue(field: Field, value: FieldValue): FieldValue {
  if (value === undefined || value === null) return value;
  // Custom values are arbitrary JSON. Core only checks presence, so it must
  // not silently rewrite a custom component's intentionally padded string.
  if (field.kind === "custom") return value;
  if (field.kind === "repeating_group") return normalizeGroupValue(field, value);
  if (field.kind === "number" && typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  // linear_scale alongside rating: both are numeric answers that arrive as
  // strings from raw API/headless clients. Storing a scale as "7" corrupts
  // numeric aggregation (NPS) and breaks gt/lt conditions (which need a number).
  if ((field.kind === "rating" || field.kind === "linear_scale") && typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (typeof value === "string") return value.trim();
  return value;
}

/**
 * The canonical value a condition or calculation reads for a field: the
 * normalized wire shape, with empty answers reading as `undefined`
 * (unanswered). Exactly the shape validateResponse keeps in stored data — so
 * `eq` on a padded string or an unchecked checkbox resolves identically in the
 * live client engine and in the server's recompute over the kept answers.
 * @internal shared by logic.ts's resolver; not part of the public barrel.
 */
export function canonicalValue(field: Field, value: FieldValue): FieldValue {
  const normalized = normalizeValue(field, value);
  return isEmpty(normalized) ? undefined : normalized;
}
