import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function pkg(rel) {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
}

// @usefillo/core's '.' export carries a `default` condition; react and dom must
// match it so a bundler/`require` that falls through to `default` resolves the
// same ESM entry instead of failing to find a target.
test("react and dom '.' exports include a default condition, last, matching core", () => {
  for (const rel of ["../package.json", "../../dom/package.json"]) {
    const dot = pkg(rel).exports["."];
    assert.equal(dot.default, "./dist/index.js", `${rel} '.' export needs a default condition`);
    const keys = Object.keys(dot);
    assert.equal(keys[keys.length - 1], "default", `${rel} default must be the last condition`);
  }
  // Sanity: core already has it (the shape react/dom are matching).
  assert.equal(pkg("../../core/package.json").exports["."].default, "./dist/index.js");
});
