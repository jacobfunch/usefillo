import test from "node:test";
import assert from "node:assert/strict";
import { resolveThemeAppearance } from "../dist/index.js";

// ---------- luminance threshold cases ----------

test("infers 'light' for a white/near-white background", () => {
  assert.equal(resolveThemeAppearance({ background: "#ffffff", text: "#000000" }).colorScheme, "light");
  assert.equal(resolveThemeAppearance({ background: "#f4f4f5", text: "#18181b" }).colorScheme, "light");
});

test("infers 'dark' for a black/near-black background", () => {
  assert.equal(resolveThemeAppearance({ background: "#000000", text: "#ffffff" }).colorScheme, "dark");
  // The actual dark control-bg token shipped in styles.css.
  assert.equal(resolveThemeAppearance({ background: "#18181b", text: "#f4f4f5" }).colorScheme, "dark");
});

test("WCAG relative luminance is not a naive 50% perceptual midpoint (#808080 mid-gray infers light)", () => {
  // Middle gray by hex value has WCAG relative luminance ≈0.216, above the
  // ≈0.179 balanced threshold — this is the spec's math, not a "looks
  // darkish so call it dark" heuristic.
  assert.equal(resolveThemeAppearance({ background: "#808080", text: "#000000" }).colorScheme, "light");
});

test("exact threshold boundary: #757575 (L≈0.17789) is dark, #767676 (L≈0.18116) is light", () => {
  assert.equal(resolveThemeAppearance({ background: "#757575", text: "#fff" }).colorScheme, "dark");
  assert.equal(resolveThemeAppearance({ background: "#767676", text: "#fff" }).colorScheme, "light");
});

test("3-digit hex shorthand is parsed the same as 6-digit", () => {
  assert.equal(resolveThemeAppearance({ background: "#fff", text: "#000" }).colorScheme, "light");
  assert.equal(resolveThemeAppearance({ background: "#000", text: "#fff" }).colorScheme, "dark");
  assert.equal(resolveThemeAppearance({ background: "#000", text: "#fff" }).colorScheme, "dark");
});

test("hex parsing is case-insensitive", () => {
  assert.equal(resolveThemeAppearance({ background: "#FFFFFF", text: "#000" }).colorScheme, "light");
  assert.equal(resolveThemeAppearance({ background: "#ABC", text: "#000" }).colorScheme, "light");
});

// ---------- explicit colorScheme always wins ----------

test("explicit colorScheme is returned unchanged even when it contradicts the background's luminance", () => {
  const theme = { background: "#000000", text: "#ffffff", colorScheme: "light" };
  assert.deepEqual(resolveThemeAppearance(theme), theme);
});

test("explicit fixed colorScheme wins regardless of background", () => {
  for (const colorScheme of ["light", "dark"]) {
    const theme = { background: "#ffffff", text: "#000000", colorScheme };
    assert.equal(resolveThemeAppearance(theme).colorScheme, colorScheme);
  }
});

test("auto uses a fixed background instead of the visitor's unrelated OS preference", () => {
  assert.equal(
    resolveThemeAppearance({ background: "#ffffff", colorScheme: "auto" }).colorScheme,
    "light",
  );
  assert.equal(
    resolveThemeAppearance({ background: "#18181b", colorScheme: "auto" }).colorScheme,
    "dark",
  );
});

// ---------- partial theme / no-op cases ----------

test("a fixed background is enough to choose a complete readable palette", () => {
  assert.equal(resolveThemeAppearance({ background: "#000000" }).colorScheme, "dark");
  assert.equal(resolveThemeAppearance({ background: "#ffffff" }).colorScheme, "light");
});

test("no-op when only text is set (no background)", () => {
  const theme = { text: "#000000" };
  assert.deepEqual(resolveThemeAppearance(theme), theme);
});

test("no-op when neither background nor text is set", () => {
  const theme = { primary: "#5240ff", radius: "8px" };
  assert.deepEqual(resolveThemeAppearance(theme), theme);
});

test("no-op for a null theme (mirrors normalizeFormTheme's null passthrough)", () => {
  assert.equal(resolveThemeAppearance(null), null);
});

test("no-op when background isn't a #rgb/#rrggbb hex token (named colors, rgb(), CSS variables)", () => {
  for (const background of ["red", "rgb(0, 0, 0)", "var(--brand-bg)", "hsl(0deg 0% 0%)", "black"]) {
    const theme = { background, text: "#ffffff" };
    assert.deepEqual(
      resolveThemeAppearance(theme),
      theme,
      `expected no inference for background: ${background}`,
    );
  }
});

test("no-op for a malformed hex token (wrong length, non-hex characters)", () => {
  for (const background of ["#ff", "#fffff", "#gggggg", "#12345678"]) {
    const theme = { background, text: "#000000" };
    assert.deepEqual(resolveThemeAppearance(theme), theme);
  }
});

// ---------- inference preserves the rest of the theme ----------

test("inference adds colorScheme without dropping other theme props", () => {
  const theme = { background: "#000000", text: "#ffffff", primary: "#5240ff", radius: "12px", fontFamily: "Inter" };
  const resolved = resolveThemeAppearance(theme);
  assert.equal(resolved.colorScheme, "dark");
  assert.equal(resolved.primary, "#5240ff");
  assert.equal(resolved.radius, "12px");
  assert.equal(resolved.fontFamily, "Inter");
  assert.equal(resolved.background, "#000000");
  assert.equal(resolved.text, "#ffffff");
});

test("inference returns a new object, leaving the input theme untouched", () => {
  const theme = { background: "#000000", text: "#ffffff" };
  const resolved = resolveThemeAppearance(theme);
  assert.notEqual(resolved, theme);
  assert.equal(theme.colorScheme, undefined, "input must not be mutated");
});
