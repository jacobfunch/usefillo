import type { Block, BlockKind, FormSchema } from "./types.js";
import { createId } from "./ids.js";

/** Display metadata for every block kind — drives the builder palette. */
export const BLOCK_KIND_META: Record<BlockKind, { label: string; hint: string }> = {
  short_text: { label: "Short text", hint: "Single line answer" },
  long_text: { label: "Long text", hint: "Multi-line answer" },
  email: { label: "Email", hint: "Validated email address" },
  url: { label: "Link", hint: "Validated URL" },
  phone: { label: "Phone", hint: "Phone number" },
  number: { label: "Number", hint: "Numeric answer with min/max" },
  select: { label: "Single choice", hint: "Radio buttons" },
  multi_select: { label: "Multiple choice", hint: "Checkboxes" },
  dropdown: { label: "Dropdown", hint: "Select from a list" },
  checkbox: { label: "Yes / No", hint: "Single checkbox" },
  rating: { label: "Rating", hint: "1–5 stars" },
  linear_scale: { label: "Linear scale", hint: "0–10 with end labels" },
  ranking: { label: "Ranking", hint: "Order options by preference" },
  matrix: { label: "Matrix", hint: "Grid of rows × choices" },
  signature: { label: "Signature", hint: "Draw to sign" },
  date: { label: "Date", hint: "Date picker" },
  file_upload: { label: "File upload", hint: "Direct to connected storage" },
  hidden: { label: "Hidden field", hint: "Filled from the URL" },
  calculated: { label: "Calculated value", hint: "Computed from other answers" },
  repeating_group: { label: "Repeating group", hint: "A set of fields respondents can repeat" },
  custom: { label: "Custom", hint: "Your own component (code only)" },
  heading: { label: "Heading", hint: "Section title" },
  paragraph: { label: "Paragraph", hint: "Explanatory text" },
  divider: { label: "Divider", hint: "Visual break" },
};

/** A new block of the given kind with sensible defaults, ready for the builder. */
export function createBlock(kind: BlockKind): Block {
  const id = createId(8);
  switch (kind) {
    case "heading":
      return { id, kind, text: "Section heading" };
    case "paragraph":
      return { id, kind, text: "Add some context for your respondents." };
    case "divider":
      return { id, kind };
    case "select":
    case "multi_select":
    case "dropdown":
      return {
        id,
        kind,
        label: BLOCK_KIND_META[kind].label,
        options: [
          { id: createId(6), label: "Option 1" },
          { id: createId(6), label: "Option 2" },
        ],
      };
    case "rating":
      return { id, kind, label: "How would you rate it?", max: 5 };
    case "linear_scale":
      return {
        id,
        kind,
        label: "How likely are you to recommend us?",
        min: 0,
        max: 10,
        minLabel: "Not at all likely",
        maxLabel: "Extremely likely",
        insightsMetric: "nps",
      };
    case "ranking":
      return {
        id,
        kind,
        label: "Rank these options",
        options: [
          { id: createId(6), label: "Option 1" },
          { id: createId(6), label: "Option 2" },
          { id: createId(6), label: "Option 3" },
        ],
      };
    case "matrix":
      return {
        id,
        kind,
        label: "Rate each item",
        rows: [
          { id: createId(6), label: "Quality" },
          { id: createId(6), label: "Price" },
        ],
        columns: [
          { id: createId(6), label: "Poor" },
          { id: createId(6), label: "Fair" },
          { id: createId(6), label: "Good" },
        ],
      };
    case "signature":
      return { id, kind, label: "Sign here" };
    case "hidden":
      return { id, kind, label: "Hidden field" };
    case "calculated":
      // A freshly added block must already be a VALID schema (an empty n-ary
      // node like add of zero args is a hard error) — start from a constant
      // and let the owner point it at real fields.
      return { id, kind, label: "Calculated value", calc: { op: "const", value: 0 } };
    case "repeating_group":
      // Same rule: an EMPTY container is a schema hard error, and maxInstances
      // is required — seed one short_text child and a sensible bound so a
      // freshly added block validates as-is (contract decision 10).
      return {
        id,
        kind,
        label: "Repeating group",
        maxInstances: 5,
        fields: [{ id: createId(6), kind: "short_text", label: "Short text" }],
      };
    case "custom":
      return { id, kind, label: "Custom field", component: "" };
    case "file_upload":
      return { id, kind, label: "Upload a file", maxFiles: 1, maxFileSizeMb: 500 };
    case "checkbox":
      return { id, kind, label: "I agree" };
    case "phone":
      return { id, kind, label: "Phone number" };
    default:
      return { id, kind, label: BLOCK_KIND_META[kind].label };
  }
}

/** A minimal valid empty form. */
export function createEmptyForm(title = "Untitled form"): FormSchema {
  return {
    version: 1,
    title,
    pages: [{ id: createId(8), blocks: [] }],
    settings: {
      submitMode: "button",
      submitLabel: "Submit",
      successTitle: "Thanks!",
      successMessage: "Your response has been recorded.",
      showProgress: true,
    },
  };
}
