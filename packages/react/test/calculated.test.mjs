import test from "node:test";
import assert from "node:assert/strict";
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

// Two number sources feeding a calculated subtotal — decimals/prefix/suffix
// prove the row formats through core's formatAnswer, not its own arithmetic.
const calcForm = {
  version: 1,
  title: "Quote",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "seats", kind: "number", label: "Seats" },
        { id: "addons", kind: "number", label: "Add-ons" },
        {
          id: "total",
          kind: "calculated",
          label: "Subtotal",
          description: "Updates as you pick seats.",
          calc: {
            op: "add",
            args: [
              { op: "value", fieldId: "seats" },
              { op: "value", fieldId: "addons" },
            ],
          },
          decimals: 2,
          prefix: "$",
          suffix: "/mo",
        },
      ],
    },
  ],
};

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

// Everything a keyboard could reach — the calculated row must contain none of it.
const FOCUSABLE =
  'a[href], [tabindex]:not([tabindex="-1"]), ' +
  "input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled)";

test("calculated row renders read-only with the slot/data contract and a label-tied value", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: calcForm,
      formId: "f-test",
      client: fakeClient(),
      appearance: { classNames: { calculated: "host-calc" } },
    }),
  );
  const row = target.querySelector('[data-fillo="calculated"]');
  assert.ok(row, "the calculated row renders");
  assert.equal(row.getAttribute("data-field"), "total");
  assert.equal(row.getAttribute("data-kind"), "calculated");
  for (const cls of ["fillo-field", "fillo-field--calculated", "fillo-calculated"]) {
    assert.ok(row.classList.contains(cls), `row carries ${cls}`);
  }
  assert.ok(
    row.classList.contains("host-calc"),
    "appearance.classNames.calculated lands on the row",
  );

  // Accessible name: the label points at the <output>, so screen readers
  // announce "Subtotal: —" / "Subtotal: $12.50/mo" as one thing.
  const label = row.querySelector("label.fillo-label");
  const output = row.querySelector("output.fillo-calculated-value");
  assert.ok(label && output, "label + output value present");
  assert.equal(label.getAttribute("for"), output.id);
  assert.equal(label.textContent, "Subtotal", 'no "(optional)" marker on a computed line');
  assert.match(row.querySelector(".fillo-description").textContent, /Updates as you pick/);
  assert.equal(output.getAttribute("aria-describedby"), row.querySelector(".fillo-description").id);

  // Unanswered → em dash, muted modifier.
  assert.equal(output.textContent, "—");
  assert.ok(output.classList.contains("fillo-calculated-value--empty"));

  // Never an input: nothing focusable, no tab stop, no form-control semantics.
  assert.equal(row.querySelectorAll(FOCUSABLE).length, 0, "nothing focusable inside the row");
  assert.equal(output.getAttribute("tabindex"), null);
});

test("calculated row live-updates as sources are typed and formats via formatAnswer", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, { form: calcForm, formId: "f-test", client: fakeClient() }),
  );
  const output = () => target.querySelector("output.fillo-calculated-value");

  await type(target.querySelector('[data-field="seats"] input'), "7.5");
  assert.equal(output().textContent, "—", "one unanswered source keeps the result null");

  await type(target.querySelector('[data-field="addons"] input'), "5");
  assert.equal(output().textContent, "$12.50/mo", "decimals pad + prefix/suffix, same as grid/CSV");
  assert.ok(!output().classList.contains("fillo-calculated-value--empty"));

  // Clearing a source flows back to unanswered in the same tick.
  await type(target.querySelector('[data-field="addons"] input'), "");
  assert.equal(output().textContent, "—");
  assert.ok(output().classList.contains("fillo-calculated-value--empty"));
});
