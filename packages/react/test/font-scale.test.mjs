import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The type-scale doctrine, enforced (decision 2026-08-09, PR #254):
 *
 * The form is one sealed type system anchored to ONE local root —
 * `--fillo-font-size` on .fillo-form (default: inherit the host). Every
 * internal font-size is em, proportional to that root. rem is BANNED for
 * font sizes: its anchor (the page root) belongs to the host, not to us, and
 * mixing it with the controls' universal `font: inherit` reproduces the
 * split-scale bug this replaced (labels pinned to a 10px root next to 16px
 * input text). A host wanting rem semantics sets `--fillo-font-size: 1rem`;
 * wanting pinned px sets `16px` — both reachable through the one token.
 *
 * em's known cost is compounding through nested font-sized ancestors. The
 * fence: every font-size declaration in the stylesheet must appear in the
 * PINNED inventory below. Adding one forces you here, where the rule is
 * stated: if the new element nests inside a container that also carries a
 * font-size, compensate the value (divide by the ancestor factor) and record
 * the pair in NESTED_PAIRS. The two existing pairs are asserted numerically.
 */

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("font sizes never use rem — the root is the host's, not ours", () => {
  const remFonts = css.match(/font-size:\s*[0-9.]+rem/g) ?? [];
  assert.deepEqual(remFonts, [], "rem font-size reintroduced — read the doctrine above");
});

test("the form root declares the --fillo-font-size token with an inherit default", () => {
  assert.match(css, /--fillo-font-size:\s*1em/);
  assert.match(css, /font-size:\s*var\(--fillo-font-size\)/);
});

// Every font-size declaration, pinned. A new one fails here until it is
// consciously added — with the compounding question answered.
const EXPECTED = {
  ".fillo-title": "1.6em",
  ".fillo-page-title": "1.2em",
  ".fillo-label": "0.95em",
  ".fillo-optional": "0.85em",
  ".fillo-description": "0.85em",
  ".fillo-error": "0.85em",
  ".fillo-submit-error": "0.85em",
  ".fillo-phone-flag-emoji": "1.15em",
  ".fillo-phone-caret": "0.65em",
  ".fillo-option-label": "1em",
  ".fillo-other-input": "1em",
  ".fillo-star": "1.75em",
  ".fillo-scale-step": "0.92em",
  ".fillo-scale-labels": "0.78em",
  ".fillo-ranking-index": "0.78em",
  ".fillo-ranking-label": "1em",
  ".fillo-matrix": "0.9em",
  ".fillo-matrix thead th": "0.89em",
  ".fillo-matrix td::before": "0.85em",
  ".fillo-calculated-value": "1.05em",
  ".fillo-signature-hint": "0.85em",
  ".fillo-signature-clear": "0.75em",
  ".fillo-signature-type-label": "0.8em",
  ".fillo-dropzone-title": "0.95em",
  ".fillo-dropzone-hint": "0.82em",
  ".fillo-file": "0.88em",
  ".fillo-file-error": "0.93em",
  ".fillo-heading": "1.15em",
  ".fillo-not-open-title": "1.05em",
  ".fillo-not-open-body": "0.875em",
  ".fillo-success-title": "1.05em",
  ".fillo-success-message": "0.875em",
  ".fillo-powered": "0.75em",
  ".fillo-devwarning": "0.82em",
  ".fillo-devwarning code": "0.92em",
  ".fillo-preview-badge": "0.7em",
  ".fillo-resume": "0.82em",
  ".fillo-turnstile-error": "0.82em",
  ".fillo-group-instance-title": "0.95em",
  ".fillo-group-remove": "1.1em",
};

// Descendants living inside a font-sized ancestor: value = intended visual
// ratio ÷ ancestor factor, so the rendered size matches the pre-em baseline.
const NESTED_PAIRS = [
  { child: ".fillo-matrix thead th", ancestor: ".fillo-matrix", intendedOfForm: 0.8 },
  { child: ".fillo-matrix td::before", ancestor: ".fillo-matrix", intendedOfForm: 0.765 },
  { child: ".fillo-file-error", ancestor: ".fillo-file", intendedOfForm: 0.82 },
  // Dev-only chrome: code inside the warning reads at 0.92 of the warning's
  // 0.82 — a deliberate relative pairing (0.754 of the form), no compensation.
  { child: ".fillo-devwarning code", ancestor: ".fillo-devwarning", intendedOfForm: 0.7544 },
  // .fillo-optional renders inside .fillo-label AND inside .fillo-option-label
  // — deliberately relative to whichever label it annotates, no compensation.
];

function declaredSizes() {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    const fs = /(?<![-\w])font-size:\s*([0-9.]+em)/.exec(body);
    if (!fs) continue;
    const selector = m[1].trim().split("\n").pop().trim().replace(/,$/, "");
    out[selector] = fs[1];
  }
  return out;
}

test("every font-size declaration is pinned in the inventory", () => {
  const declared = declaredSizes();
  for (const [sel, size] of Object.entries(declared)) {
    assert.equal(
      EXPECTED[sel],
      size,
      `unpinned or changed font-size: "${sel}" is ${size} — answer the nesting question above, then update the inventory`,
    );
  }
  for (const sel of Object.keys(EXPECTED)) {
    assert.ok(sel in declared, `pinned selector missing from the stylesheet: "${sel}"`);
  }
});

test("compensated nested sizes keep their intended visual ratio", () => {
  for (const { child, ancestor, intendedOfForm } of NESTED_PAIRS) {
    const childEm = Number.parseFloat(EXPECTED[child]);
    const ancestorEm = Number.parseFloat(EXPECTED[ancestor]);
    const rendered = childEm * ancestorEm;
    assert.ok(
      Math.abs(rendered - intendedOfForm) < 0.005,
      `${child}: ${childEm}em × ${ancestor} ${ancestorEm}em = ${rendered.toFixed(4)} of the form font — intended ${intendedOfForm}`,
    );
  }
});

test("react and dom stylesheets are byte-identical (sync contract)", () => {
  const domCss = readFileSync(new URL("../../dom/src/styles.css", import.meta.url), "utf8");
  assert.equal(css, domCss);
});
