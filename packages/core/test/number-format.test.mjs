import test from "node:test";
import assert from "node:assert/strict";
import {
  formatGroupedNumber,
  parseGroupedNumber,
  isValidPartialNumberText,
  localeForNotation,
} from "../dist/index.js";

// ---------- localeForNotation ----------

test("localeForNotation: the single notation→locale map both renderers share", () => {
  assert.equal(localeForNotation(undefined), undefined, "unset → browser detect");
  assert.equal(localeForNotation("grouped"), undefined, "grouped → browser detect");
  assert.equal(localeForNotation("grouped-comma"), "en-US", "comma groups, dot decimal — 1,234.56");
  assert.equal(localeForNotation("grouped-dot"), "de-DE", "dot groups, comma decimal — 1.234,56");
  assert.equal(localeForNotation(), undefined, "callable with no argument at all");
});

// ---------- formatGroupedNumber ----------

test("formatGroupedNumber: grouping, decimals padding/rounding, locale separators, non-finite fallback", () => {
  const cases = [
    // [value, opts, expected]
    [1234567, { locale: "en-US" }, "1,234,567", "plain grouping"],
    [6, { locale: "en-US", decimals: 2 }, "6.00", "decimals pads a whole number"],
    [1234.567, { locale: "en-US", decimals: 2 }, "1,234.57", "decimals rounds"],
    [1234567.891, { locale: "de-DE" }, "1.234.567,891", "de-DE: \".\" groups, \",\" decimal"],
    [1234, { locale: "de-DE", decimals: 2 }, "1.234,00", "de-DE decimals padding"],
    [-1234.5, { locale: "de-DE", decimals: 2 }, "-1.234,50", "de-DE negative"],
    [0, { locale: "en-US" }, "0", "zero"],
    [1.23456, { locale: "en-US" }, "1.23456", "5 fraction digits NOT truncated to Intl's default 3"],
    [NaN, {}, "NaN", "non-finite fails soft to String(value)"],
    [Infinity, {}, "Infinity", "non-finite fails soft to String(value)"],
    [-Infinity, {}, "-Infinity", "non-finite fails soft to String(value)"],
  ];
  for (const [value, opts, expected, why] of cases) {
    assert.equal(formatGroupedNumber(value, opts), expected, why);
  }
});

test("formatGroupedNumber: fixed notation styles render their literal example strings", () => {
  // Node's own default locale is en-US — the whole point of the fixed styles
  // is that the mapped locale wins over whatever the runtime would detect.
  const cases = [
    [1234.56, "grouped-comma", 2, "1,234.56"],
    [1234.56, "grouped-dot", 2, "1.234,56"],
    [1234567, "grouped-dot", undefined, "1.234.567"],
    [1234567.891, "grouped-dot", undefined, "1.234.567,891"],
    [-1234.5, "grouped-dot", 2, "-1.234,50"],
    [1234567, "grouped-comma", undefined, "1,234,567"],
  ];
  for (const [value, notation, decimals, expected] of cases) {
    assert.equal(
      formatGroupedNumber(value, { locale: localeForNotation(notation), decimals }),
      expected,
      `${notation} value=${value} decimals=${decimals}`,
    );
  }
});

test("formatGroupedNumber: opts is fully optional", () => {
  // No locale/decimals at all — must not throw, and must not drop/reorder
  // digits (whatever the runtime's default locale groups with).
  const result = formatGroupedNumber(1234567);
  assert.equal(typeof result, "string");
  assert.equal(result.replace(/\D/g, ""), "1234567");
});

// ---------- parseGroupedNumber ----------

test("parseGroupedNumber: locale-driven separators map to canonical text", () => {
  const cases = [
    ["1,234.5", "en-US", "1234.5", "en: strip \",\" group, keep \".\" decimal"],
    ["1.234,5", "de-DE", "1234.5", "de-DE: strip \".\" group, map \",\" decimal"],
    ["1234.5", "de-DE", "1234.5", "\".\" always accepted as decimal, even under de-DE"],
    ["1.234", "de-DE", "1234", "a bare grouped integer (no decimal) still resolves under de-DE"],
    // Refinement 2026-07-20: a zero-led head is never grouping (grouped
    // output can't emit one) — this used to silently read as 123 (1000×).
    ["0.123", "de-DE", "0.123", "zero-led head reads as a decimal, not grouping"],
    ["10.123", "de-DE", "10123", "non-zero 2-digit head still groups"],
    ["-1.234,50", "de-DE", "-1234.50", "minus preserved through de-DE grouping"],
    ["-1,234.5", "en-US", "-1234.5", "minus preserved through en grouping"],
    [`1 234,5`, "fr-FR", "1234.5", "NBSP (U+00A0) group separator"],
    [`1 234,5`, "fr-FR", "1234.5", "narrow NBSP (U+202F) group separator"],
    ["abc", "en-US", "abc", "garbage returned unchanged"],
    ["12-34", "en-US", "12-34", "misplaced sign returned unchanged"],
    ["1234.", "en-US", "1234.", "partial typing state preserved (Number-parseable)"],
    ["1234,", "de-DE", "1234.", "partial typing state normalizes the locale decimal mark too"],
    ["   ", "en-US", "   ", "whitespace-only input returned as-is"],
    ["", "en-US", "", "empty input returned as-is"],
    ["-", "en-US", "-", "a lone sign is not parseable, returned unchanged"],
  ];
  for (const [text, locale, expected, why] of cases) {
    assert.equal(parseGroupedNumber(text, locale), expected, why);
  }
});

test("parseGroupedNumber: default locale (no argument) does not throw", () => {
  assert.equal(typeof parseGroupedNumber("1234"), "string");
});

// Comma-as-group locales get the SAME structural disambiguation dot-as-group
// locales (de-DE) shipped with: exact 3-digit chunking after a 1–3 digit,
// non-zero-led head is grouping; anything else reads the separator as a
// decimal point. This is what makes the author-fixed styles safe for
// opposite-convention respondents — and it upgrades DETECT mode too: "12,5"
// under en-US used to silently strip to "125" (10× corruption); now it reads
// as the 12.5 the respondent meant.
test("parseGroupedNumber: comma-group locales disambiguate structurally, mirroring de-DE", () => {
  const cases = [
    ["12,5", "12.5", "not 3-digit chunking — the comma is a decimal, never stripped to 125"],
    ["1,23", "1.23", "2-digit tail can't be a group"],
    ["3,14159", "3.14159", "long fraction after a comma decimal"],
    ["0,5", "0.5", "comma-decimal half"],
    ["0,123", "0.123", "zero-led head is never grouping — reads as a decimal, not a 1000× 123"],
    [",5", ".5", "bare leading decimal comma"],
    ["-12,5", "-12.5", "minus preserved through the decimal reading"],
    ["1,234", "1234", "exact chunking stays grouping"],
    ["10,123", "10123", "non-zero 2-digit head still groups"],
    ["100,123", "100123", "non-zero 3-digit head still groups"],
    ["1,234,567", "1234567", "multi-group exact chunking stays grouping"],
    ["1,234.5", "1234.5", "the locale's real decimal mark wins outright when present"],
    ["1234,567", "1234.567", "a 4-digit head can't be standard grouping — decimal reading"],
    // The exact mirror of de-DE's shipped rule, either direction: a FULL
    // opposite-convention string is returned unchanged (the locale's real
    // decimal wins first, leaving a group mark in the fraction), and
    // validation flags it — same as "1,234.56" under de-DE today.
    ["1.234,56", "1.234,56", "opposite-convention string returns unchanged, validation flags it"],
    // Partial-typing tolerance, mirrored from de-DE's "1.234." handling: a
    // trailing comma reads as a decimal point being typed — Number() can
    // still parse the result, so the keystroke flow never breaks.
    ["1234,", "1234.", "trailing comma is a decimal-in-progress"],
    ["1,234,", "1234.", "trailing comma after exact groups — decimal-in-progress"],
  ];
  for (const [text, expected, why] of cases) {
    assert.equal(parseGroupedNumber(text, "en-US"), expected, `en-US ${JSON.stringify(text)}: ${why}`);
  }
  // Round trips: the decimal readings survive Number() and reformat cleanly.
  assert.equal(Number(parseGroupedNumber("12,5", "en-US")), 12.5);
  assert.equal(Number(parseGroupedNumber("1,234,567", "en-US")), 1234567);
  assert.equal(
    formatGroupedNumber(Number(parseGroupedNumber("12,5", "en-US")), { locale: "en-US", decimals: 1 }),
    "12.5",
  );
});

test("parseGroupedNumber: the de-DE and en-US structural rules are exact mirrors", () => {
  // Swap every "." for "," (and vice versa) and the two locales must agree —
  // the shipped de-DE rule is the spec for the comma-group side.
  const mirrored = [
    ["12.5", "12,5"],
    ["1.234", "1,234"],
    ["1.234.567", "1,234,567"],
    ["1.234.", "1,234,"],
    ["3.14159", "3,14159"],
    [".5", ",5"],
    ["0.123", "0,123"], // zero-led head: decimal reading on BOTH sides
    ["10.123", "10,123"], // non-zero head: grouping on BOTH sides
    ["1,234.56", "1.234,56"], // full opposite-convention strings, both unchanged
  ];
  for (const [deText, enText] of mirrored) {
    const de = parseGroupedNumber(deText, "de-DE");
    const en = parseGroupedNumber(enText, "en-US");
    // A Number-parseable de-DE result mirrors to the SAME canonical result;
    // an unparseable (returned-unchanged) one mirrors to en-US's own input
    // returned unchanged.
    const expected = Number.isNaN(Number(de)) ? enText : de;
    assert.equal(en, expected, `de-DE ${JSON.stringify(deText)} ↔ en-US ${JSON.stringify(enText)}`);
  }
});

// ---------- isValidPartialNumberText ----------

test("isValidPartialNumberText: locale-driven keystroke filter blocks impossible characters/structures", () => {
  const cases = [
    // [text, locale, expected, why]
    ["", "en-US", true, "empty string is always valid"],
    ["-", "en-US", true, "a lone minus is valid — typing continues"],
    ["1,234.5", "en-US", true, "digits + group + one decimal"],
    ["1.2.3", "en-US", false, "a second \".\" — en's decimal mark — is rejected"],
    ["abc", "en-US", false, "letters are never valid"],
    ["1a", "en-US", false, "a single stray letter rejects the whole string"],
    ["--", "en-US", false, "minus only as the leading character"],
    ["1-", "en-US", false, "minus only as the leading character"],
    ["1.234,5", "de-DE", true, "\".\" groups, \",\" decimal — de-DE"],
    ["1.2.3", "de-DE", true, "\".\" is de-DE's group separator here, not a decimal mark"],
    ["1,2,3", "de-DE", false, "a second \",\" — de-DE's real decimal mark — is rejected"],
    [`1 234,5`, "fr-FR", true, "NBSP (U+00A0) group separator"],
  ];
  for (const [text, locale, expected, why] of cases) {
    assert.equal(isValidPartialNumberText(text, locale), expected, why);
  }
});

test("isValidPartialNumberText: default locale (no argument) does not throw", () => {
  assert.equal(typeof isValidPartialNumberText("123"), "boolean");
});

// ---------- Round trip: parse(format(x)) === canonical, for a value table ----------
// Each [value, decimals] pair is chosen so no actual rounding decision is
// needed (fraction length <= decimals, or decimals unset) — this table
// checks grouping/parsing fidelity, not toFixed-vs-Intl rounding-mode
// agreement, which is a separate concern already covered by formatAnswer.
const ROUND_TRIP_TABLE = [
  [0, undefined],
  [42, undefined],
  [-42, undefined],
  [1234567, undefined],
  [1234567.891, undefined],
  [-0.25, undefined],
  [1000000, undefined],
  [0, 0],
  [42, 0],
  [-42, 0],
  [1234567, 0],
  [-1000000, 0],
  [1234.5, 2],
  [42, 2],
  [-1234.56, 2],
  [0.1, 2],
  [1234567.891, 6],
  [0.123456, 6],
  [-1000.2, 6],
];

test("round trip: parseGroupedNumber(formatGroupedNumber(x)) === canonical text", () => {
  for (const locale of ["en-US", "de-DE", "fr-FR"]) {
    for (const [value, decimals] of ROUND_TRIP_TABLE) {
      const canonical = decimals === undefined ? String(value) : value.toFixed(decimals);
      const formatted = formatGroupedNumber(value, { locale, decimals });
      const parsed = parseGroupedNumber(formatted, locale);
      assert.equal(parsed, canonical, `${locale} value=${value} decimals=${decimals} formatted=${JSON.stringify(formatted)}`);
    }
  }
});
