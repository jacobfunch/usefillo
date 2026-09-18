import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The SDK's font scale belongs to the host's form container, not the page root.
// Protect that embed contract without freezing every selector, size, and weight.
// Stylesheet parity is checked once in styles-contract.test.mjs.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("font sizes never use rem — the root is the host's, not ours", () => {
  const remFonts = css.match(/font-size:\s*[0-9.]+rem/g) ?? [];
  assert.deepEqual(remFonts, [], "SDK font sizes must scale with the form container");
});

test("the form root declares the --fillo-font-size token with an inherit default", () => {
  assert.match(css, /--fillo-font-size:\s*1em/);
  assert.match(css, /font-size:\s*var\(--fillo-font-size\)/);
});
