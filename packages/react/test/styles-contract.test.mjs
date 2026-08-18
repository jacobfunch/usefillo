import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Gate: packages/react/src/styles.css and packages/dom/src/styles.css must
 * stay byte-identical, full stop — dom's Turnstile port (docs/decisions/
 * input-quality.md's 2026-07-19 amendment scoping it to its own PR) landed,
 * so the former react-only-block exception is gone. Both files' header
 * comments have claimed "byte-for-byte identical" for a while — the audit's
 * P2.13 finding ("header's 'byte-for-byte' claim stale") is exactly what
 * drifted silently with nothing to catch it. This is that gate (docs/
 * decisions/input-quality.md "Verification gates").
 */

const REACT_CSS_URL = new URL("../src/styles.css", import.meta.url);
const DOM_CSS_URL = new URL("../../dom/src/styles.css", import.meta.url);

/** 1-indexed line + content of the first line where two texts differ (a
 * length mismatch counts as a divergence at the first index past the
 * shorter text, so this always finds something when the texts aren't ===). */
function firstDivergence(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) return { line: i + 1, react: aLines[i], dom: bLines[i] };
  }
  return null;
}

test("react and dom src/styles.css are byte-identical", () => {
  const reactCss = readFileSync(REACT_CSS_URL, "utf8");
  const domCss = readFileSync(DOM_CSS_URL, "utf8");
  if (reactCss === domCss) return;
  const div = firstDivergence(reactCss, domCss);
  assert.fail(
    `react's src/styles.css and dom's src/styles.css diverge at line ${div.line}:\n` +
      `  react: ${JSON.stringify(div.react)}\n` +
      `  dom:   ${JSON.stringify(div.dom)}\n` +
      "Edit both stylesheets together (see either file's header comment) unless this divergence is a deliberate, documented exception.",
  );
});

test("unthemed forms inherit the host scheme while auto remains system-driven", () => {
  const css = readFileSync(REACT_CSS_URL, "utf8");
  assert.match(css, /\.fillo-form\s*\{[\s\S]*?color-scheme: inherit;/u);
  assert.match(css, /--fillo-text: light-dark\(#18181b, #f4f4f5\);/u);
  assert.match(
    css,
    /\.fillo-form\[data-fillo-color-scheme="auto"\]\s*\{\s*color-scheme: light dark;/u,
  );
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\)\s*\{\s*\.fillo-form\[data-fillo-color-scheme="auto"\]\s*\{/u,
  );
});

/**
 * Gate: static pointer-target-size floors (WCAG 2.2 AA, 24×24 CSS px = 1.5rem
 * @16px root; contract's styling floor + audit P1.3). A regex/structural
 * parse, not a full CSS parser — good enough that removing a floor fails a
 * test, which is the point (docs/decisions/input-quality.md "Verification
 * gates" / the audit's "Gates to build").
 */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Concatenated declaration bodies of every rule whose selector list contains
 * `selector` as a whole token (a `(?![-\w])` lookahead keeps ".fillo-star"
 * from matching ".fillo-star--active"). The block regex below only matches
 * "<selector>{<declarations-with-no-nested-braces>}" — it silently skips the
 * file's @layer/@media wrappers (their bodies contain further "{" before the
 * next "}", so they never satisfy `[^{}]*`) and lands on each flat rule
 * inside them instead, top-level or nested one deep.
 */
function declarationsFor(css, selector) {
  const noComments = stripComments(css);
  const tokenRe = new RegExp(`(?:^|[\\s,{])${escapeRegExp(selector)}(?![-\\w])`);
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  const bodies = [];
  let m = blockRe.exec(noComments);
  while (m) {
    if (tokenRe.test(m[1])) bodies.push(m[2]);
    m = blockRe.exec(noComments);
  }
  return bodies.join(" ");
}

function minRemValue(declarations, prop) {
  const m = declarations.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([0-9.]+)rem`));
  return m ? Number.parseFloat(m[1]) : null;
}

const TARGET_SIZE_SELECTORS = [
  { selector: ".fillo-group-add", minRem: 1.5, checkWidth: true, checkHeight: true },
  { selector: ".fillo-group-remove", minRem: 1.5, checkWidth: true, checkHeight: true },
  { selector: ".fillo-ranking-move", minRem: 1.5, checkWidth: true, checkHeight: true },
  { selector: ".fillo-file-remove", minRem: 2, checkWidth: true, checkHeight: true },
  { selector: ".fillo-file-retry", minRem: 2, checkWidth: true, checkHeight: true },
  { selector: ".fillo-signature-clear", minRem: 1.5, checkWidth: true, checkHeight: true },
  { selector: ".fillo-star", minRem: 1.75, checkWidth: true, checkHeight: true },
  { selector: ".fillo-matrix-cell", minRem: 1.5, checkWidth: false, checkHeight: true },
];

const STYLESHEETS = [
  { label: "react", url: REACT_CSS_URL },
  { label: "dom", url: DOM_CSS_URL },
];

for (const sheet of STYLESHEETS) {
  const css = readFileSync(sheet.url, "utf8");
  for (const spec of TARGET_SIZE_SELECTORS) {
    const dims = [spec.checkWidth && "min-width", spec.checkHeight && "min-height"]
      .filter(Boolean)
      .join(" and ");
    test(`target size: ${sheet.label} ${spec.selector} declares ${dims} >= ${spec.minRem}rem`, () => {
      const decls = declarationsFor(css, spec.selector);
      assert.ok(
        decls.length > 0,
        `${sheet.label}: no rule block found for selector ${spec.selector} — was it renamed?`,
      );
      if (spec.checkWidth) {
        const w = minRemValue(decls, "min-width");
        assert.ok(
          w !== null && w >= spec.minRem,
          `${sheet.label}: ${spec.selector} must declare min-width >= ${spec.minRem}rem (found ${w === null ? "none" : `${w}rem`})`,
        );
      }
      if (spec.checkHeight) {
        const h = minRemValue(decls, "min-height");
        assert.ok(
          h !== null && h >= spec.minRem,
          `${sheet.label}: ${spec.selector} must declare min-height >= ${spec.minRem}rem (found ${h === null ? "none" : `${h}rem`})`,
        );
      }
    });
  }

  test(`upload/error visual contract: ${sheet.label}`, () => {
    const file = declarationsFor(css, ".fillo-file");
    const failed = declarationsFor(css, ".fillo-file--failed");
    const content = declarationsFor(css, ".fillo-file-content");
    const progress = declarationsFor(css, ".fillo-progress");

    assert.match(file, /grid-template-columns\s*:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
    assert.match(content, /min-width\s*:\s*0/);
    assert.match(progress, /grid-column\s*:\s*2\s*\/\s*-1/);
    assert.match(failed, /border-inline-start\s*:\s*3px\s+solid/);
    assert.match(failed, /background\s*:\s*color-mix/);
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-label\s*\{[^}]*color\s*:\s*var\(--fillo-error\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-dropzone\s*\{[^}]*border-color\s*:\s*var\(--fillo-error\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-input:focus-visible\s*\{[^}]*box-shadow\s*:\s*0\s+0\s+0\s+3px\s+color-mix\(in srgb,\s*var\(--fillo-error\)\s+20%,\s*transparent\)[^}]*outline\s*:\s*none/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-dropzone:focus-visible\s*\{[^}]*box-shadow\s*:\s*0\s+0\s+0\s+3px\s+color-mix\(in srgb,\s*var\(--fillo-error\)\s+20%,\s*transparent\)[^}]*outline\s*:\s*none/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-number:focus-within\s*\{[^}]*box-shadow\s*:\s*0\s+0\s+0\s+3px\s+color-mix\(in srgb,\s*var\(--fillo-error\)\s+20%,\s*transparent\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) :where\(\.fillo-number\) \.fillo-input:focus-visible\s*\{[^}]*outline\s*:\s*none/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-option\s*\{[^}]*border-color\s*:\s*var\(--fillo-error\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-option:focus-within\s*\{[^}]*box-shadow\s*:\s*0\s+0\s+0\s+3px\s+color-mix\(in srgb,\s*var\(--fillo-error\)\s+20%,\s*transparent\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) :where\(\.fillo-toggle-input:focus-visible\) \+ \.fillo-toggle-track\s*\{[^}]*0\s+0\s+0\s+3px\s+color-mix\(in srgb,\s*var\(--fillo-error\)\s+20%,\s*transparent\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-scale-step:focus-visible\s*\{[^}]*box-shadow\s*:\s*0\s+0\s+0\s+3px\s+color-mix\(in srgb,\s*var\(--fillo-error\)\s+20%,\s*transparent\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-star:focus-visible\s*\{[^}]*outline-color\s*:\s*var\(--fillo-error\)/s,
    );
    assert.match(
      css,
      /:where\(\.fillo-field--error\) \.fillo-matrix-cell:focus-within\s*\{[^}]*outline-color\s*:\s*var\(--fillo-error\)/s,
    );
    assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
}
