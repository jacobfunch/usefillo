import type { Field, FieldValue, FileValue, GroupInstanceValue } from "./types.js";
import { formatNational, parsePhone } from "./phone.js";

/** Compile-time guard: every field kind must be handled above this call. */
function assertNever(x: never): never {
  throw new Error(`Unhandled field kind: ${JSON.stringify(x)}`);
}

/**
 * Canonical plain-text rendering of an answer — the single source of truth for
 * the responses grid, CSV export, and notification emails. Returns "" for an
 * empty answer. Rich per-surface rendering (links, stars, images) stays in the
 * UI; this is the text everything agrees on.
 *
 * The switch is exhaustive with no `default`, so adding a field kind is a
 * compile error here until it's handled — no silently-wrong exports/emails.
 */
export function formatAnswer(field: Field, value: FieldValue): string {
  if (value === null || value === undefined || value === "") return "";

  switch (field.kind) {
    case "file_upload":
      // A field id reused across schema versions with a different kind can hand a
      // scalar to an array case — fail soft instead of throwing on ("hello").map.
      if (!Array.isArray(value)) return String(value);
      return (value as FileValue[]).map((f) => f.name).join(", ");
    case "select":
    case "dropdown":
      return field.options.find((o) => o.id === value)?.label ?? String(value);
    case "multi_select":
      if (!Array.isArray(value)) return String(value);
      return (value as string[])
        .map((id) => field.options.find((o) => o.id === id)?.label ?? id)
        .join(", ");
    case "ranking":
      if (!Array.isArray(value)) return String(value);
      return (value as string[])
        .map((id, i) => `${i + 1}. ${field.options.find((o) => o.id === id)?.label ?? id}`)
        .join(", ");
    case "matrix": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return String(value);
      const answers = value as Record<string, string>;
      return field.rows
        .filter((row) => answers[row.id])
        .map((row) => `${row.label}: ${field.columns.find((c) => c.id === answers[row.id])?.label ?? ""}`)
        .join(", ");
    }
    case "signature":
      return typeof value === "string" && value.startsWith("data:image/") ? "✍ signed" : "";
    case "checkbox":
      return value === true ? "Yes" : "No";
    case "rating":
    case "linear_scale":
      return typeof value === "number" ? String(value) : String(value);
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      // Kind-reuse guard (same as file_upload/calculated): fail soft on a
      // non-numeric value stored under this id by an older schema version.
      if (!Number.isFinite(n)) return String(value);
      // decimals is DISPLAY-ONLY here — the stored value is untouched
      // (contract decision 1); toFixed only pads/rounds what's shown. NEVER
      // grouped (decision 4): the server has no respondent locale, and
      // grid/CSV/email text must stay stable and machine-tolerant.
      const text =
        field.decimals === undefined
          ? String(n)
          : n.toFixed(Math.max(0, Math.min(6, field.decimals)));
      return `${field.prefix ?? ""}${text}${field.suffix ?? ""}`;
    }
    case "calculated": {
      const n = typeof value === "number" ? value : Number(value);
      // Kind-reuse guard (same as file_upload): fail soft on a non-numeric
      // value stored under this id by an older schema version.
      if (!Number.isFinite(n)) return String(value);
      // The stored value is already rounded to `decimals`; toFixed pads the
      // display to a stable width ("12.50", not "12.5").
      const text =
        field.decimals === undefined
          ? String(n)
          : n.toFixed(Math.max(0, Math.min(6, field.decimals)));
      return `${field.prefix ?? ""}${text}${field.suffix ?? ""}`;
    }
    case "repeating_group": {
      // The flattening summary (contract decision 6): "N × itemLabel" plus a
      // compact first-child preview — "3 × Guest: Ada, Grace, Alan" — the one
      // cell text grid/CSV/Sheets/Notion v1 agree on. Full instances render
      // only in rich surfaces (the drawer's nested lists); this stays one line.
      if (!Array.isArray(value)) return String(value); // kind-reuse guard (the file_upload precedent)
      const instances = value as GroupInstanceValue[];
      if (instances.length === 0) return "";
      const noun = field.itemLabel ?? field.label;
      const summary = `${instances.length} × ${noun}`;
      const firstChild = field.fields[0];
      if (!firstChild) return summary;
      // The multi_select join idiom: per-instance texts, ", "-joined; empty
      // (or forged non-object) instances contribute nothing.
      const previews = instances
        .map((instance) =>
          instance && typeof instance === "object" && !Array.isArray(instance)
            ? formatAnswer(firstChild, instance[firstChild.id])
            : "",
        )
        .filter((text) => text !== "");
      return previews.length > 0 ? `${summary}: ${previews.join(", ")}` : summary;
    }
    case "phone": {
      // Pretty international form ("+1 415 555 0123") from the stored E.164.
      const { country, national, e164 } = parsePhone(String(value));
      if (!e164) return String(value);
      const grouped = formatNational(country, national);
      const dial = country ? `+${country.dialCode}` : e164.replace(national, "");
      return grouped ? `${dial} ${grouped}` : e164;
    }
    case "short_text":
    case "long_text":
    case "email":
    case "url":
    case "date":
    case "hidden":
      return String(value);
    case "custom":
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    default:
      return assertNever(field);
  }
}
