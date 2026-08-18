/**
 * Emits both stylesheet artifacts from one source:
 *   dist/styles.css           — verbatim (cascade-layered; Tailwind v4 sites)
 *   dist/styles.unlayered.css — layer wrapper stripped, for Tailwind v3 /
 *     reset-heavy sites where LAYERED rules lose to ANY unlayered author CSS
 *     and the default theme would silently evaporate.
 *
 * Usage: node scripts/build-css.mjs --src <styles.css> --out <distdir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const src = args[args.indexOf("--src") + 1];
const out = args[args.indexOf("--out") + 1];
if (!src || !out) throw new Error("usage: build-css.mjs --src <file> --out <dir>");

const css = readFileSync(src, "utf8");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "styles.css"), css);

// The source is one `@layer components { … }` block spanning the rest of the
// file — assert that shape so a future restructure fails the build instead of
// silently emitting a broken artifact.
const declaration = "@layer theme, base, components, utilities;";
const opener = "@layer components {";
if (!css.includes(declaration) || !css.includes(opener)) {
  throw new Error("styles.css layer structure changed — update build-css.mjs");
}
const openAt = css.indexOf(opener);
const closeAt = css.lastIndexOf("}");
if (css.slice(closeAt + 1).trim() !== "") {
  throw new Error("content after the @layer components block — update build-css.mjs");
}
const unlayered =
  css.slice(0, openAt).replace(declaration, "/* (unlayered variant) */") +
  css.slice(openAt + opener.length, closeAt);
writeFileSync(join(out, "styles.unlayered.css"), unlayered);

// Cheap parity guard: both artifacts declare the same rule set.
const count = (s) => (s.match(/\.fillo-[a-z-]+/g) ?? []).length;
if (count(css) !== count(unlayered)) {
  throw new Error("rule-count mismatch between layered and unlayered artifacts");
}
console.log(`wrote ${out}/styles.css + styles.unlayered.css`);
