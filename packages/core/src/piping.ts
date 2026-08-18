import type { Block, FormSchema, ResponseData } from "./types.js";
import { allFields } from "./logic.js";

const TOKEN = /\{\{\s*([\w-]+)\s*\}\}/g;

/**
 * Resolve `{{field_id}}` tokens in a string against the current answers —
 * "answer piping". Choice answers resolve to their option label, not the id.
 * Unanswered references become empty.
 */
export function resolveText(text: string, data: ResponseData, form: FormSchema): string {
  if (!text.includes("{{")) return text;
  const fields = allFields(form);
  return text.replace(TOKEN, (_, id: string) => {
    const field = fields.find((f) => f.id === id);
    const value = data[id];
    if (value === null || value === undefined || value === "") return "";
    const label = (optionId: string) =>
      field && "options" in field
        ? (field.options.find((o) => o.id === optionId)?.label ?? optionId)
        : optionId;
    if (Array.isArray(value)) return value.map((v) => label(String(v))).join(", ");
    if (typeof value === "string") return label(value);
    return String(value);
  });
}

/** Return a copy of a block with its visible text fields piped, or the block unchanged. */
export function pipeBlock(block: Block, data: ResponseData, form: FormSchema): Block {
  const pipe = (s: string | undefined) => (s === undefined ? s : resolveText(s, data, form));
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return { ...block, text: resolveText(block.text, data, form) };
    case "divider":
      return block;
    default:
      return { ...block, label: resolveText(block.label, data, form), description: pipe(block.description) };
  }
}
