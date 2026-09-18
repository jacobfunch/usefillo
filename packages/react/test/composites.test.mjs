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
globalThis.Image = dom.window.Image;
// React act() opt-in — updates are driven manually below.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements neither requestAnimationFrame/cancelAnimationFrame nor
// getComputedStyle as bare globals (only on `window`), and canvas 2D context
// requires the optional `canvas` npm package this repo doesn't depend on.
// Shim the minimum the composites under test touch: the phone popover's
// open-focus + viewport positioning, the rating/scale keyboard math's RTL
// probe (getComputedStyle(group).direction), and the signature canvas.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.getComputedStyle = (...args) => dom.window.getComputedStyle(...args);
// jsdom also has no layout engine, so scrollIntoView (used to keep the
// highlighted phone-picker option in view) doesn't exist either.
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

function fakeCanvasCtx() {
  return {
    scale() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    drawImage() {},
    fillText() {},
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    strokeStyle: "",
    fillStyle: "",
    font: "",
    textBaseline: "",
  };
}
dom.window.HTMLCanvasElement.prototype.getContext = () => fakeCanvasCtx();
dom.window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,test";

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilloForm } = await import("../dist/index.js");

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
// native setter so the input event actually reaches onChange (same pattern
// as fillo-form.test.mjs).
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

function pointerClick(el) {
  el.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
  );
}
function keyboardClick(el) {
  el.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }),
  );
}

test("rating radiogroup carries the field's id (P0.4) and its keyboard nav clamps + supports Home/End (P2.3)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "stars", kind: "rating", label: "Stars", required: true, max: 5 }],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const field = target.querySelector('[data-field="stars"]');
  const group = field.querySelector('[role="radiogroup"]');
  const label = field.querySelector('[data-fillo="label"]');
  assert.ok(group.id, "radiogroup has an id");
  assert.equal(
    group.id,
    label.getAttribute("for"),
    "the field label now points at the radiogroup (P0.4)",
  );
  assert.equal(group.getAttribute("aria-required"), "true");

  const press = (key) =>
    act(async () => {
      group.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  const checkedLabel = () =>
    group.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("aria-label");

  await press("End");
  assert.equal(checkedLabel(), "5 of 5", "End jumps to the max");
  await press("ArrowRight");
  assert.equal(
    checkedLabel(),
    "5 of 5",
    "clamped at the extreme — no wrap (contract, not the old modulo math)",
  );

  await press("Home");
  assert.equal(checkedLabel(), "1 of 5", "Home jumps to the min");
  await press("ArrowLeft");
  assert.equal(checkedLabel(), "1 of 5", "clamped at the extreme in the other direction too");

  const stars = group.querySelectorAll('[role="radio"]');
  assert.equal(stars[0].textContent, "★", "selected star renders the filled glyph (P1.2)");
  assert.equal(stars[1].textContent, "☆", "unselected star renders the outline glyph");
});

test("rating: a keyboard click (Space/Enter) on the checked value is a no-op; pointer click-again clears (P2.4)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "stars", kind: "rating", label: "Stars", max: 5 }] }],
  };
  let latest;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-test",
      client: fakeClient(),
      onChange: (d) => {
        latest = d.stars;
      },
    }),
  );
  const third = target.querySelectorAll('[data-field="stars"] [role="radio"]')[2];

  await act(async () => pointerClick(third));
  assert.equal(latest, 3);

  await act(async () => keyboardClick(third));
  assert.equal(latest, 3, "a keyboard-triggered click (detail 0) on the checked value is a no-op");

  await act(async () => pointerClick(third));
  assert.equal(latest, null, "pointer click-again still clears");
});

test("ranking: a move that disables the pressed button refocuses the item's other move button (P1.5)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "rank",
            kind: "ranking",
            label: "Rank",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
              { id: "c", label: "C" },
            ],
          },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const findItem = (label) =>
    Array.from(target.querySelectorAll(".fillo-ranking-item")).find(
      (li) => li.querySelector(".fillo-ranking-label").textContent === label,
    );
  const aItem = findItem("A");
  const [upA, downA] = aItem.querySelectorAll(".fillo-ranking-move");
  assert.equal(upA.disabled, true, "A starts first: up is disabled");
  assert.equal(downA.disabled, false);

  await act(async () => downA.click()); // A: 0 -> 1 (middle) — down stays enabled
  assert.equal(downA.disabled, false, "not yet at the extreme");

  await act(async () => downA.click()); // A: 1 -> 2 (last) — down becomes disabled
  assert.equal(downA.disabled, true, "A is now last: down is disabled");
  assert.equal(
    document.activeElement,
    upA,
    "focus moved to A's other (up) button instead of stranding on <body>",
  );
});

test("ranking: a move announces the new position through the persistent channel (contract §Announcements)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "rank",
            kind: "ranking",
            label: "Rank",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
              { id: "c", label: "C" },
            ],
          },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const channel = target.querySelector('[data-fillo="announce"]');
  const findItem = (label) =>
    Array.from(target.querySelectorAll(".fillo-ranking-item")).find(
      (li) => li.querySelector(".fillo-ranking-label").textContent === label,
    );
  const [, downA] = findItem("A").querySelectorAll(".fillo-ranking-move");

  await act(async () => downA.click()); // A: 0 -> 1 (of 3)
  assert.equal(channel.textContent, "A, position 2 of 3");

  await act(async () => downA.click()); // A: 1 -> 2 (of 3) — a second real move re-announces
  assert.equal(channel.textContent, "A, position 3 of 3");
});

test("matrix: each cell wraps its radio in a label (pointer target) with data-label, and the row group is labelled by field + row (P1.3/§10)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "grid",
            kind: "matrix",
            label: "Grid",
            required: true,
            rows: [{ id: "r1", label: "Row 1" }],
            columns: [
              { id: "c1", label: "Col 1" },
              { id: "c2", label: "Col 2" },
            ],
          },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const field = target.querySelector('[data-field="grid"]');
  const fieldLabel = field.querySelector('[data-fillo="label"]');
  const rowGroup = field.querySelector('[role="radiogroup"]');
  const rowLabel = rowGroup.querySelector("span[id]");
  assert.equal(
    rowGroup.getAttribute("aria-labelledby"),
    `${fieldLabel.id} ${rowLabel.id}`,
    "row radiogroup is labelled by BOTH the field label and the row label",
  );

  // Scoped to tbody: the thead corner cell above the row-label column is
  // also a <td> now (empty-table-header fix, ledger #2) — querying bare "td"
  // would double-count it alongside the two real data cells below.
  const cells = field.querySelectorAll("tbody td");
  assert.equal(cells.length, 2);
  const expectedLabels = ["Col 1", "Col 2"];
  cells.forEach((td, i) => {
    assert.equal(
      td.getAttribute("data-label"),
      expectedLabels[i],
      "data-label feeds the stacked mobile layout",
    );
    const cellLabel = td.querySelector("label.fillo-matrix-cell");
    assert.ok(cellLabel, "the radio is wrapped in a label so the whole cell is the pointer target");
    const radio = cellLabel.querySelector('input[type="radio"]');
    assert.ok(radio, "the radio lives inside the label wrapper");
    assert.equal(radio.getAttribute("aria-label"), `Row 1: ${expectedLabels[i]}`);
  });
});

test("phone: an unresolved international '+' prefix stays pending (raw, uncommitted country) until a dial code resolves (P0.2/§4)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "phone", kind: "phone", label: "Phone", defaultCountry: "US" }] },
    ],
  };
  let latest;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-test",
      client: fakeClient(),
      onChange: (d) => {
        latest = d.phone;
      },
    }),
  );
  const input = target.querySelector(".fillo-phone-input");
  const flag = () => target.querySelector(".fillo-phone-flag").getAttribute("aria-label");

  assert.match(flag(), /United States/, "starts on the schema's defaultCountry");

  await type(input, "+");
  assert.equal(latest, "+", "a lone + stays pending raw, not cleared");
  assert.equal(input.value, "+", "the input text is not reformatted while pending");
  assert.match(flag(), /United States/, "the country does not change on a bare +");

  await type(input, "+4");
  assert.equal(latest, "+4", "a partial dial code stays pending raw");
  assert.equal(input.value, "+4");
  assert.match(
    flag(),
    /United States/,
    "still no country reassignment — +4 does not match a dial code yet",
  );

  await type(input, "+45");
  assert.match(flag(), /Denmark/, "+45 resolves Denmark's dial code");

  await type(input, "+4532123456");
  assert.equal(
    latest,
    "+4532123456",
    "continuing to type composes the full E.164 value once resolved",
  );
});

test("phone: ArrowDown opens the closed trigger; Tab-away then closes the popover without forcing focus back to it (P1.8/§5-6)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "phone", kind: "phone", label: "Phone" }] }],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const trigger = target.querySelector(".fillo-phone-flag");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await act(async () => {
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(
    trigger.getAttribute("aria-expanded"),
    "true",
    "ArrowDown opens the closed-state trigger",
  );

  const search = target.querySelector(".fillo-phone-search");
  assert.ok(search, "search box rendered");
  await act(async () => search.focus());
  assert.equal(document.activeElement, search);

  const nationalInput = target.querySelector(".fillo-phone-input");
  await act(async () => nationalInput.focus()); // simulates Tab landing on the next field
  assert.equal(
    document.activeElement,
    nationalInput,
    "focus moved where Tab sent it, not back to the trigger",
  );
  assert.equal(trigger.getAttribute("aria-expanded"), "false", "Tab-away closed the popover");
  assert.equal(target.querySelector(".fillo-phone-popover"), null, "popover unmounted");
});

test("phone: a printable key on the closed trigger opens the popover and seeds the filter (P1.8/§5)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "phone", kind: "phone", label: "Phone" }] }],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const trigger = target.querySelector(".fillo-phone-flag");
  await act(async () => {
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }),
    );
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "a printable key opens the popover");
  assert.equal(
    target.querySelector(".fillo-phone-search").value,
    "d",
    "...and seeds the filter with that character",
  );
});

test("phone: picking a country announces it through the persistent channel (P2.7/§Announcements)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "phone", kind: "phone", label: "Phone" }] }],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const trigger = target.querySelector(".fillo-phone-flag");
  await act(async () => {
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await type(target.querySelector(".fillo-phone-search"), "Denmark");
  const option = target.querySelector(".fillo-phone-option");
  assert.match(option.textContent, /Denmark/, "the search narrowed to a single match");

  const channel = target.querySelector('[data-fillo="announce"]');
  await act(async () => {
    option.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
  });
  assert.equal(channel.textContent, "Denmark selected");
});

test("phone: the filtered result count announces debounced (~300ms), never per keystroke (P2.7/§Announcements)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "phone", kind: "phone", label: "Phone" }] }],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const trigger = target.querySelector(".fillo-phone-flag");
  await act(async () => {
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const search = target.querySelector(".fillo-phone-search");
  const channel = target.querySelector('[data-fillo="announce"]');

  await type(search, "den");
  assert.equal(
    channel.textContent,
    "",
    "no announcement immediately after typing — debounced, not per-keystroke",
  );

  await act(async () => new Promise((r) => setTimeout(r, 350)));
  const matchCount = target.querySelectorAll(".fillo-phone-option").length;
  assert.ok(matchCount > 0, "the filter matched at least one country");
  assert.equal(
    channel.textContent,
    `${matchCount} ${matchCount === 1 ? "result" : "results"}`,
    "announces once typing settles",
  );
});

test("signature: canvas exposes role=img with a live signed/empty accessible name; Clear moves focus to the type-to-sign input (P1.6)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "sig", kind: "signature", label: "Sign" }] }],
  };
  const { target: emptyTarget } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const emptyCanvas = emptyTarget.querySelector(".fillo-signature-canvas");
  assert.equal(emptyCanvas.getAttribute("role"), "img");
  assert.equal(
    emptyCanvas.hasAttribute("aria-hidden"),
    false,
    "no longer hidden from assistive tech",
  );
  assert.equal(emptyCanvas.getAttribute("aria-label"), "No signature yet");

  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-test",
      client: fakeClient(),
      initialData: { sig: "data:image/png;base64,zzzz" },
    }),
  );
  const canvas = target.querySelector(".fillo-signature-canvas");
  assert.equal(
    canvas.getAttribute("aria-label"),
    "Signature saved",
    "accessible name reflects the signed state",
  );

  const clearBtn = target.querySelector(".fillo-signature-clear");
  assert.ok(clearBtn, "Clear renders once there is ink");
  const typeInput = target.querySelector(".fillo-signature-type-input");
  await act(async () => clearBtn.click());
  assert.equal(
    document.activeElement,
    typeInput,
    "Clear moves focus to the type-to-sign input instead of stranding it",
  );
  assert.equal(
    target.querySelector(".fillo-signature-clear"),
    null,
    "Clear unmounts itself once the ink is gone",
  );
  assert.equal(
    canvas.getAttribute("aria-label"),
    "No signature yet",
    "accessible name flips back once cleared",
  );
});
