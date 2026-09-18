import type { FormSchema, ResponseData } from "./types.js";
import { allFields } from "./logic.js";

/**
 * Parse a plain decimal numeric string only — reject Infinity, 1e999, 0x10 and
 * other exotic forms `Number()` would happily coerce from a crafted URL.
 */
function parseDecimal(raw: string): number | null {
  const s = raw.trim();
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build initial response data from URL query parameters — Tally-style
 * prefilling. Hidden fields read their configured paramName; every other
 * field can be prefilled by its id. Values are coerced per kind and
 * validated against options, so a crafted URL can't inject invalid answers.
 */
export function prefillFromParams(
  form: FormSchema,
  params: Record<string, string | undefined>,
): ResponseData {
  const data: ResponseData = {};

  for (const field of allFields(form)) {
    const raw =
      field.kind === "hidden"
        ? (params[field.paramName ?? field.id] ?? field.defaultValue)
        : params[field.id];
    if (raw === undefined || raw === "") continue;

    switch (field.kind) {
      case "number": {
        const n = parseDecimal(raw);
        if (n === null) break;
        if (field.min !== undefined && n < field.min) break;
        if (field.max !== undefined && n > field.max) break;
        data[field.id] = n;
        break;
      }
      case "rating": {
        const n = parseDecimal(raw);
        if (n !== null && Number.isInteger(n) && n >= 1 && n <= (field.max ?? 5))
          data[field.id] = n;
        break;
      }
      case "linear_scale": {
        const n = parseDecimal(raw);
        const min = field.min ?? 1;
        const max = field.max ?? 10;
        if (n !== null && Number.isInteger(n) && n >= min && n <= max) data[field.id] = n;
        break;
      }
      case "checkbox":
        data[field.id] = raw === "true" || raw === "1" || raw === "yes";
        break;
      case "select":
      case "dropdown": {
        if (field.options.some((o) => o.id === raw)) data[field.id] = raw;
        break;
      }
      case "multi_select": {
        const ids = new Set(field.options.map((o) => o.id));
        const picked = [...new Set(raw.split(",").filter((v) => ids.has(v)))];
        if (picked.length > 0) data[field.id] = picked;
        break;
      }
      case "file_upload":
      case "ranking":
      case "matrix":
      case "signature":
      case "custom":
        break; // not prefillable from a URL
      case "calculated":
        break; // engine-computed, never prefillable — a crafted URL can't seed it
      case "repeating_group":
        // Explicit no-op (contract decision 11): a flat URL param can't carry
        // structured instances, and WITHOUT this case the default branch
        // below would silently assign the raw query STRING under the group id
        // — a shape the whole pipeline treats as forged (canonicalization
        // reads a non-array as unanswered). Never fall through.
        break;
      default:
        data[field.id] = raw;
    }
  }

  return data;
}
