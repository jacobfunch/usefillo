import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFormSchema, normalizeFormTheme, validateFormSchema } from "../dist/index.js";

test("normalizes renderer-sensitive field data", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "T",
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "h", kind: "heading" },
          { id: "rating", kind: "rating", label: "Score", max: 100 },
          { id: "scale", kind: "linear_scale", label: "Scale", min: -10, max: 99 },
          { id: "files", kind: "file_upload", label: "Files", maxFiles: 99, maxFileSizeMb: 9999 },
        ],
      },
    ],
    settings: {
      redirectUrl: "javascript:alert(1)",
      submitLabel: "Send",
      submitMode: "auto",
      responseLimit: { by: "browser", onRepeat: "keep" },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.schema.pages[0].blocks[0].text, "Section");
  assert.equal(result.schema.pages[0].blocks[1].max, 10);
  assert.deepEqual(
    {
      min: result.schema.pages[0].blocks[2].min,
      max: result.schema.pages[0].blocks[2].max,
    },
    { min: 0, max: 10 },
  );
  assert.equal(result.schema.pages[0].blocks[3].maxFiles, 20);
  assert.equal(result.schema.pages[0].blocks[3].maxFileSizeMb, 5000);
  assert.equal(result.schema.settings.redirectUrl, undefined);
  assert.equal(result.schema.settings.submitLabel, "Send");
  assert.equal(result.schema.settings.submitMode, "auto");
  assert.deepEqual(result.schema.settings.responseLimit, { by: "browser", onRepeat: "keep" });
});

test("keeps only score metrics with their required ranges", () => {
  const result = normalizeFormSchema({
    version: 1,
    title: "Metrics",
    pages: [{
      id: "p1",
      blocks: [
        { id: "csat-rating", kind: "rating", label: "CSAT", max: 5, insightsMetric: "csat" },
        { id: "bad-csat-rating", kind: "rating", label: "Bad CSAT", max: 7, insightsMetric: "csat" },
        { id: "nps", kind: "linear_scale", label: "NPS", min: 0, max: 10, insightsMetric: "nps" },
        { id: "csat-scale", kind: "linear_scale", label: "CSAT scale", min: 1, max: 5, insightsMetric: "csat" },
        { id: "bad-nps", kind: "linear_scale", label: "Bad NPS", min: 1, max: 5, insightsMetric: "nps" },
      ],
    }],
    settings: {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.schema.pages[0].blocks.map((block) => block.insightsMetric),
    ["csat", undefined, "nps", "csat", undefined],
  );
});

test("rejects duplicate page, block, and per-field option ids", () => {
  const base = (pages) => ({ version: 1, title: "T", settings: {}, pages });
  const text = (id) => ({ id, kind: "short_text", label: id });
  const choice = (id, options) => ({ id, kind: "select", label: id, options });

  const duplicatePage = validateFormSchema(base([
    { id: "same", blocks: [text("a")] },
    { id: " same ", blocks: [text("b")] },
  ]));
  assert.equal(duplicatePage.ok, false);
  assert.match(duplicatePage.error, /Duplicate page id/);

  assert.equal(
    validateFormSchema(base([
        { id: "p1", blocks: [{ id: "same", kind: "short_text", label: "One" }] },
        { id: "p2", blocks: [{ id: "same", kind: "email", label: "Two" }] },
      ])).ok,
    false,
  );

  const duplicateOption = validateFormSchema(base([
    { id: "p1", blocks: [choice("pick", [{ id: "x", label: "X" }, { id: " x ", label: "Again" }])] },
  ]));
  assert.equal(duplicateOption.ok, false);
  assert.match(duplicateOption.error, /Duplicate option id/);

  const duplicateRow = validateFormSchema(base([
    { id: "p1", blocks: [{
      id: "grid", kind: "matrix", label: "Grid",
      rows: [{ id: "r", label: "R" }, { id: " r ", label: "Again" }],
      columns: [{ id: "c", label: "C" }],
    }] },
  ]));
  assert.equal(duplicateRow.ok, false);
  assert.match(duplicateRow.error, /Duplicate matrix row id/);
});

test("rejects impossible number ranges or no valid blocks", () => {
  const badRange = validateFormSchema({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "n", kind: "number", label: "N", min: 10, max: 2 }] }],
  });
  assert.equal(badRange.ok, false);
  assert.match(badRange.error, /min greater than max/);

  const empty = validateFormSchema({
    version: 1,
    pages: [{ id: "p1", blocks: [{ id: "bad", kind: "select", label: "No options" }] }],
  });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /at least one valid block/);
});

test("filters active CSS values from themes", () => {
  assert.deepEqual(
    normalizeFormTheme({
      primary: "#5240ff",
      colorScheme: "dark",
      background: "url(https://example.com/pixel)",
      text: "red; color: blue",
      radius: "10px",
    }),
    { colorScheme: "dark", primary: "#5240ff", radius: "10px" },
  );
});

// ---------- number field: decimals/prefix/suffix/notation normalization ----------

const numberForm = (block) => ({
  version: 1,
  title: "N",
  settings: {},
  pages: [{ id: "p1", blocks: [{ id: "n", kind: "number", label: "N", ...block }] }],
});

test("number normalization preserves valid decimals/prefix/suffix/notation", () => {
  const result = normalizeFormSchema(
    numberForm({ min: 0, max: 100, decimals: 2, prefix: "$", suffix: " USD", notation: "grouped" }),
  );
  assert.equal(result.ok, true, result.error);
  const block = result.schema.pages[0].blocks[0];
  assert.equal(block.decimals, 2);
  assert.equal(block.prefix, "$");
  // Affixes keep their edge spacing (` USD` renders as "3 USD", not "3USD");
  // whitespace-only still means unset. Applies to calculated fields too.
  assert.equal(block.suffix, " USD");
  assert.equal(block.notation, "grouped");
});

test("affix normalization drops whitespace-only prefix/suffix", () => {
  const result = normalizeFormSchema(numberForm({ prefix: "   ", suffix: "\t" }));
  assert.equal(result.ok, true, result.error);
  const block = result.schema.pages[0].blocks[0];
  assert.equal("prefix" in block, false);
  assert.equal("suffix" in block, false);
});

test("number normalization clamps decimals into 0–6", () => {
  const over = normalizeFormSchema(numberForm({ decimals: 9 }));
  assert.equal(over.ok, true, over.error);
  assert.equal(over.schema.pages[0].blocks[0].decimals, 6);

  const under = normalizeFormSchema(numberForm({ decimals: -1 }));
  assert.equal(under.ok, true, under.error);
  assert.equal(under.schema.pages[0].blocks[0].decimals, 0);
});

test("number normalization truncates prefix/suffix past 100 chars", () => {
  const result = normalizeFormSchema(numberForm({ prefix: "$".repeat(500), suffix: "kg".repeat(500) }));
  assert.equal(result.ok, true, result.error);
  const block = result.schema.pages[0].blocks[0];
  assert.equal(block.prefix.length, 100);
  assert.equal(block.suffix.length, 100);
});

test("number normalization preserves every supported notation value", () => {
  for (const notation of ["grouped", "grouped-comma", "grouped-dot"]) {
    const result = normalizeFormSchema(numberForm({ notation }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.schema.pages[0].blocks[0].notation, notation);
  }
});

test("number normalization drops an invalid notation value, never errors", () => {
  for (const notation of ["weird", "grouped-space", 1, true, {}]) {
    const result = normalizeFormSchema(numberForm({ notation }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.schema.pages[0].blocks[0].notation, undefined);
  }
});

test("number normalization drops nothing else new: an unset prop stays absent", () => {
  const result = normalizeFormSchema(numberForm({ min: 0, max: 10 }));
  assert.equal(result.ok, true, result.error);
  const block = result.schema.pages[0].blocks[0];
  assert.equal("decimals" in block, false);
  assert.equal("prefix" in block, false);
  assert.equal("suffix" in block, false);
  assert.equal("notation" in block, false);
});

test("regression: a props-free number field normalizes byte-identically to before", () => {
  // Captured from the pre-formatting build: a number field with only
  // min/max must produce the exact same JSON — the new props must never
  // appear (even as explicit `undefined`-valued keys) when unset.
  const result = normalizeFormSchema(numberForm({ min: 0, max: 10 }));
  assert.equal(result.ok, true, result.error);
  assert.equal(
    JSON.stringify(result.schema.pages[0].blocks[0]),
    '{"id":"n","kind":"number","label":"N","min":0,"max":10}',
  );
});

test("normalizeTrust validates challenge + quarantine independently", () => {
  const trust = (value) =>
    normalizeFormSchema({
      version: 1,
      title: "T",
      pages: [{ id: "p1", blocks: [{ id: "a", kind: "short_text", label: "A" }] }],
      settings: { trust: value },
    }).schema.settings.trust;

  // Challenge alone is kept even with no quarantine policy.
  assert.deepEqual(trust({ challenge: "turnstile" }), { challenge: "turnstile" });
  // Both flags ride together in one object.
  assert.deepEqual(trust({ unverified: "quarantine", challenge: "turnstile" }), {
    unverified: "quarantine",
    challenge: "turnstile",
  });
  // "off" and unknown providers normalize to absent (backward-compatible = off).
  assert.equal(trust({ challenge: "off" }), undefined);
  assert.equal(trust({ challenge: "recaptcha" }), undefined);
  // An invalid quarantine value drops but a valid challenge still survives.
  assert.deepEqual(trust({ unverified: "nope", challenge: "turnstile" }), {
    challenge: "turnstile",
  });
  // A fully empty/garbage policy drops entirely.
  assert.equal(trust({}), undefined);
  assert.equal(trust({ unverified: "maybe" }), undefined);
});
