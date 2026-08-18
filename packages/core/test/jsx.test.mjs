import test from "node:test";
import assert from "node:assert/strict";
import {
  codeFormFromJsx,
  contentHash,
  defineForm,
  JSX_BLOCK_COMPONENTS as B,
  schemaFromJsx,
  validateFormSchema,
  when,
} from "../dist/index.js";

// Elements are plain {type, props} — exactly what JSX produces; no react needed.
const el = (type, props = {}, children) => ({
  type,
  props: children === undefined ? props : { ...props, children },
});
const FRAGMENT = Symbol.for("react.fragment");

const kitchenSink = () => [
  el(B.Heading, { id: "h1" }, "Tell us everything"),
  el(B.Text, { id: "name", label: "Name", required: true, maxLength: 80 }),
  el(B.Email, { id: "email", label: "Email", placeholder: "you@work.com" }),
  el(B.Select, { id: "topic", label: "Topic", required: true }, [
    el(B.Option, { id: "sales", label: "Sales" }),
    el(B.Option, { id: "support", label: "Support", icon: "thumbs_up" }),
  ]),
  el(B.MultiSelect, {
    id: "channels",
    label: "Channels",
    options: [
      { id: "em", label: "Email" },
      { id: "ph", label: "Phone" },
    ],
    allowOther: true,
  }),
  el(B.Scale, { id: "nps", label: "Recommend us?", min: 0, max: 10, minLabel: "No", maxLabel: "Yes" }),
  el(B.Checkbox, { id: "tos", label: "I agree", required: true, appearance: "toggle" }),
  el(B.Paragraph, { id: "p1" }, "Thanks {{name}}!"),
  el(B.LongText, {
    id: "detail",
    label: "Details",
    visibleIf: when("topic").eq("support"),
  }),
  el(B.Hidden, { id: "utm", label: "UTM", paramName: "utm_source" }),
];

/**
 * WIRE-FORMAT CONTRACT: this exact JSON feeds the pre-normalization content
 * hash. Changing emission (key order, defaults, the implicit page id "main")
 * re-hashes and re-syncs EVERY deployed JSX form — do that deliberately, with
 * a changeset, never as a refactor side effect.
 */
test("canonical emission snapshot", () => {
  const schema = schemaFromJsx(kitchenSink(), { id: "sink", title: "Sink" });
  const expectedFirstBlocks = JSON.stringify([
    { id: "h1", kind: "heading", text: "Tell us everything" },
    { id: "name", kind: "short_text", label: "Name", required: true, maxLength: 80 },
    { id: "email", kind: "email", label: "Email", placeholder: "you@work.com" },
  ]);
  assert.equal(JSON.stringify(schema.pages[0].blocks.slice(0, 3)), expectedFirstBlocks);
  assert.equal(schema.pages[0].id, "main", "implicit page id is a permanent constant");
  assert.equal(schema.version, 1);
  const validated = validateFormSchema(schema);
  assert.ok(validated.ok, `walk output must pass server validation: ${validated.error}`);
});

test("Fillo.Number builds with decimals/prefix/suffix/notation, and rejects an unknown prop", () => {
  const schema = schemaFromJsx(
    [
      el(B.Number, {
        id: "price",
        label: "Price",
        min: 0,
        max: 10,
        decimals: 2,
        prefix: "$",
        suffix: " kg",
        notation: "grouped",
      }),
    ],
    { id: "f" },
  );
  assert.deepEqual(schema.pages[0].blocks[0], {
    id: "price",
    kind: "number",
    label: "Price",
    min: 0,
    max: 10,
    decimals: 2,
    prefix: "$",
    suffix: " kg",
    notation: "grouped",
  });
  const validated = validateFormSchema(schema);
  assert.ok(validated.ok, `must pass server validation: ${validated.error}`);

  throwsCode("UNKNOWN_PROP", () =>
    schemaFromJsx([el(B.Number, { id: "n", label: "N", groupThousands: true })], { id: "f" }),
  );
});

test("Fillo.Number carries a fixed notation style through walk AND normalization", () => {
  const schema = schemaFromJsx(
    [el(B.Number, { id: "price", label: "Price", notation: "grouped-dot" })],
    { id: "f" },
  );
  assert.equal(schema.pages[0].blocks[0].notation, "grouped-dot", "walk passes the value through");
  const validated = validateFormSchema(schema);
  assert.ok(validated.ok, `must pass server validation: ${validated.error}`);
  assert.equal(
    validated.schema.pages[0].blocks[0].notation,
    "grouped-dot",
    "normalization keeps the fixed style, round-tripping it intact",
  );
});

test("JSX and defineForm twins emit identical JSON and identical content hash", () => {
  const viaJsx = codeFormFromJsx({ id: "contact", title: "Talk to us" }, [
    el(B.Text, { id: "name", label: "Your name", required: true }),
    el(B.Select, { id: "topic", label: "Topic" }, [
      el(B.Option, { id: "a", label: "A" }),
      el(B.Option, { id: "b", label: "B" }),
    ]),
    el(B.LongText, { id: "msg", label: "Message", visibleIf: when("topic").answered() }),
  ]);
  const viaDefine = defineForm({
    id: "contact",
    title: "Talk to us",
    pages: [
      {
        id: "main",
        blocks: [
          { id: "name", kind: "short_text", label: "Your name", required: true },
          {
            id: "topic",
            kind: "select",
            label: "Topic",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
          {
            id: "msg",
            kind: "long_text",
            label: "Message",
            visibleIf: [{ fieldId: "topic", op: "answered" }],
          },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(viaJsx.schema), JSON.stringify(viaDefine.schema));
  assert.equal(
    contentHash(JSON.stringify(viaJsx.schema)),
    contentHash(JSON.stringify(viaDefine.schema)),
    "switching authoring styles must not stage a new draft",
  );
});

test("options via children and via prop are identical", () => {
  const opts = [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
  ];
  const viaChildren = schemaFromJsx(
    [el(B.Select, { id: "s", label: "S" }, opts.map((o) => el(B.Option, o)))],
    { id: "f" },
  );
  const viaProp = schemaFromJsx([el(B.Select, { id: "s", label: "S", options: opts })], { id: "f" });
  assert.equal(JSON.stringify(viaChildren), JSON.stringify(viaProp));
});

test("explicit pages group blocks; fragments and arrays flatten", () => {
  const schema = schemaFromJsx(
    [
      el(B.Page, { id: "p1", title: "About you" }, [
        el(FRAGMENT, {}, [el(B.Text, { id: "a", label: "A" })]),
      ]),
      el(B.Page, { id: "p2" }, el(B.Text, { id: "b", label: "B" })),
    ],
    { id: "f" },
  );
  assert.deepEqual(
    schema.pages.map((p) => ({ id: p.id, n: p.blocks.length })),
    [
      { id: "p1", n: 1 },
      { id: "p2", n: 1 },
    ],
  );
  assert.equal(schema.pages[0].title, "About you");
});

test("when() emits canonical frozen conditions", () => {
  assert.equal(JSON.stringify(when("t").eq("x")), '{"fieldId":"t","op":"eq","value":"x"}');
  assert.equal(JSON.stringify(when("t").notAnswered()), '{"fieldId":"t","op":"not_answered"}');
  assert.ok(Object.isFrozen(when("t").gt(3)));
});

const throwsCode = (code, fn) => {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal(err.code, code, err.message);
  }
};

test("error catalog: every forbidden pattern fails loudly with a fix-it", () => {
  throwsCode("MISSING_ID", () => schemaFromJsx([el(B.Text, { label: "No id" })], { id: "f" }));
  throwsCode("DUPLICATE_ID", () =>
    schemaFromJsx(
      [el(B.Text, { id: "a", label: "1" }), el(B.Email, { id: "a", label: "2" })],
      { id: "f" },
    ),
  );
  throwsCode("DUPLICATE_ID", () =>
    schemaFromJsx(
      [
        el(B.Page, { id: "p" }, el(B.Text, { id: "a", label: "A" })),
        el(B.Page, { id: "p" }, el(B.Text, { id: "b", label: "B" })),
      ],
      { id: "f" },
    ),
  );
  throwsCode("DUPLICATE_ID", () =>
    schemaFromJsx(
      [el(B.Select, { id: "s", label: "S" }, [
        el(B.Option, { id: "x", label: "X" }),
        el(B.Option, { id: "x", label: "Again" }),
      ])],
      { id: "f" },
    ),
  );
  throwsCode("NON_FILLO_CHILD", () => schemaFromJsx([el("div", {})], { id: "f" }));
  throwsCode("WRAPPER_COMPONENT", () => schemaFromJsx([el(function MyBlock() {}, {})], { id: "f" }));
  throwsCode("OPAQUE_TYPE", () =>
    schemaFromJsx([el({ $$typeof: Symbol.for("react.lazy") }, {})], { id: "f" }),
  );
  throwsCode("UNKNOWN_PROP", () =>
    schemaFromJsx([el(B.Text, { id: "a", label: "A", className: "x" })], { id: "f" }),
  );
  throwsCode("UNKNOWN_PROP", () =>
    schemaFromJsx([el(B.Text, { id: "a", label: "A", maxLenght: 5 })], { id: "f" }),
  );
  throwsCode("OPTION_PROP_CONFLICT", () =>
    schemaFromJsx(
      [el(B.Select, { id: "s", label: "S", options: [{ id: "x", label: "X" }] }, [el(B.Option, { id: "y", label: "Y" })])],
      { id: "f" },
    ),
  );
  throwsCode("PAGE_MIX", () =>
    schemaFromJsx([el(B.Page, { id: "p" }), el(B.Text, { id: "a", label: "A" })], { id: "f" }),
  );
  throwsCode("TEXT_CHILD_REQUIRED", () => schemaFromJsx([el(B.Paragraph, { id: "p" })], { id: "f" }));
  throwsCode("RENDERED_INERT", () => B.Email({}));
  // Production too — data-integrity errors are never dev-only.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    throwsCode("DUPLICATE_ID", () =>
      schemaFromJsx(
        [el(B.Text, { id: "a", label: "1" }), el(B.Text, { id: "a", label: "2" })],
        { id: "f" },
      ),
    );
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("property: 100 random forms — JSX equals defineForm, and both validate", () => {
  // Deterministic PRNG (no Math.random in tests that must reproduce).
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const makers = [
    (id) => [el(B.Text, { id, label: `L${id}`, required: rnd() > 0.5 }), { id, kind: "short_text", label: `L${id}`, required: undefined }],
    (id) => [el(B.Number, { id, label: `N${id}`, min: 1, max: 9 }), { id, kind: "number", label: `N${id}`, min: 1, max: 9 }],
    (id) => {
      const options = [
        { id: `${id}o1`, label: "One" },
        { id: `${id}o2`, label: "Two" },
      ];
      return [el(B.Dropdown, { id, label: `D${id}`, options }), { id, kind: "dropdown", label: `D${id}`, options }];
    },
    (id) => [el(B.Rating, { id, label: `R${id}`, max: 5, insightsMetric: "csat" }), { id, kind: "rating", label: `R${id}`, max: 5, insightsMetric: "csat" }],
    (id) => [el(B.Divider, { id }), { id, kind: "divider" }],
  ];

  for (let run = 0; run < 100; run++) {
    const count = 1 + Math.floor(rnd() * 6);
    const elements = [];
    const literals = [];
    for (let i = 0; i < count; i++) {
      const maker = pick(makers);
      const [element, literalTemplate] = maker(`f${run}_${i}`);
      // The walk emits sparse — mirror that in the literal.
      const required = element.props.required;
      const literal = { ...literalTemplate };
      if ("required" in literal) {
        if (required === true) literal.required = true;
        else delete literal.required;
        if (required !== true) delete element.props.required;
        else element.props.required = true;
      }
      elements.push(element);
      literals.push(literal);
    }
    const viaJsx = codeFormFromJsx({ id: `form${run}`, title: "T" }, elements);
    const viaDefine = defineForm({
      id: `form${run}`,
      title: "T",
      pages: [{ id: "main", blocks: literals }],
    });
    assert.equal(JSON.stringify(viaJsx.schema), JSON.stringify(viaDefine.schema), `run ${run}`);
    assert.ok(validateFormSchema(viaJsx.schema).ok, `run ${run} validates`);
  }
});
