import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Specificity lint: no selector may qualify one fillo class with another
 * outside :where() — consumer single-class rules must always be able to win. */
test("stylesheet keeps single-class specificity", () => {
  const css = readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8");
  const offenders = [];
  for (const raw of css.split("{")) {
    const sel = raw.split("}").pop().trim();
    if (!sel || sel.startsWith("@") || sel.startsWith("/*") || sel.startsWith("--")) continue;
    for (const part of sel.split(",")) {
      const stripped = part.replace(/:where\([^)]*\)/g, "");
      const classes = stripped.match(/\.fillo-[a-zA-Z0-9_-]+/g) ?? [];
      if (classes.length >= 2) offenders.push(part.trim());
    }
  }
  assert.deepEqual(offenders, [], "wrap qualifiers in :where()");
});

test("unlayered artifact carries the same rules", () => {
  const layered = readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8");
  const unlayered = readFileSync(new URL("../dist/styles.unlayered.css", import.meta.url), "utf8");
  const count = (s) => (s.match(/\.fillo-[a-z-]+/g) ?? []).length;
  assert.equal(count(layered), count(unlayered));
  assert.ok(!unlayered.includes("@layer"), "no layer at-rules in the unlayered artifact");
});
