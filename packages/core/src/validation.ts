// zod/mini (the tree-shakeable v4 API) so the classic zod barrel doesn't land
// in every embed bundle — this validator sits on the render/submit path.
import * as z from "zod/mini";
import type {
  Field,
  FieldValue,
  FileValue,
  FormSchema,
  GroupInstanceValue,
  RepeatingGroupField,
  ResponseData,
} from "./types.js";
import { reachableFields, visibleGroupChildren } from "./logic.js";
// The clean/keep discipline below (trim, wire-format coercion, empty = absent)
// is THE canonical value shape — shared with the logic engine's resolver so a
// condition can never match a value shape validateResponse won't keep.
import { isEmpty, normalizeValue } from "./canonical.js";
import { isPossiblePhone } from "./phone.js";
import { REQUIRED_FIELD_MESSAGE } from "./strings.js";

const fileValueSchema = z.object({
  fileId: z.string().check(z.minLength(1)),
  name: z.string(),
  size: z.number().check(z.nonnegative()),
  mime: z.string(),
  url: z.optional(z.string()),
});

/**
 * The min/max instance-count check for a repeating group — a REAL validation
 * error in both directions (contract decision 5: instances are respondent
 * input, unlike calc's ignore rule). Raw English sentinels like every message
 * here; "entry/entries" stays label-agnostic because naive pluralization of
 * an arbitrary itemLabel ("Guest" → "Guests"?) is wrong in most languages —
 * the renderers localize with the itemLabel through their strings layer.
 */
function groupCountError(field: RepeatingGroupField, count: number): string | null {
  const min = Math.max(0, field.minInstances ?? 1);
  if (count < min) return `Add at least ${min} ${min === 1 ? "entry" : "entries"}`;
  if (Number.isFinite(field.maxInstances) && count > field.maxInstances)
    return `At most ${field.maxInstances} ${field.maxInstances === 1 ? "entry" : "entries"}`;
  return null;
}

/** Validate a single answered value for a field. Returns an error message or null. */
export function validateField(field: Field, value: FieldValue): string | null {
  if (isEmpty(value)) {
    // A calculated field is derived, not answered — required is forced off in
    // normalization and an empty computed value must NEVER trigger
    // required-missing (guarded here too for unnormalized schemas).
    if (field.kind === "calculated") return null;
    // A repeating group's completeness is its instance count, not the generic
    // required flag (forced off in normalization): empty = zero instances,
    // which errors iff minInstances ≥ 1 (the canonical branch reduces a
    // non-array forged value to unanswered, so it lands here too).
    if (field.kind === "repeating_group") return groupCountError(field, 0);
    // Raw English sentinel — the React render layer maps it to strings.required
    // for localization (core has no strings context on the validation path).
    return field.required ? REQUIRED_FIELD_MESSAGE : null;
  }

  switch (field.kind) {
    case "short_text":
    case "long_text": {
      if (typeof value !== "string") return "Expected text";
      if (field.maxLength && value.length > field.maxLength)
        return `Must be at most ${field.maxLength} characters`;
      // Backstop cap when the field sets no explicit limit — keeps a raw API
      // submission from storing an unbounded string. Generous for long_text.
      const hardCap = field.kind === "long_text" ? 20_000 : 2_000;
      if (!field.maxLength && value.length > hardCap) return "Answer is too long";
      return null;
    }
    case "email": {
      if (typeof value !== "string") return "Enter a valid email address";
      if (field.maxLength && value.length > field.maxLength)
        return `Must be at most ${field.maxLength} characters`;
      const r = z.email().safeParse(value);
      return r.success ? null : "Enter a valid email address";
    }
    case "url": {
      if (typeof value !== "string") return "Enter a valid URL (including https://)";
      if (field.maxLength && value.length > field.maxLength)
        return `Must be at most ${field.maxLength} characters`;
      try {
        const url = new URL(value);
        // Reject javascript:/data:/etc — these become XSS when rendered as links.
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return "Enter an http(s) URL";
        }
      } catch {
        return "Enter a valid URL (including https://)";
      }
      return null;
    }
    case "phone": {
      // Length/shape only — the server normalizes to E.164 and does the
      // authoritative libphonenumber check on submit.
      if (typeof value !== "string" || !isPossiblePhone(value))
        return "Enter a valid phone number";
      return null;
    }
    case "number": {
      const n = typeof value === "string" ? Number(value) : value;
      // Number.isFinite (not just !isNaN) so ±Infinity is rejected — JSON.parse
      // turns 1e999 into Infinity, which JSON.stringify then persists as null.
      if (typeof n !== "number" || !Number.isFinite(n)) return "Enter a number";
      if (field.min !== undefined && n < field.min) return `Must be at least ${field.min}`;
      if (field.max !== undefined && n > field.max) return `Must be at most ${field.max}`;
      return null;
    }
    case "select":
    case "dropdown": {
      if (typeof value !== "string" || value === "") return "Pick an option";
      if (field.options.some((o) => o.id === value)) return null;
      // "Other" answers arrive as the raw typed text.
      if (field.allowOther && value.length <= 500) return null;
      return "Pick a valid option";
    }
    case "multi_select": {
      if (!Array.isArray(value)) return "Pick at least one option";
      const ids = new Set(field.options.map((o) => o.id));
      const arr = value as string[];
      // At most one free-text "Other" entry, and only when the field allows it.
      // Anything that isn't a known option id counts as the single "other".
      let others = 0;
      const seen = new Set<string>();
      for (const v of arr) {
        if (typeof v !== "string") return "Pick valid options";
        if (seen.has(v)) return "Pick each option only once";
        seen.add(v);
        if (ids.has(v)) continue;
        if (field.allowOther !== true || v.length === 0 || v.length > 500)
          return "Pick valid options";
        if (++others > 1) return "Only one 'Other' answer is allowed";
      }
      return null;
    }
    case "checkbox": {
      return typeof value === "boolean" ? null : "Invalid value";
    }
    case "rating": {
      const max = field.max ?? 5;
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)
        return `Pick a rating between 1 and ${max}`;
      return null;
    }
    case "linear_scale": {
      const min = field.min ?? 1;
      const max = field.max ?? 10;
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
        return `Pick a value between ${min} and ${max}`;
      return null;
    }
    case "ranking": {
      if (!Array.isArray(value)) return "Drag the options into order";
      const ids = field.options.map((o) => o.id).sort();
      const got = [...(value as string[])].sort();
      if (ids.length !== got.length || ids.some((id, i) => id !== got[i]))
        return "Rank every option";
      return null;
    }
    case "matrix": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return "Answer the grid";
      const answers = value as Record<string, string>;
      const columnIds = new Set(field.columns.map((c) => c.id));
      const rowIds = new Set(field.rows.map((r) => r.id));
      for (const [rowId, columnId] of Object.entries(answers)) {
        if (!rowIds.has(rowId) || !columnIds.has(columnId)) return "Invalid grid answer";
      }
      if (field.required && Object.keys(answers).length < field.rows.length)
        return "Answer every row";
      return null;
    }
    case "signature": {
      if (typeof value !== "string" || !value.startsWith("data:image/"))
        return "Sign in the box";
      return null;
    }
    case "hidden": {
      return typeof value === "string" ? null : "Invalid value";
    }
    case "calculated": {
      // Never an error: the value is engine-computed, not respondent input.
      // validateResponse drops client-sent values for the id entirely.
      return null;
    }
    case "repeating_group": {
      // Array shape + instance count only. Per-instance per-child validation
      // lives in validateResponse, which owns the errors record the compound
      // "${groupId}.${index}.${childId}" keys go into — this function's
      // single-message contract can't carry them.
      if (!Array.isArray(value)) {
        // The canonical branch reads a non-array as unanswered (zero
        // instances); validating the raw value directly reaches the same
        // verdict so both paths agree.
        return groupCountError(field, 0);
      }
      const instances = value as GroupInstanceValue[];
      // A forged non-object instance is rejected per the tamper rule (a real
      // 422, like a forged child type) — never silently dropped, which would
      // rewrite the respondent-controlled count.
      for (const instance of instances) {
        if (!instance || typeof instance !== "object" || Array.isArray(instance))
          return "Invalid value";
      }
      return groupCountError(field, instances.length);
    }
    case "custom": {
      // Core can't know a custom value's shape — only that required ones are
      // present (checked above). The component validates anything richer.
      return null;
    }
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return "Enter a valid date";
      // Shape isn't enough — "2026-02-30"/"2026-13-45" match the regex but aren't
      // real dates. Round-trip through UTC and require the parts to survive.
      const [y, m, d] = value.split("-").map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
        return "Enter a valid date";
      return null;
    }
    case "file_upload": {
      const r = z.array(fileValueSchema).safeParse(value);
      if (!r.success) return "Upload did not complete";
      const maxFiles = field.maxFiles ?? 1;
      if (r.data.length > maxFiles)
        return `At most ${maxFiles} file${maxFiles === 1 ? "" : "s"}`;
      return null;
    }
  }
}

export interface ValidationResult {
  ok: boolean;
  /** fieldId -> message for every failing field. */
  errors: Record<string, string>;
  /** Data trimmed to the fields that are reachable + visible (answers to fields
   *  hidden by logic OR on pages skipped by a jump/early-end are dropped). */
  data: ResponseData;
}

/**
 * Validate a full submission against the schema. Only reachable + currently-
 * visible fields are validated and kept — answers to fields hidden by logic, or
 * on pages a page-jump/early-end skipped, are discarded. A legitimately
 * early-ended submission therefore does NOT 422 on a skipped page's required
 * field. Reachability is computed by the SAME shared engine the client renderer
 * navigates with, so render and validate always agree. A form with no jumps has
 * every page reachable, so this validates exactly as before.
 */
export function validateResponse(form: FormSchema, data: ResponseData): ValidationResult {
  const fields = reachableFields(form, data);
  const errors: Record<string, string> = {};
  const cleaned: ResponseData = {};

  for (const field of fields) {
    // Calculated ids are excluded from the validated AND kept set: a
    // client-submitted value for one is dropped exactly like an unknown key
    // (never 422'd — the tamper rule), and the server recomputes every
    // reachable calculated field from the kept answers after this pass.
    if (field.kind === "calculated") continue;
    const value = normalizeValue(field, data[field.id]);
    if (field.kind === "repeating_group") {
      validateGroupResponse(field, value, errors, cleaned);
      continue;
    }
    const error = validateField(field, value);
    if (error) {
      errors[field.id] = error;
    } else if (!isEmpty(value)) {
      cleaned[field.id] = value;
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, data: cleaned };
}

/**
 * The repeating-group branch of validateResponse (contract decision 5).
 * `value` is already canonical (normalizeValue recursed per instance/child:
 * trimmed, coerced, unknown keys and empties dropped). Three layers:
 * - the group-level shape/count check via validateField, reported under the
 *   PLAIN groupId key (a real 422 in both directions — respondent input);
 * - per instance, per VISIBLE child, the same validateField every top-level
 *   field goes through, errors under the synthetic key
 *   `"${groupId}.${index}.${childId}"` (dot-safe in DOM ids; the public
 *   ValidationResult type is unchanged — recon risk 3). Index = position in
 *   the submitted array, so the renderer can address the exact card.
 * - the kept value: the canonicalized instance array, each instance filtered
 *   to its logic-VISIBLE children (visibleGroupChildren — the ONE scoped
 *   engine renderers share), rebuilt in template order. A logic-hidden child
 *   is skipped by validation AND its value dropped from the kept instance —
 *   the exact top-level reachable∩visible discipline, one scope down. An
 *   all-hidden/all-empty instance stays as `{}` so the respondent-controlled
 *   COUNT survives cleaning.
 */
function validateGroupResponse(
  field: RepeatingGroupField,
  value: FieldValue,
  errors: Record<string, string>,
  cleaned: ResponseData,
): void {
  const groupError = validateField(field, value);
  if (groupError) errors[field.id] = groupError;
  if (!Array.isArray(value)) return;
  const instances = value as GroupInstanceValue[];
  const kept: GroupInstanceValue[] = [];
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    // A non-object instance was already rejected wholesale by the group-level
    // "Invalid value" — nothing per-child to report or keep for it.
    if (!instance || typeof instance !== "object" || Array.isArray(instance)) continue;
    const keptInstance: GroupInstanceValue = {};
    for (const child of visibleGroupChildren(field, instance)) {
      const childValue = instance[child.id];
      const childError = validateField(child, childValue);
      if (childError) {
        errors[`${field.id}.${index}.${child.id}`] = childError;
      } else if (!isEmpty(childValue)) {
        keptInstance[child.id] = childValue;
      }
    }
    kept.push(keptInstance);
  }
  if (!groupError && kept.length > 0) cleaned[field.id] = kept;
}

export type { FileValue };
