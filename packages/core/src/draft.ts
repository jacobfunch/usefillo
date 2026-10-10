import { createBlock, createEmptyForm } from "./fields.js";
import { createId } from "./ids.js";
import type { Block, BlockKind, FormSchema, SelectOption } from "./types.js";

/**
 * Turning a natural-language goal into a form: an LLM is good at choosing the
 * right *questions*, but unreliable at the structural plumbing (stable ids,
 * exact per-kind config). So generation targets this lossy spec, and the
 * assembler below rebuilds a structurally-sound schema from `createBlock`
 * defaults — the model only ever supplies the human-meaningful parts.
 */

/**
 * Field kinds the generator may use. Excludes hidden/custom/signature (the
 * first two are code-only concerns and signature is too niche to draft well)
 * and calculated (an LLM can't reliably wire a calc AST to stable field ids —
 * owners add calculations deliberately, in the builder or in code).
 * Also excludes repeating_group (contract decision 11): the flat FieldSpec →
 * createBlock-defaults assembly has no nested-template channel, and a group
 * needs structural choices an LLM gets wrong in ways the assembler can't
 * repair — per-group-unique child ids, the v1 child-kind allowlist, and a
 * deliberate maxInstances bound (required, 1–20). A malformed group is a
 * schema HARD error, so a hallucinated one would brick the whole draft rather
 * than degrade a field. Owners add groups deliberately, in the builder or in
 * code — the calculated precedent.
 */
export const DRAFT_KINDS: readonly BlockKind[] = [
  "short_text",
  "long_text",
  "email",
  "url",
  "phone",
  "number",
  "select",
  "multi_select",
  "dropdown",
  "checkbox",
  "rating",
  "linear_scale",
  "ranking",
  "matrix",
  "date",
  "file_upload",
  "heading",
  "paragraph",
  "divider",
];

/** The LLM-friendly intermediate shape. Everything optional but `kind`. */
export interface FieldSpec {
  kind: string;
  label?: string;
  required?: boolean;
  /** Choice / ranking options, or matrix is handled by rows+columns. */
  options?: string[];
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
  insightsMetric?: "csat" | "nps";
  rows?: string[];
  columns?: string[];
  placeholder?: string;
  /** Content for heading / paragraph blocks. */
  text?: string;
}

export interface FormDraftSpec {
  title?: string;
  description?: string;
  pages?: Array<{ title?: string; fields?: FieldSpec[] }>;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.round(value);
  return n < lo ? lo : n > hi ? hi : n;
}

/** Clean a list of labels into options, keeping the default if the LLM gave too few. */
function toOptions(labels: string[] | undefined, fallback: SelectOption[]): SelectOption[] {
  const cleaned = (Array.isArray(labels) ? labels : [])
    .map((l) => str(l, 200))
    .filter(Boolean);
  if (cleaned.length < 2) return fallback;
  return cleaned.slice(0, 100).map((label) => ({ id: createId(6), label }));
}

function assembleBlock(spec: FieldSpec): Block | null {
  const kind = spec.kind as BlockKind;
  if (!DRAFT_KINDS.includes(kind)) return null;

  // Start from a fully-formed default and overwrite only known-safe fields.
  const block = createBlock(kind) as Block & Record<string, unknown>;
  const label = str(spec.label, 500);

  if (kind === "heading" || kind === "paragraph") {
    block.text = str(spec.text, 2000) || label || (block.text as string);
    return block;
  }
  if (kind === "divider") return block;

  if (label) block.label = label;
  if (spec.required) block.required = true;
  if (spec.placeholder) block.placeholder = str(spec.placeholder, 200);

  switch (kind) {
    case "select":
    case "multi_select":
    case "dropdown":
    case "ranking":
      block.options = toOptions(spec.options, block.options as SelectOption[]);
      break;
    case "rating":
      block.max = clampInt(spec.max, 3, 10, 5);
      if (spec.insightsMetric === "csat" && block.max === 5) {
        block.insightsMetric = "csat";
      }
      break;
    case "linear_scale":
      block.min = spec.min === 0 ? 0 : 1;
      block.max = clampInt(spec.max, 2, 10, 10);
      if (spec.minLabel) block.minLabel = str(spec.minLabel, 100);
      if (spec.maxLabel) block.maxLabel = str(spec.maxLabel, 100);
      delete block.insightsMetric;
      if (spec.insightsMetric === "nps" && block.min === 0 && block.max === 10) {
        block.insightsMetric = "nps";
      } else if (spec.insightsMetric === "csat" && block.min === 1 && block.max === 5) {
        block.insightsMetric = "csat";
      }
      break;
    case "number":
      if (typeof spec.min === "number") block.min = spec.min;
      if (typeof spec.max === "number") block.max = spec.max;
      break;
    case "matrix":
      block.rows = toOptions(spec.rows, block.rows as SelectOption[]);
      block.columns = toOptions(spec.columns, block.columns as SelectOption[]);
      break;
  }
  return block;
}

/**
 * Build a valid {@link FormSchema} from an untrusted draft spec. Unknown kinds
 * and empty pages are dropped; if nothing survives, a single empty page is
 * kept so the builder always has something to render. The result should still
 * be passed through `validateFormSchema` before persisting.
 */
export function assembleForm(spec: FormDraftSpec): FormSchema {
  const form = createEmptyForm(str(spec.title, 200) || "Untitled form");
  const description = str(spec.description, 1000);
  if (description) form.description = description;

  const pages = (Array.isArray(spec.pages) ? spec.pages : [])
    .slice(0, 20)
    .map((page) => ({
      id: createId(8),
      title: str(page.title, 200) || undefined,
      blocks: (Array.isArray(page.fields) ? page.fields : [])
        .slice(0, 100)
        .map(assembleBlock)
        .filter((b): b is Block => b !== null),
    }))
    .filter((page) => page.blocks.length > 0);

  if (pages.length > 0) form.pages = pages;
  return form;
}
