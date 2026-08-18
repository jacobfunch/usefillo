import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_KIND_META,
  DRAFT_KINDS,
  FILLO_CALC_MIN_SDK_VERSION,
  FILLO_GROUP_MIN_SDK_VERSION,
  FILLO_MIN_SDK_VERSION,
  JSX_BLOCK_COMPONENTS as B,
  computeCalculated,
  createBlock,
  formatAnswer,
  isAutoSubmitBlock,
  needsExplicitSubmit,
  normalizeFormSchema,
  prefillFromParams,
  schemaFromJsx,
  validateField,
  validateFormSchema,
  validateResponse,
  visibleFields,
  visibleGroupChildren,
} from "../dist/index.js";

// ---------- Shared fixtures ----------

const form = (blocks, extra = {}) => ({
  version: 1,
  title: "G",
  settings: {},
  pages: [{ id: "p1", blocks }],
  ...extra,
});

const text = (id, extra = {}) => ({ id, kind: "short_text", label: id, ...extra });

/** The standard test group: a required name, a checkbox controller, and a
 *  select that is visible only when the checkbox is checked. */
const guests = (extra = {}) => ({
  id: "guests",
  kind: "repeating_group",
  label: "Guests",
  itemLabel: "Guest",
  maxInstances: 3,
  minInstances: 1,
  fields: [
    { id: "name", kind: "short_text", label: "Name", required: true },
    { id: "veg", kind: "checkbox", label: "Vegetarian" },
    {
      id: "meal",
      kind: "select",
      label: "Meal",
      options: [{ id: "salad", label: "Salad" }, { id: "steak", label: "Steak" }],
      visibleIf: [{ fieldId: "veg", op: "eq", value: true }],
    },
  ],
  ...extra,
});

const normalize = (blocks, extra) => {
  const result = normalizeFormSchema(form(blocks, extra));
  assert.equal(result.ok, true, result.error);
  return result.schema;
};

const groupOf = (schema) => schema.pages[0].blocks.find((b) => b.kind === "repeating_group");

// ---------- Normalization: valid round-trip ----------

test("a valid group round-trips: props kept, minInstances default written back, children normalized through the per-kind cases", () => {
  const schema = normalize([
    guests({ minInstances: undefined, addLabel: "  Add a guest  ", itemLabel: " Guest " }),
  ]);
  const group = groupOf(schema);
  assert.equal(group.maxInstances, 3);
  // The default is written back explicitly — normalized schemas always carry it.
  assert.equal(group.minInstances, 1);
  assert.equal(group.addLabel, "Add a guest");
  assert.equal(group.itemLabel, "Guest");
  assert.equal(group.required, false, "a container is never generic-required");
  assert.deepEqual(group.fields.map((f) => f.id), ["name", "veg", "meal"]);
  // Child visibleIf survives (same-group sibling — legal).
  assert.deepEqual(group.fields[2].visibleIf, [{ fieldId: "veg", op: "eq", value: true }]);
});

test("children are normalized by the EXISTING per-kind cases, not a parallel path", () => {
  const schema = normalize([
    guests({
      fields: [
        { id: "score", kind: "rating", label: "Score", max: 100 }, // clamps to 10
        { id: "ph", kind: "phone", label: "Ph", defaultCountry: "us" }, // uppercased
        { id: "note", kind: "long_text", label: "Note", maxLength: 99999 }, // clamps to 20000
      ],
    }),
  ]);
  const [score, ph, note] = groupOf(schema).fields;
  assert.equal(score.max, 10);
  assert.equal(ph.defaultCountry, "US");
  assert.equal(note.maxLength, 20000);
});

test("non-field children (content blocks) are dropped by normalization", () => {
  const schema = normalize([
    guests({
      fields: [
        { id: "h", kind: "heading", text: "Nope" },
        { id: "name", kind: "short_text", label: "Name" },
      ],
    }),
  ]);
  assert.deepEqual(groupOf(schema).fields.map((f) => f.id), ["name"]);
});

test("child-id scoping: the same child id in two different groups is legal, and a child id may equal a top-level id", () => {
  const schema = normalize([
    text("name"), // top-level field with the same id as a child
    guests({ id: "g1", fields: [text("name"), text("email_child")] }),
    guests({ id: "g2", fields: [text("name")] }),
  ]);
  assert.equal(schema.pages[0].blocks.length, 3);
});

// ---------- Normalization: the hard-error catalog ----------

const expectError = (blocks, pattern, extra) => {
  const result = normalizeFormSchema(form(blocks, extra));
  assert.equal(result.ok, false, `expected a hard error, got ok for ${pattern}`);
  assert.match(result.error, pattern, result.error);
  return result.error;
};

test("hard error: maxInstances missing, out of range, or fractional", () => {
  for (const maxInstances of [undefined, 0, 21, 2.5, "3"]) {
    expectError(
      [guests({ maxInstances })],
      /Repeating group guests needs maxInstances to be a whole number between 1 and 20/,
    );
  }
});

test("hard error: minInstances out of range or fractional", () => {
  for (const minInstances of [-1, 4, 1.5]) {
    expectError(
      [guests({ minInstances })],
      /Repeating group guests needs minInstances to be a whole number between 0 and maxInstances \(3\)/,
    );
  }
});

test("hard error: an empty template (a fresh container must be valid, so empty ones are invalid)", () => {
  expectError([guests({ fields: [] })], /Repeating group guests has no template fields — add at least one field to repeat/);
});

test("hard error: more than 12 template children", () => {
  const fields = Array.from({ length: 13 }, (_, i) => text(`c${i}`));
  expectError([guests({ fields })], /Repeating group guests has 13 template fields — the maximum is 12; split it into fewer fields/);
});

test("hard error: every disallowed child kind names the allowlist — including nested groups and calculated", () => {
  const disallowed = [
    { id: "m", kind: "matrix", label: "M", rows: [{ id: "r", label: "R" }], columns: [{ id: "c", label: "C" }] },
    { id: "rk", kind: "ranking", label: "R", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    { id: "f", kind: "file_upload", label: "F" },
    { id: "s", kind: "signature", label: "S" },
    { id: "h", kind: "hidden", label: "H" },
    { id: "cal", kind: "calculated", label: "C", calc: { op: "const", value: 1 } },
    { id: "cu", kind: "custom", label: "Cu", component: "x" },
    guests({ id: "nested" }), // nested repeating_group — never in v1
  ];
  for (const child of disallowed) {
    const error = expectError(
      [guests({ fields: [child] })],
      new RegExp(`Repeating group guests has a "${child.kind}" child \\(${child.id}\\)`),
    );
    assert.match(error, /allowed child kinds are short_text, long_text, email, url, phone, number, select, multi_select, dropdown, checkbox, date, rating, linear_scale/);
  }
});

test("hard error: duplicate child ids WITHIN a group (the duplicateOptionId per-block precedent)", () => {
  expectError(
    [guests({ fields: [text("dup"), text("dup")] })],
    /Duplicate child id in repeating group guests: dup/,
  );
});

test("hard error: a child visibleIf referencing outside its group (inward scope wall)", () => {
  // References a real top-level field — still walled.
  expectError(
    [text("outer"), guests({ fields: [text("name", { visibleIf: [{ fieldId: "outer", op: "answered" }] })] })],
    /Field name in repeating group guests has a visibleIf referencing "outer" — a child's visibleIf can only reference another field in the SAME group/,
  );
  // References a child of ANOTHER group — walled too.
  expectError(
    [
      guests({ id: "g1", fields: [text("a1")] }),
      guests({ id: "g2", fields: [text("b1", { visibleIf: [{ fieldId: "a1", op: "answered" }] })] }),
    ],
    /Field b1 in repeating group g2 has a visibleIf referencing "a1"/,
  );
});

test("hard error: an outer visibleIf referencing a group child (outward scope wall)", () => {
  expectError(
    [guests(), text("after", { visibleIf: [{ fieldId: "name", op: "answered" }] })],
    /Field after's visibleIf references "name", which is a child of repeating group guests — fields outside a repeating group can't reference its children/,
  );
});

test("hard error: a jump rule referencing a group child is loud, never a silently dropped rule", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "G",
    settings: {},
    pages: [
      { id: "p1", blocks: [guests()], next: [{ when: [{ fieldId: "name", op: "answered" }], to: "p2" }] },
      { id: "p2", blocks: [text("t")] },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(
    result.error,
    /A jump rule on page p1 references "name", which is a child of repeating group guests — jumps can't reference a repeating group's children/,
  );
});

test("hard error: a calc operand referencing a group child names the wall, not just 'missing field'", () => {
  expectError(
    [
      guests({ fields: [{ id: "qty", kind: "number", label: "Qty" }] }),
      { id: "total", kind: "calculated", label: "T", calc: { op: "value", fieldId: "qty" } },
    ],
    /Calculated field total references qty, which is a child of repeating group guests — calculations can't reach inside a repeating group \(calc operands must be top-level fields\)/,
  );
  // A genuinely missing id keeps the original message.
  expectError(
    [text("a"), { id: "total", kind: "calculated", label: "T", calc: { op: "value", fieldId: "ghost" } }],
    /Calculated field total references a missing field: ghost — remove the reference or restore that field/,
  );
});

test("hard error: the authoring-time worst-case size estimate past ~180KB (the MAX_CALC cap precedent)", () => {
  const fields = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`,
    kind: "long_text",
    label: `T${i}`,
    maxLength: 20000,
  }));
  const error = expectError(
    [guests({ maxInstances: 20, minInstances: 0, fields })],
    /Repeating group guests could reach ~\d+KB at 20 instances — the maximum is ~180KB; lower maxInstances, shorten text limits, or trim the template/,
  );
  assert.match(error, /~180KB/);
  // The same template with capped text limits passes — the estimate tracks the
  // bounds validateField actually enforces.
  const capped = fields.map((f) => ({ ...f, maxLength: 500 }));
  const ok = normalizeFormSchema(form([guests({ maxInstances: 20, minInstances: 0, fields: capped })]));
  assert.equal(ok.ok, true, ok.error);
});

test("clamps: addLabel/itemLabel are length-capped, blank means unset", () => {
  const schema = normalize([
    guests({ addLabel: "x".repeat(500), itemLabel: "   " }),
  ]);
  const group = groupOf(schema);
  assert.equal(group.addLabel.length, 100);
  assert.equal(group.itemLabel, undefined);
});

// ---------- Canonical recursion (through validateResponse's kept data) ----------

test("canonical: per-instance per-child trim/coerce, unknown-key drop, empty drop", () => {
  const schema = normalize([
    guests({
      fields: [
        { id: "name", kind: "short_text", label: "Name" },
        { id: "qty", kind: "number", label: "Qty" },
        { id: "score", kind: "rating", label: "Score", max: 5 },
        { id: "veg", kind: "checkbox", label: "Veg" },
      ],
    }),
  ]);
  const result = validateResponse(schema, {
    guests: [
      { name: "  Ada  ", qty: "5", score: "3", veg: false, forged_key: "evil" },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // Trimmed, coerced, unknown key gone, false checkbox dropped as empty.
  assert.deepEqual(result.data.guests, [{ name: "Ada", qty: 5, score: 3 }]);
});

test("canonical: a non-array value under a group id reads as unanswered", () => {
  const schema = normalize([guests()]);
  // min 1 → unanswered is a REAL count error under the plain group id.
  const r1 = validateResponse(schema, { guests: "forged string" });
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.errors, { guests: "Add at least 1 entry" });
  // min 0 → unanswered is simply absent, silently.
  const optional = normalize([guests({ minInstances: 0 })]);
  const r2 = validateResponse(optional, { guests: { sneaky: "object" } });
  assert.equal(r2.ok, true);
  assert.equal("guests" in r2.data, false);
});

test("canonical: a forged non-object INSTANCE is rejected per the tamper rule, never silently dropped", () => {
  const schema = normalize([guests()]);
  const result = validateResponse(schema, { guests: [{ name: "Ada" }, "forged"] });
  assert.equal(result.ok, false);
  assert.equal(result.errors.guests, "Invalid value");
  assert.equal("guests" in result.data, false, "an invalid group is not kept");
});

test("canonical: an all-empty instance survives as {} so the respondent-controlled count is preserved", () => {
  const schema = normalize([guests({ minInstances: 0, fields: [text("note")] })]);
  const result = validateResponse(schema, { guests: [{ note: "hi" }, { note: "   " }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.guests, [{ note: "hi" }, {}]);
});

// ---------- Validation: counts, compound keys, per-instance visibility ----------

test("count validation 422s in both directions under the PLAIN group id", () => {
  const schema = normalize([guests({ minInstances: 2, maxInstances: 3 })]);
  const low = validateResponse(schema, { guests: [{ name: "Ada" }] });
  assert.equal(low.ok, false);
  assert.equal(low.errors.guests, "Add at least 2 entries");

  const high = validateResponse(schema, {
    guests: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
  });
  assert.equal(high.ok, false);
  assert.equal(high.errors.guests, "At most 3 entries");

  const single = normalize([guests({ minInstances: 1, maxInstances: 1 })]);
  assert.equal(validateResponse(single, { guests: [] }).errors.guests, "Add at least 1 entry");
  assert.equal(
    validateResponse(single, { guests: [{ name: "A" }, { name: "B" }] }).errors.guests,
    "At most 1 entry",
  );
});

test('per-child kind errors land under the compound "groupId.index.childId" key', () => {
  const schema = normalize([
    guests({
      fields: [
        { id: "name", kind: "short_text", label: "Name", required: true },
        { id: "contact", kind: "email", label: "Contact" },
        { id: "qty", kind: "number", label: "Qty", min: 1, max: 10 },
      ],
    }),
  ]);
  const result = validateResponse(schema, {
    guests: [
      { name: "Ada", contact: "not-an-email", qty: 99 },
      { contact: "ok@example.com" },
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, {
    "guests.0.contact": "Enter a valid email address",
    "guests.0.qty": "Must be at most 10",
    "guests.1.name": "This field is required",
  });
});

test("forged child TYPES are rejected per kind under the compound key (tamper rule)", () => {
  const schema = normalize([
    guests({
      fields: [
        { id: "qty", kind: "number", label: "Qty" },
        { id: "veg", kind: "checkbox", label: "Veg" },
      ],
    }),
  ]);
  const result = validateResponse(schema, { guests: [{ qty: { evil: 1 }, veg: "yes" }] });
  assert.equal(result.ok, false);
  assert.equal(result.errors["guests.0.qty"], "Enter a number");
  assert.equal(result.errors["guests.0.veg"], "Invalid value");
});

test("per-instance visibleIf: a logic-hidden child is neither required nor kept — per instance", () => {
  const schema = normalize([
    guests({
      fields: [
        { id: "veg", kind: "checkbox", label: "Veg" },
        {
          id: "meal",
          kind: "select",
          label: "Meal",
          required: true,
          options: [{ id: "salad", label: "Salad" }],
          visibleIf: [{ fieldId: "veg", op: "eq", value: true }],
        },
      ],
    }),
  ]);
  // Instance 0: controller checked → meal required and kept.
  // Instance 1: controller unchecked → meal hidden: its required does NOT fire
  // and its stale value is dropped from the kept instance.
  const result = validateResponse(schema, {
    guests: [
      { veg: true, meal: "salad" },
      { veg: false, meal: "salad" },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.data.guests, [{ veg: true, meal: "salad" }, {}]);

  // ...and the required DOES fire in exactly the instance whose controller is on.
  const missing = validateResponse(schema, { guests: [{ veg: true }, { veg: false }] });
  assert.equal(missing.ok, false);
  assert.deepEqual(Object.keys(missing.errors), ["guests.0.meal"]);
});

test("validateField on the group itself: shape + count only (the single-message surface)", () => {
  const schema = normalize([guests({ minInstances: 2 })]);
  const group = groupOf(schema);
  assert.equal(validateField(group, undefined), "Add at least 2 entries");
  assert.equal(validateField(group, [{ name: "A" }, { name: "B" }]), null);
  assert.equal(validateField(group, [1, 2]), "Invalid value");
  assert.equal(validateField(group, "scalar"), "Add at least 2 entries");
});

// ---------- The answered semantic (top-level logic reads the group opaquely) ----------

test("answered = instance count ≥ max(1, minInstances); below threshold the group reads UNANSWERED", () => {
  const build = (minInstances) =>
    normalize([
      guests({ minInstances, maxInstances: 5 }),
      text("thanks", { visibleIf: [{ fieldId: "guests", op: "answered" }] }),
      text("nudge", { visibleIf: [{ fieldId: "guests", op: "not_answered" }] }),
    ]);
  const visibleIds = (schema, data) => visibleFields(schema, data).map((f) => f.id);

  // min 2: one instance is NOT answered; two is.
  const min2 = build(2);
  assert.deepEqual(visibleIds(min2, {}), ["guests", "nudge"]);
  assert.deepEqual(visibleIds(min2, { guests: [{ name: "A" }] }), ["guests", "nudge"]);
  assert.deepEqual(visibleIds(min2, { guests: [{ name: "A" }, { name: "B" }] }), ["guests", "thanks"]);

  // min 0: max(1, 0) = 1 — zero instances is unanswered, one is answered.
  const min0 = build(0);
  assert.deepEqual(visibleIds(min0, {}), ["guests", "nudge"]);
  assert.deepEqual(visibleIds(min0, { guests: [] }), ["guests", "nudge"]);
  assert.deepEqual(visibleIds(min0, { guests: [{ name: "A" }] }), ["guests", "thanks"]);
});

// ---------- Scoped visibility helper: the semantics table ----------

test("visibleGroupChildren semantics table", () => {
  const schema = normalize([
    guests({
      fields: [
        { id: "a", kind: "checkbox", label: "A" },
        { id: "b", kind: "short_text", label: "B", visibleIf: [{ fieldId: "a", op: "eq", value: true }] },
        { id: "c", kind: "short_text", label: "C", visibleIf: [{ fieldId: "b", op: "eq", value: "yes" }] },
        { id: "d", kind: "short_text", label: "D" },
      ],
    }),
  ]);
  const group = groupOf(schema);
  const ids = (instance) => visibleGroupChildren(group, instance).map((f) => f.id);

  const cases = [
    // [instance values, expected visible ids, description]
    [{}, ["a", "d"], "unconditioned children only when nothing is answered"],
    [{ a: true }, ["a", "b", "d"], "controller on reveals the direct dependent"],
    [{ a: true, b: "yes" }, ["a", "b", "c", "d"], "chained reveal in template order"],
    [{ a: true, b: " yes " }, ["a", "b", "c", "d"], "canonical discipline: padded sibling value trims before eq"],
    [{ a: false, b: "yes" }, ["a", "d"], "hidden controller cascades: b's stale value cannot reveal c"],
    [{ b: "yes" }, ["a", "d"], "a value behind an unanswered controller stays dark"],
    ["forged", ["a", "d"], "a forged non-object instance reads as nothing answered"],
  ];
  for (const [instance, expected, why] of cases) {
    assert.deepEqual(ids(instance), expected, why);
  }
});

// ---------- Format summary ----------

test('formatAnswer summary: "N × itemLabel" + compact first-child preview', () => {
  const schema = normalize([guests()]);
  const group = groupOf(schema);
  assert.equal(
    formatAnswer(group, [{ name: "Ada" }, { name: "Grace" }, { name: "Alan" }]),
    "3 × Guest: Ada, Grace, Alan",
  );
  // No first-child answers → bare summary, no dangling colon.
  assert.equal(formatAnswer(group, [{ veg: true }, {}]), "2 × Guest");
  // Empty array → empty string (unanswered).
  assert.equal(formatAnswer(group, []), "");
  // itemLabel falls back to the field label.
  const unlabeled = normalize([guests({ itemLabel: undefined })]);
  assert.equal(formatAnswer(groupOf(unlabeled), [{ name: "Ada" }]), "1 × Guests: Ada");
  // Kind-reuse guard: a scalar under the id fails soft, never throws.
  assert.equal(formatAnswer(group, "legacy"), "legacy");
  // First-child preview uses the CHILD's own formatting (select label, not id).
  const meals = normalize([
    guests({ fields: [{ id: "meal", kind: "select", label: "Meal", options: [{ id: "salad", label: "Salad" }] }] }),
  ]);
  assert.equal(formatAnswer(groupOf(meals), [{ meal: "salad" }]), "1 × Guest: Salad");
});

// ---------- Builder seeds ----------

test("BLOCK_KIND_META has the palette entry and createBlock seeds a VALID fresh group", () => {
  assert.equal(typeof BLOCK_KIND_META.repeating_group.label, "string");
  assert.equal(typeof BLOCK_KIND_META.repeating_group.hint, "string");
  const fresh = createBlock("repeating_group");
  assert.equal(fresh.kind, "repeating_group");
  assert.equal(fresh.fields.length, 1, "seeds exactly one child");
  assert.equal(fresh.fields[0].kind, "short_text");
  assert.equal(typeof fresh.maxInstances, "number");
  const validated = validateFormSchema(form([fresh]));
  assert.equal(validated.ok, true, validated.error);
});

// ---------- Ancillary postures ----------

test("DRAFT_KINDS excludes repeating_group (LLM assembly can't build templates)", () => {
  assert.equal(DRAFT_KINDS.includes("repeating_group"), false);
});

test("prefill: a group id in the URL is an explicit no-op — never a raw string under the group key", () => {
  const schema = normalize([guests({ minInstances: 0 }), text("other")]);
  const data = prefillFromParams(schema, { guests: '[{"name":"evil"}]', other: "hi" });
  assert.equal("guests" in data, false);
  assert.equal(data.other, "hi");
});

test("auto-submit: a group is never eligible and always needs an explicit button", () => {
  const schema = normalize([guests()]);
  const group = groupOf(schema);
  assert.equal(isAutoSubmitBlock(group), false);
  // A page holding only the group: it IS the one interactive question, and it
  // can't one-tap — so a button is required.
  assert.equal(needsExplicitSubmit([group]), true);
});

// ---------- JSX: <Fillo.RepeatingGroup> round-trip ----------

const el = (type, props = {}, children) => ({
  type,
  props: children === undefined ? props : { ...props, children },
});

test("<Fillo.RepeatingGroup> with children builds through the reentrant walk and passes server validation", () => {
  const schema = schemaFromJsx(
    [
      el(B.RepeatingGroup, { id: "guests", label: "Guests", itemLabel: "Guest", minInstances: 1, maxInstances: 3, addLabel: "Add a guest" }, [
        el(B.Text, { id: "name", label: "Name", required: true }),
        el(B.Checkbox, { id: "veg", label: "Vegetarian" }),
        el(
          B.Select,
          { id: "meal", label: "Meal", visibleIf: [{ fieldId: "veg", op: "eq", value: true }] },
          [el(B.Option, { id: "salad", label: "Salad" }), el(B.Option, { id: "steak", label: "Steak" })],
        ),
      ]),
    ],
    { id: "party", title: "Party" },
  );
  // Canonical sparse emission: id/kind first, base + declared props, fields
  // before visibleIf-last; children compiled into `fields` with the child
  // Select's Option children resolved (the reentrant trio).
  assert.deepEqual(schema.pages[0].blocks[0], {
    id: "guests",
    kind: "repeating_group",
    label: "Guests",
    minInstances: 1,
    maxInstances: 3,
    addLabel: "Add a guest",
    itemLabel: "Guest",
    fields: [
      { id: "name", kind: "short_text", label: "Name", required: true },
      { id: "veg", kind: "checkbox", label: "Vegetarian" },
      {
        id: "meal",
        kind: "select",
        label: "Meal",
        options: [{ id: "salad", label: "Salad" }, { id: "steak", label: "Steak" }],
        visibleIf: [{ fieldId: "veg", op: "eq", value: true }],
      },
    ],
  });
  const validated = validateFormSchema(schema);
  assert.equal(validated.ok, true, validated.error);
});

test("JSX global-id rules: the group id is global; child ids are per-group", () => {
  // Same child id in two groups + a child id equal to a global id: legal.
  const schema = schemaFromJsx(
    [
      el(B.Text, { id: "name", label: "Top name" }),
      el(B.RepeatingGroup, { id: "g1", label: "G1", maxInstances: 2 }, [el(B.Text, { id: "name", label: "N" })]),
      el(B.RepeatingGroup, { id: "g2", label: "G2", maxInstances: 2 }, [el(B.Text, { id: "name", label: "N" })]),
    ],
    { id: "f", title: "F" },
  );
  assert.equal(validateFormSchema(schema).ok, true);

  // A duplicate GROUP id is still a global duplicate.
  assert.throws(
    () =>
      schemaFromJsx(
        [
          el(B.RepeatingGroup, { id: "g", label: "A", maxInstances: 2 }, [el(B.Text, { id: "a", label: "A" })]),
          el(B.RepeatingGroup, { id: "g", label: "B", maxInstances: 2 }, [el(B.Text, { id: "b", label: "B" })]),
        ],
        { id: "f", title: "F" },
      ),
    /DUPLICATE_ID/i,
  );

  // Duplicate child ids WITHIN one group throw with the per-group message.
  assert.throws(
    () =>
      schemaFromJsx(
        [
          el(B.RepeatingGroup, { id: "g", label: "G", maxInstances: 2 }, [
            el(B.Text, { id: "dup", label: "One" }),
            el(B.Email, { id: "dup", label: "Two" }),
          ]),
        ],
        { id: "f", title: "F" },
      ),
    /Two fields in repeating group "g" share the id "dup"/,
  );
});

test("JSX error catalog: non-field children, empty groups, and the fields prop are loud", () => {
  assert.throws(
    () =>
      schemaFromJsx(
        [el(B.RepeatingGroup, { id: "g", label: "G", maxInstances: 2 }, [el(B.Heading, { id: "h" }, "Nope")])],
        { id: "f", title: "F" },
      ),
    /children must be field elements, found Fillo\.Heading/,
  );
  assert.throws(
    () => schemaFromJsx([el(B.RepeatingGroup, { id: "g", label: "G", maxInstances: 2 })], { id: "f", title: "F" }),
    /has no fields — a repeating group needs at least one field element/,
  );
  assert.throws(
    () =>
      schemaFromJsx(
        [el(B.RepeatingGroup, { id: "g", label: "G", maxInstances: 2, fields: [] }, [el(B.Text, { id: "a", label: "A" })])],
        { id: "f", title: "F" },
      ),
    /has no prop "fields"/,
  );
});

test("JSX: a disallowed child kind builds in the walk and hard-errors in server validation (one allowlist, no drift)", () => {
  const schema = schemaFromJsx(
    [
      el(B.RepeatingGroup, { id: "g", label: "G", maxInstances: 2 }, [
        el(B.Matrix, { id: "grid", label: "Grid", rows: [{ id: "r", label: "R" }], columns: [{ id: "c", label: "C" }] }),
      ]),
    ],
    { id: "f", title: "F" },
  );
  const validated = validateFormSchema(schema);
  assert.equal(validated.ok, false);
  assert.match(validated.error, /Repeating group g has a "matrix" child \(grid\)/);
});

// ---------- Floor constant sanity ----------

test("FILLO_GROUP_MIN_SDK_VERSION is a fixed semver strictly above the base AND calc floors", () => {
  const parse = (v) => v.split(".").map((n) => parseInt(n, 10));
  const cmp = (a, b) => {
    const [aa, bb] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
      if ((aa[i] ?? 0) !== (bb[i] ?? 0)) return (aa[i] ?? 0) - (bb[i] ?? 0);
    }
    return 0;
  };
  assert.match(FILLO_GROUP_MIN_SDK_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(FILLO_GROUP_MIN_SDK_VERSION, "0.13.0");
  // An old SDK's zod enum drops the WHOLE section silently (worse than calc's
  // blank row), so the floor must actually gate: above the base floor, and
  // above calc's so the served max-of-floors composition is meaningful.
  assert.ok(cmp(FILLO_GROUP_MIN_SDK_VERSION, FILLO_MIN_SDK_VERSION) > 0);
  assert.ok(cmp(FILLO_GROUP_MIN_SDK_VERSION, FILLO_CALC_MIN_SDK_VERSION) > 0);
});

// ---------- Schema drift: group-free forms are byte-identical ----------

test("a group-free form normalizes byte-identically to the pre-groups engine", () => {
  // Expected output captured from the pre-change build (the dist compiled at
  // branch head BEFORE the repeating_group kind landed) over a fixture
  // touching every other kind — calculated included — jumps, conditions, and
  // every settings branch. If this fails, the groups change altered
  // normalization for forms that never asked for it.
  const fixture = {
    version: 1,
    title: "  Every kind, no groups  ",
    description: "Group drift fixture",
    pages: [
      {
        id: "p1",
        title: "First",
        blocks: [
          { id: "h", kind: "heading", text: "Hello" },
          { id: "para", kind: "paragraph", text: "Context" },
          { id: "div", kind: "divider" },
          { id: "st", kind: "short_text", label: "Short", maxLength: 50, placeholder: " hi " },
          { id: "lt", kind: "long_text", label: "Long", maxLength: 99999 },
          { id: "em", kind: "email", label: "Email", required: true },
          { id: "u", kind: "url", label: "Url" },
          { id: "ph", kind: "phone", label: "Phone", defaultCountry: "us" },
          { id: "n", kind: "number", label: "Num", min: 0, max: 10, decimals: 2, prefix: "$", suffix: " USD", notation: "grouped" },
        ],
        next: [{ when: [{ fieldId: "n", op: "gt", value: 5 }], to: "p3" }],
      },
      {
        id: "p2",
        blocks: [
          { id: "sel", kind: "select", label: "Sel", options: [{ id: "a", label: "A" }, { id: "b", label: "B", icon: "thumbs_up" }], allowOther: true },
          { id: "ms", kind: "multi_select", label: "MS", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], shuffleOptions: true },
          { id: "dd", kind: "dropdown", label: "DD", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          { id: "cb", kind: "checkbox", label: "CB", appearance: "toggle" },
          { id: "rt", kind: "rating", label: "Rate", max: 5, insightsMetric: "csat" },
          { id: "ls", kind: "linear_scale", label: "Scale", min: 0, max: 10, minLabel: "lo", maxLabel: "hi", insightsMetric: "nps" },
          { id: "total", kind: "calculated", label: "Total", calc: { op: "mul", args: [{ op: "value", fieldId: "n" }, { op: "const", value: 2 }] }, decimals: 2, prefix: "$" },
        ],
      },
      {
        id: "p3",
        blocks: [
          { id: "rk", kind: "ranking", label: "Rank", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          { id: "mx", kind: "matrix", label: "Grid", rows: [{ id: "r1", label: "R1" }], columns: [{ id: "c1", label: "C1" }] },
          { id: "sig", kind: "signature", label: "Sign" },
          { id: "dt", kind: "date", label: "Date", visibleIf: [{ fieldId: "cb", op: "eq", value: true }] },
          { id: "fu", kind: "file_upload", label: "Files", maxFiles: 3, maxFileSizeMb: 100, accept: ["image/*", ".pdf"] },
          { id: "hid", kind: "hidden", label: "Hid", paramName: "src", defaultValue: "x", required: true },
          { id: "cu", kind: "custom", label: "Cu", component: "color", config: { deep: { ok: 1 } } },
        ],
      },
    ],
    settings: {
      submitMode: "auto", submitLabel: "Go", successTitle: "T", successMessage: "M",
      redirectUrl: "https://example.com/done", showProgress: true,
      responseLimit: { by: "identify", onRepeat: "update", scopeField: "hid" },
      trust: { unverified: "quarantine", challenge: "turnstile" },
      notifyEmail: "a@b.co", sendReceipt: true, saveProgress: true,
      draftAnswersVisible: false, resumeEmails: true, resumeUrl: "https://example.com/resume",
      draftDigest: true,
    },
  };
  const expected =
    '{"version":1,"title":"Every kind, no groups","pages":[{"id":"p1","title":"First","blocks":[{"id":"h","kind":"heading","text":"Hello"},{"id":"para","kind":"paragraph","text":"Context"},{"id":"div","kind":"divider"},{"id":"st","kind":"short_text","label":"Short","placeholder":"hi","maxLength":50},{"id":"lt","kind":"long_text","label":"Long","maxLength":20000},{"id":"em","kind":"email","label":"Email","required":true},{"id":"u","kind":"url","label":"Url"},{"id":"ph","kind":"phone","label":"Phone","defaultCountry":"US"},{"id":"n","kind":"number","label":"Num","min":0,"max":10,"decimals":2,"prefix":"$","suffix":" USD","notation":"grouped"}],"next":[{"when":[{"fieldId":"n","op":"gt","value":5}],"to":"p3"}]},{"id":"p2","blocks":[{"id":"sel","kind":"select","label":"Sel","options":[{"id":"a","label":"A"},{"id":"b","label":"B","icon":"thumbs_up"}],"allowOther":true},{"id":"ms","kind":"multi_select","label":"MS","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"shuffleOptions":true},{"id":"dd","kind":"dropdown","label":"DD","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]},{"id":"cb","kind":"checkbox","label":"CB","appearance":"toggle"},{"id":"rt","kind":"rating","label":"Rate","max":5,"insightsMetric":"csat"},{"id":"ls","kind":"linear_scale","label":"Scale","min":0,"max":10,"minLabel":"lo","maxLabel":"hi","insightsMetric":"nps"},{"id":"total","kind":"calculated","label":"Total","required":false,"calc":{"op":"mul","args":[{"op":"value","fieldId":"n"},{"op":"const","value":2}]},"decimals":2,"prefix":"$"}]},{"id":"p3","blocks":[{"id":"rk","kind":"ranking","label":"Rank","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]},{"id":"mx","kind":"matrix","label":"Grid","rows":[{"id":"r1","label":"R1"}],"columns":[{"id":"c1","label":"C1"}]},{"id":"sig","kind":"signature","label":"Sign"},{"id":"dt","visibleIf":[{"fieldId":"cb","op":"eq","value":true}],"kind":"date","label":"Date"},{"id":"fu","kind":"file_upload","label":"Files","maxFiles":3,"maxFileSizeMb":100,"accept":["image/*",".pdf"]},{"id":"hid","kind":"hidden","label":"Hid","required":false,"paramName":"src","defaultValue":"x"},{"id":"cu","kind":"custom","label":"Cu","component":"color","config":{"deep":{"ok":1}}}]}],"settings":{"submitMode":"auto","submitLabel":"Go","successTitle":"T","successMessage":"M","redirectUrl":"https://example.com/done","showProgress":true,"responseLimit":{"by":"identify","scopeField":"hid","onRepeat":"update"},"trust":{"unverified":"quarantine","challenge":"turnstile"},"notifyEmail":"a@b.co","sendReceipt":true,"saveProgress":true,"draftAnswersVisible":false,"resumeEmails":true,"resumeUrl":"https://example.com/resume","draftDigest":true},"description":"Group drift fixture"}';
  const result = normalizeFormSchema(fixture);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.schema), expected);
});

test("same-reference no-op guarantees for the new hot paths", () => {
  // (a) A group-free form's already-canonical array/object answers are kept by
  // REFERENCE through validateResponse — the recursive branch added to the
  // shared normalize path must not introduce cloning for data that never
  // touches a group.
  const plain = normalize([
    { id: "ms", kind: "multi_select", label: "MS", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    { id: "mx", kind: "matrix", label: "Grid", rows: [{ id: "r", label: "R" }], columns: [{ id: "c", label: "C" }] },
  ]);
  const ms = ["a", "b"];
  const mx = { r: "c" };
  const kept = validateResponse(plain, { ms, mx });
  assert.equal(kept.ok, true);
  assert.equal(kept.data.ms, ms, "multi_select array kept by reference");
  assert.equal(kept.data.mx, mx, "matrix object kept by reference");

  // (b) computeCalculated still returns data UNCHANGED (same reference) for a
  // calc-free form even when that form CONTAINS a repeating group — the group
  // kind must not disturb the calc-free early return.
  const withGroup = normalize([guests({ minInstances: 0 })]);
  const data = { guests: [{ name: "Ada" }] };
  assert.equal(computeCalculated(withGroup, data), data);
});
