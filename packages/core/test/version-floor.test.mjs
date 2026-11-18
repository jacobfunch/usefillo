import test from "node:test";
import assert from "node:assert/strict";
import {
  FILLO_CALC_MIN_SDK_VERSION,
  FILLO_CHALLENGE_MIN_SDK_VERSION,
  FILLO_MIN_SDK_VERSION,
  FILLO_SDK_VERSION,
} from "../dist/index.js";

const parse = (v) => v.split(".").map((n) => parseInt(n, 10));
const cmp = (a, b) => {
  const [aa, bb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((aa[i] ?? 0) !== (bb[i] ?? 0)) return (aa[i] ?? 0) - (bb[i] ?? 0);
  }
  return 0;
};

test("FILLO_MIN_SDK_VERSION is a fixed semver literal", () => {
  assert.match(FILLO_MIN_SDK_VERSION, /^\d+\.\d+\.\d+$/);
});

test("the served min-SDK floor is strictly below the build version", () => {
  // Regression guard for the review's critical finding: the server used to serve
  // FILLO_SDK_VERSION (its own build version) as minSdkVersion, so every release
  // 426'd every customer on an older pinned SDK. If someone re-ties the floor to
  // the build version, min === build and this assertion fails.
  assert.ok(
    cmp(FILLO_MIN_SDK_VERSION, FILLO_SDK_VERSION) < 0,
    `FILLO_MIN_SDK_VERSION (${FILLO_MIN_SDK_VERSION}) must be below the build version (${FILLO_SDK_VERSION}); it is a hand-maintained wire-compat floor, not the build version`,
  );
});

test("the challenge floor is a fixed semver literal strictly ABOVE the base floor", () => {
  // Challenge-enabled forms serve this raised floor so an SDK without the
  // Turnstile widget fails fast with the update error instead of rendering a
  // form whose every submit the server rejects. Equal to the base floor it
  // would gate nothing.
  assert.match(FILLO_CHALLENGE_MIN_SDK_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(
    cmp(FILLO_CHALLENGE_MIN_SDK_VERSION, FILLO_MIN_SDK_VERSION) > 0,
    `FILLO_CHALLENGE_MIN_SDK_VERSION (${FILLO_CHALLENGE_MIN_SDK_VERSION}) must be above FILLO_MIN_SDK_VERSION (${FILLO_MIN_SDK_VERSION})`,
  );
});

test("the calc floor is a fixed semver literal strictly ABOVE the base floor", () => {
  // Calc-enabled forms serve this raised floor: an older SDK's zod enum strips
  // the unknown kind, so it renders the form WITHOUT the calc row — piping
  // shows blanks and logic reading the calc id misbehaves. That's wrong-form-
  // behavior, not missing chrome, so those forms fail fast with the update
  // error (the Turnstile precedent). Equal to the base floor it would gate
  // nothing.
  assert.match(FILLO_CALC_MIN_SDK_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(
    cmp(FILLO_CALC_MIN_SDK_VERSION, FILLO_MIN_SDK_VERSION) > 0,
    `FILLO_CALC_MIN_SDK_VERSION (${FILLO_CALC_MIN_SDK_VERSION}) must be above FILLO_MIN_SDK_VERSION (${FILLO_MIN_SDK_VERSION})`,
  );
});
