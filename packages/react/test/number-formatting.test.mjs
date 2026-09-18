import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// Globals must exist before React DOM is imported.
const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Event = dom.window.Event;
globalThis.Node = dom.window.Node;
globalThis.File = dom.window.File;
// React act() opt-in — updates are driven manually below.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilloForm } = await import("../dist/index.js");

function oneFieldForm(field) {
  return {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [field] }],
  };
}

function fakeClient(over = {}) {
  return {
    key: "pk_test",
    baseUrl: "",
    submit: async () => ({ ok: true, responseId: "r1" }),
    startSession: async () => null,
    reportProgress: () => {},
    ...over,
  };
}

async function mount(element) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const root = createRoot(target);
  await act(async () => root.render(element));
  return { target, root };
}

// React dedupes direct .value writes via its value tracker — go through the
// native setter so the input event actually reaches onChange.
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
).set;
async function type(input, value) {
  await act(async () => {
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function focus(input) {
  await act(async () => {
    input.focus();
  });
}

async function blur(input) {
  await act(async () => {
    input.blur();
  });
}

test("plain number field renders exactly like today — no wrapper, type=number", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "qty", kind: "number", label: "Qty" }),
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const row = target.querySelector('[data-field="qty"]');
  const input = row.querySelector("input");
  assert.equal(input.type, "number");
  assert.equal(input.className, "fillo-input", "same control class TextInput would produce");
  assert.equal(
    input.parentElement,
    row,
    "input is a direct child of the field shell — no wrapper div",
  );
  assert.equal(row.querySelector(".fillo-number"), null, "no adornment wrapper for a plain field");
  assert.equal(input.getAttribute("inputmode"), null);
});

test("prefix and suffix render as adornment spans with exact text", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({
        id: "weight",
        kind: "number",
        label: "Weight",
        prefix: "$",
        suffix: " kg",
        min: 0,
        max: 500,
      }),
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const row = target.querySelector('[data-field="weight"]');
  const wrap = row.querySelector(".fillo-number");
  assert.ok(wrap, "adornment wrapper renders");
  const input = wrap.querySelector("input");
  assert.equal(input.type, "text", "affix-only is a formatted field — text, not native number");
  assert.equal(input.getAttribute("inputmode"), "decimal");
  assert.equal(
    input.getAttribute("min"),
    null,
    "min/max are inert on text — dropped, core validation enforces them",
  );
  assert.equal(input.getAttribute("max"), null);
  assert.equal(wrap.querySelector(".fillo-number-prefix").textContent, "$");
  assert.equal(
    wrap.querySelector(".fillo-number-suffix").textContent,
    " kg",
    "leading space preserved",
  );
  assert.equal(row.querySelector("label").getAttribute("for"), input.id, "aria wiring intact");
});

test("grouped number: typed value is canonical in data and the submit payload", async () => {
  let liveData = null;
  let submitted = null;
  const client = fakeClient({
    submit: async (_formId, data) => {
      submitted = data;
      return { ok: true, responseId: "r1" };
    },
  });
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "amt", kind: "number", label: "Amount", notation: "grouped" }),
      formId: "f1",
      client,
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  await focus(input);
  await type(input, "1234567");
  assert.equal(liveData?.amt, "1234567", "data holds canonical text while typing, never grouped");

  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  // validateResponse (core, unrelated to this feature) normalizes a "number"
  // field's canonical text to a JS number for every number field, formatted
  // or not — the grouping contract only guarantees the pre-submit `data` text
  // is canonical (never grouped), which the onChange assertion above covers.
  assert.equal(submitted?.amt, 1234567, "submit payload carries the canonical value");
});

test("grouped number: blur formats with locale grouping, focus leaves it unchanged", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({
        id: "amt",
        kind: "number",
        label: "Amount",
        notation: "grouped",
        min: 0,
        max: 9999999,
      }),
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  assert.equal(
    input.getAttribute("min"),
    null,
    "min/max are inert on a text input — dropped in grouped mode",
  );
  assert.equal(input.getAttribute("max"), null);
  assert.equal(input.getAttribute("inputmode"), "decimal");

  await focus(input);
  await type(input, "1234567");
  assert.equal(input.value, "1234567", "raw text while typing, no live regrouping");

  await blur(input);
  assert.equal(input.value, "1,234,567", "jsdom's default locale is en-US");

  await focus(input);
  assert.equal(input.value, "1,234,567", "no unformat-on-focus — focusing changes nothing");
});

test("grouped number: a mid-session edit parses the full stale-separator text, not a diff under the caret", async () => {
  let liveData = null;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({
        id: "amt",
        kind: "number",
        label: "Amount",
        notation: "grouped",
        decimals: 2,
      }),
      formId: "f-test",
      client: fakeClient(),
      initialData: { amt: 1234567.89 },
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  assert.equal(input.value, "1,234,567.89", "unfocused, prefilled display is grouped");

  await focus(input);
  assert.equal(
    input.value,
    "1,234,567.89",
    "still grouped after focus — nothing unformats it first",
  );

  // The respondent edits the formatted text directly ("567" → "5679"),
  // leaving stale separators mid-string. Every change parses the FULL text,
  // not just what changed under the caret.
  await type(input, "1,234,5679.89");
  assert.equal(
    liveData?.amt,
    "12345679.89",
    "parseGroupedNumber strips every group separator in the full text",
  );
});

test("grouped number with decimals pads the blurred display", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({
        id: "price",
        kind: "number",
        label: "Price",
        notation: "grouped",
        decimals: 2,
      }),
      formId: "f-test",
      client: fakeClient(),
      initialData: { price: 1234.5 },
    }),
  );
  const input = target.querySelector('[data-field="price"] input');
  assert.equal(
    input.value,
    "1,234.50",
    "never focused — formats straight from the prefilled value",
  );
});

// ---------- Keystroke filter (isValidPartialNumberText) ----------
// Letters/stray symbols never reach data at all now — a stray-letter edit is
// rejected at the keystroke level instead of flowing through as raw text for
// validation to flag later (the old contract, superseded by the input-quality
// keystroke filter).

test("a stray letter or a mixed candidate is rejected wholesale — value/data stay unchanged", async () => {
  let liveData = null;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "amt", kind: "number", label: "Amount", notation: "grouped" }),
      formId: "f-test",
      client: fakeClient(),
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  await focus(input);

  await type(input, "abc");
  assert.equal(input.value, "", "letters fail the keystroke filter — display reverts to empty");
  assert.equal(liveData, null, "a rejected edit never reaches data");

  await type(input, "12a");
  assert.equal(
    input.value,
    "",
    'a mixed candidate rejects WHOLESALE — not trimmed down to its valid "12" prefix',
  );
  assert.equal(liveData, null);
});

test("grouped number: a second decimal point is rejected, the last valid text is kept", async () => {
  let liveData = null;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "amt", kind: "number", label: "Amount", notation: "grouped" }),
      formId: "f-test",
      client: fakeClient(),
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  await focus(input);

  await type(input, "1,234.5");
  assert.equal(
    input.value,
    "1,234.5",
    "digits + group separator + one decimal are all valid keystrokes",
  );
  assert.equal(liveData?.amt, "1234.5");

  await type(input, "1,234.5.");
  assert.equal(input.value, "1,234.5", 'a second "." is rejected — reverts to the last valid text');
  assert.equal(liveData?.amt, "1234.5", "data is untouched by the rejected edit");
});

test("grouped number: a lone minus is accepted, then a digit completes it", async () => {
  let liveData = null;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "amt", kind: "number", label: "Amount", notation: "grouped" }),
      formId: "f-test",
      client: fakeClient(),
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  await focus(input);

  await type(input, "-");
  assert.equal(input.value, "-");
  assert.equal(liveData?.amt, "-");

  await type(input, "-5");
  assert.equal(input.value, "-5");
  assert.equal(liveData?.amt, "-5");
});

// ---------- Author-fixed notation styles ----------
// The mapped locale (core's localeForNotation) must beat the runtime's own
// default — jsdom/node default to en-US, so a grouped-dot field proving
// dot-groups/comma-decimal here proves the style is really pinned.

test("notation:grouped-dot displays dot-grouped, comma-decimal text regardless of the runtime locale", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({
        id: "price",
        kind: "number",
        label: "Price",
        notation: "grouped-dot",
        decimals: 2,
      }),
      formId: "f-test",
      client: fakeClient(),
      initialData: { price: 1234.5 },
    }),
  );
  const input = target.querySelector('[data-field="price"] input');
  assert.equal(input.value, "1.234,50", "de-DE-style display even though jsdom defaults en-US");
});

test("notation:grouped-dot: typing 1.234,56 keeps data canonical 1234.56 and blur reformats", async () => {
  let liveData = null;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "price", kind: "number", label: "Price", notation: "grouped-dot" }),
      formId: "f-test",
      client: fakeClient(),
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="price"] input');
  await focus(input);
  await type(input, "1.234,56");
  assert.equal(input.value, "1.234,56", "the fixed style's separators pass the keystroke filter");
  assert.equal(
    liveData?.price,
    "1234.56",
    "data holds canonical dot-decimal text, never the styled one",
  );

  await blur(input);
  assert.equal(input.value, "1.234,56", "blur formats from the stored value in the fixed style");
});

test("notation:grouped-dot: the keystroke filter follows the fixed locale, not the browser's", async () => {
  let liveData = null;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "price", kind: "number", label: "Price", notation: "grouped-dot" }),
      formId: "f-test",
      client: fakeClient(),
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="price"] input');
  await focus(input);

  await type(input, "1.2.3");
  assert.equal(input.value, "1.2.3", '"." is the fixed style\'s GROUP separator — unlimited');

  await type(input, "1.2.3,4");
  assert.equal(liveData?.price, "123.4", "one comma decimal accepted, dots stripped as groups");

  await type(input, "1.2.3,4,");
  assert.equal(input.value, "1.2.3,4", 'a second "," — the fixed style\'s decimal — is rejected');
  assert.equal(liveData?.price, "123.4", "data untouched by the rejected edit");
});

test("notation:grouped-comma: a lone-comma decimal reads as a decimal, never silently stripped", async () => {
  let liveData = null;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "amt", kind: "number", label: "Amount", notation: "grouped-comma" }),
      formId: "f-test",
      client: fakeClient(),
      onChange: (data) => {
        liveData = data;
      },
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  await focus(input);
  await type(input, "12,5");
  assert.equal(
    liveData?.amt,
    "12.5",
    "a comma-decimal respondent's 12,5 means 12.5 — not the old silent 125",
  );
  await blur(input);
  assert.equal(input.value, "12.5", "blur reformats in the fixed comma-group style");
});

test("a prefilled grouped value renders formatted before any focus", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: oneFieldForm({ id: "amt", kind: "number", label: "Amount", notation: "grouped" }),
      formId: "f-test",
      client: fakeClient(),
      initialData: { amt: "1234567" },
    }),
  );
  const input = target.querySelector('[data-field="amt"] input');
  assert.equal(
    input.value,
    "1,234,567",
    "controlled/prefilled value formats without ever being focused",
  );
});
