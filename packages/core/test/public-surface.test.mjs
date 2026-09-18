import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../dist/index.js";

// The barrel is an explicit named list (no `export *`). This guards the list
// against accidentally dropping a symbol apps/web or the renderers depend on.
test("the explicit public barrel keeps the required runtime surface", () => {
  const required = [
    "FILLO_MIN_SDK_VERSION",
    "FILLO_SDK_VERSION",
    "FILLO_SCHEMA_VERSION",
    "FILLO_CALC_MIN_SDK_VERSION",
    "FILLO_GROUP_MIN_SDK_VERSION",
    "evaluateCalc",
    "computeCalculated",
    "responseScopeValue",
    "visiblePageBlocks",
    "visibleBlocks",
    "visibleFields",
    "visibleGroupChildren",
    "positionPhonePopover",
    "PHONE_POPOVER_VIEWPORT_GAP",
    "PHONE_PICKER_COUNTRIES",
    "radioGroupStep",
    "resolveThemeAppearance",
    "REQUIRED_FIELD_MESSAGE",
    "requiredFieldMessage",
    "BLOCK_KIND_META",
    "createFormController",
    "FilloClient",
    "createClient",
    "validateResponse",
    "validateField",
    "normalizeFormSchema",
    "DEFAULT_STRINGS",
    "resolveStrings",
    "formatGroupedNumber",
    "parseGroupedNumber",
    "isValidPartialNumberText",
    "localeForNotation",
  ];
  for (const name of required) {
    assert.notEqual(core[name], undefined, `@usefillo/core must export ${name}`);
  }
  assert.equal(typeof core.FILLO_MIN_SDK_VERSION, "string");
  assert.equal(typeof core.positionPhonePopover, "function");
  // BLOCK_KIND_META stays public because apps/web's builder imports it.
  assert.equal(typeof core.BLOCK_KIND_META, "object");
});
