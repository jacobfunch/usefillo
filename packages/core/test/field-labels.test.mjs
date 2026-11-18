import assert from "node:assert/strict";
import test from "node:test";
import { createBlock, fieldLabel, formLabelIssue, validateFormSchema } from "../dist/index.js";

const schema = (blocks) => ({
  version: 1,
  title: "Application",
  settings: {},
  pages: [{ id: "details", blocks }],
});

test("blank labels remain editable but cannot be published", () => {
  const draft = schema([{ id: "email", kind: "email", label: " \t", placeholder: "Work email" }]);
  const result = validateFormSchema(draft);
  assert.equal(result.ok, true);
  assert.equal(result.schema.pages[0].blocks[0].label, "");
  assert.deepEqual(formLabelIssue(result.schema), {
    fields: [{ id: "email" }],
    message: "Add a label to the unnamed question before publishing.",
  });
  result.schema.pages[0].blocks[0].label = "Work email";
  assert.equal(formLabelIssue(result.schema), null);
});

test("every visible field kind needs a label, even when conditionally hidden", () => {
  const kinds = [
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
    "signature",
    "date",
    "file_upload",
    "calculated",
    "custom",
  ];
  for (const kind of kinds) {
    const field = {
      ...createBlock(kind),
      label: "",
      visibleIf: [{ fieldId: "gate", op: "answered" }],
    };
    assert.deepEqual(formLabelIssue(schema([field]))?.fields, [{ id: field.id }], kind);
  }
});

test("checks group labels and child labels across pages but permits hidden metadata", () => {
  const draft = schema([
    { id: "source", kind: "hidden", label: "" },
    { id: "section", kind: "heading", text: "Experience" },
    {
      ...createBlock("repeating_group"),
      id: "jobs",
      label: "",
      fields: [
        { id: "company", kind: "short_text", label: " " },
        { id: "role", kind: "short_text", label: "Role" },
      ],
    },
  ]);
  draft.pages.push({ id: "links", blocks: [{ id: "portfolio", kind: "url", label: "" }] });
  assert.deepEqual(formLabelIssue(draft)?.fields, [
    { id: "jobs" },
    { id: "company", groupId: "jobs" },
    { id: "portfolio" },
  ]);
  assert.equal(formLabelIssue(schema([{ id: "source", kind: "hidden", label: "" }])), null);
});

test("legacy display labels fall back without mutating the label or required setting", () => {
  const field = {
    id: "email",
    kind: "email",
    label: "",
    placeholder: "Work email",
    required: false,
  };
  assert.equal(fieldLabel(field), "Work email");
  assert.equal(field.label, "");
  assert.equal(field.required, false);
  assert.equal(fieldLabel({ ...field, label: "Email address" }), "Email address");
  assert.equal(fieldLabel({ ...field, placeholder: " " }), "Untitled field");
  assert.equal(fieldLabel({ ...field, placeholder: "Email *" }), "Email *");
  assert.equal(field.required, false);
});

test("reused child ids retain their group scope for publication feedback", () => {
  const draft = schema([
    { id: "name", kind: "short_text", label: "Name" },
    ...["guests", "hosts"].map((id) => ({
      ...createBlock("repeating_group"),
      id,
      label: id,
      fields: [{ id: "name", kind: "short_text", label: "" }],
    })),
  ]);
  assert.deepEqual(formLabelIssue(draft)?.fields, [
    { id: "name", groupId: "guests" },
    { id: "name", groupId: "hosts" },
  ]);
});
