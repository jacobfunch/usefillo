import { allFields } from "./logic.js";
import type { Field, FormSchema } from "./types.js";

export function fieldLabel(field: Field): string {
  return field.label.trim() || field.placeholder?.trim() || "Untitled field";
}

export function formLabelIssue(
  schema: FormSchema,
): { fields: { id: string; groupId?: string }[]; message: string } | null {
  const fields = allFields(schema).flatMap<{ field: Field; groupId?: string }>((field) =>
    field.kind === "repeating_group"
      ? [
          { field, groupId: undefined },
          ...field.fields.map((child) => ({ field: child, groupId: field.id })),
        ]
      : [{ field, groupId: undefined }],
  );
  const missing = fields
    .filter(({ field }) => field.kind !== "hidden" && !field.label.trim())
    .map(({ field, groupId }) => ({ id: field.id, ...(groupId ? { groupId } : {}) }));
  if (missing.length === 0) return null;
  return {
    fields: missing,
    message:
      missing.length === 1
        ? "Add a label to the unnamed question before publishing."
        : `Add labels to ${missing.length} unnamed questions before publishing.`,
  };
}
