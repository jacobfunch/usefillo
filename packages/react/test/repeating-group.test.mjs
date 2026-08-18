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
// as fillo-form.test.mjs / composites.test.mjs).
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

async function selectOption(select, value) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

async function submitForm(target) {
  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
}

function guestsForm(overrides = {}) {
  return {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "guests",
            kind: "repeating_group",
            label: "Guests",
            itemLabel: "Guest",
            minInstances: 1,
            maxInstances: 3,
            fields: [
              { id: "name", kind: "short_text", label: "Name", required: true },
              {
                id: "meal",
                kind: "dropdown",
                label: "Meal",
                options: [
                  { id: "veg", label: "Vegetarian" },
                  { id: "meat", label: "Meat" },
                ],
              },
              {
                id: "notes",
                kind: "short_text",
                label: "Dietary notes",
                visibleIf: [{ fieldId: "meal", op: "eq", value: "veg" }],
              },
            ],
            ...overrides,
          },
        ],
      },
    ],
  };
}

test("repeating group: rendered count is max(stored, minInstances) — default pads to 1, minInstances=0 renders none, stored beats a smaller min", async () => {
  const { target: def } = await mount(
    React.createElement(FilloForm, { form: guestsForm(), formId: "f-test", client: fakeClient() }),
  );
  assert.equal(def.querySelectorAll(".fillo-group-instance").length, 1, "minInstances=1, no data -> 1 padded card");

  const zeroForm = guestsForm({ minInstances: 0, maxInstances: 2 });
  const { target: zero } = await mount(
    React.createElement(FilloForm, { form: zeroForm, formId: "f-test", client: fakeClient() }),
  );
  assert.equal(zero.querySelectorAll(".fillo-group-instance").length, 0, "minInstances=0, no data -> zero cards");
  assert.equal(zero.querySelector(".fillo-group-add").disabled, false);

  const { target: stored } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm(),
      formId: "f-test",
      client: fakeClient(),
      initialData: { guests: [{ name: "A" }, { name: "B" }, { name: "C" }] },
    }),
  );
  assert.equal(stored.querySelectorAll(".fillo-group-instance").length, 3, "3 stored beats minInstances=1");
});

test("repeating group: instance card carries role=group, an aria-label/title from groupInstanceLabel, and tabIndex=-1", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm(),
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const card = target.querySelector(".fillo-group-instance");
  assert.equal(card.getAttribute("role"), "group");
  assert.equal(card.getAttribute("aria-label"), "Guest 1 of 1");
  assert.equal(card.querySelector(".fillo-group-instance-title").textContent, "Guest 1 of 1");
  assert.equal(card.getAttribute("tabindex"), "-1");
  const remove = card.querySelector(".fillo-group-remove");
  assert.equal(remove.getAttribute("aria-label"), "Remove Guest 1");
  assert.equal(remove.disabled, true, "removing the only card would drop below minInstances=1");
  assert.match(remove.title, /1/);
});

test("repeating group: compound DOM ids are dot-safe and unique per instance; the label ties to the right input", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm(),
      formId: "f-test",
      client: fakeClient(),
      initialData: { guests: [{ name: "Ada" }, { name: "Alan" }] },
    }),
  );
  const fields = [0, 1].map((i) => target.querySelector(`[data-field="guests.${i}.name"]`));
  assert.ok(fields[0] && fields[1], "both compound-keyed fields render");
  const inputs = fields.map((f) => f.querySelector("input"));
  assert.notEqual(inputs[0].id, inputs[1].id, "same child id in two instances gets two distinct DOM ids");
  assert.match(inputs[0].id, /guests\.0\.name/);
  assert.match(inputs[1].id, /guests\.1\.name/);
  assert.equal(fields[0].querySelector("label").getAttribute("for"), inputs[0].id);
  assert.equal(inputs[0].value, "Ada");
  assert.equal(inputs[1].value, "Alan");
});

test("repeating group: a child edit writes the whole array through setValue, padding to the rendered count", async () => {
  let latest;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm(),
      formId: "f-test",
      client: fakeClient(),
      onChange: (d) => {
        latest = d;
      },
    }),
  );
  const input = target.querySelector('[data-field="guests.0.name"] input');
  await type(input, "Ada");
  assert.deepEqual(latest.guests, [{ name: "Ada" }], "single instance, padded shape materialized on first write");

  const select = target.querySelector('[data-field="guests.0.meal"] select');
  await selectOption(select, "veg");
  assert.deepEqual(latest.guests, [{ name: "Ada", meal: "veg" }], "second child edit patches the SAME instance, not a new one");
});

test("repeating group: visibleIf scopes to same-instance siblings only — one instance's hidden child doesn't leak into another's", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm(),
      formId: "f-test",
      client: fakeClient(),
      initialData: { guests: [{ meal: "meat" }, { meal: "veg" }] },
    }),
  );
  const cards = target.querySelectorAll(".fillo-group-instance");
  assert.equal(cards.length, 2);
  assert.equal(
    cards[0].querySelector('[data-field="guests.0.notes"]'),
    null,
    "instance 0 (meat) keeps its sibling-scoped notes field hidden",
  );
  assert.ok(
    cards[1].querySelector('[data-field="guests.1.notes"]'),
    "instance 1 (veg) shows its OWN notes field independently",
  );

  // Flipping instance 0's meal to veg reveals instance 0's notes without
  // touching instance 1's (already-visible) notes.
  const meal0 = cards[0].querySelector('[data-field="guests.0.meal"] select');
  await selectOption(meal0, "veg");
  assert.ok(target.querySelector('[data-field="guests.0.notes"]'), "instance 0's notes now shows too");
  assert.ok(target.querySelector('[data-field="guests.1.notes"]'), "instance 1's notes is still shown");
});

test("repeating group: add appends an instance, focuses its first field control (not Remove), announces, and disables Add at maxInstances", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm(),
      formId: "f-test",
      client: fakeClient(),
      initialData: { guests: [{ name: "Ada", meal: "veg" }] },
    }),
  );
  const channel = target.querySelector('[data-fillo="announce"]');
  const addBtn = target.querySelector(".fillo-group-add");
  assert.equal(addBtn.textContent, "Add another");

  await act(async () => addBtn.click());
  let cards = target.querySelectorAll(".fillo-group-instance");
  assert.equal(cards.length, 2, "add appended a second card");
  assert.equal(channel.textContent, "Guest 2 added, 2 of 2");
  const secondNameInput = target.querySelector('[data-field="guests.1.name"] input');
  assert.equal(document.activeElement, secondNameInput, "focus lands on the new card's first field control");
  assert.notEqual(document.activeElement.className, "fillo-group-remove", "never the Remove button");

  await act(async () => target.querySelector(".fillo-group-add").click());
  cards = target.querySelectorAll(".fillo-group-instance");
  assert.equal(cards.length, 3, "maxInstances=3 reached");
  const addAtMax = target.querySelector(".fillo-group-add");
  assert.equal(addAtMax.disabled, true);
  assert.equal(addAtMax.getAttribute("aria-disabled"), "true");
  assert.ok(addAtMax.title, "title conveys the max instance count");
});

test("repeating group: remove splices the target instance, focuses the previous card (or Add for the first), announces, and disables at the floor", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm(),
      formId: "f-test",
      client: fakeClient(),
      initialData: { guests: [{ name: "A" }, { name: "B" }, { name: "C" }] },
    }),
  );
  const channel = target.querySelector('[data-fillo="announce"]');
  const removeButtons = () => Array.from(target.querySelectorAll(".fillo-group-remove"));

  // Remove the middle instance -> focus lands on the previous card's own
  // tabIndex=-1 wrapper (not a descendant control).
  await act(async () => removeButtons()[1].click());
  let cards = target.querySelectorAll(".fillo-group-instance");
  assert.equal(cards.length, 2, "remove spliced out the target instance");
  assert.equal(
    cards[0].querySelector('[data-field="guests.0.name"] input').value,
    "A",
    "instance 0 (A) is untouched",
  );
  assert.equal(cards[1].querySelector('[data-field="guests.1.name"] input').value, "C", "C shifted down to index 1");
  assert.equal(document.activeElement, cards[0], "focus landed on the previous card wrapper, its tabIndex=-1 root");
  assert.equal(channel.textContent, "Guest removed, 2 remaining");

  // Remove the first instance -> no previous card, focus falls back to Add.
  await act(async () => removeButtons()[0].click());
  cards = target.querySelectorAll(".fillo-group-instance");
  assert.equal(cards.length, 1);
  assert.equal(document.activeElement, target.querySelector(".fillo-group-add"));
  assert.equal(channel.textContent, "Guest removed, 1 remaining");

  // Now at the minInstances=1 floor: Remove disables itself.
  const lastRemove = target.querySelector(".fillo-group-remove");
  assert.equal(lastRemove.disabled, true);
  assert.match(lastRemove.title, /1/);
});

test("repeating group: compound error keys map aria-invalid/aria-describedby onto the exact child input", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm({ maxInstances: 2 }),
      formId: "f-test",
      client: fakeClient(),
      // Seed an already-materialized instance so validateResponse's
      // per-instance/per-child pass actually runs (an untouched
      // data[groupId] reads as zero instances — see the group-level-error
      // test below for that branch).
      initialData: { guests: [{}] },
    }),
  );
  await submitForm(target);

  const nameField = target.querySelector('[data-field="guests.0.name"]');
  const input = nameField.querySelector("input");
  const err = nameField.querySelector('[data-fillo="error"]');
  assert.ok(err, "the child's own error text renders inside ITS field, not the group's");
  assert.equal(err.textContent, "Enter your answer");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.getAttribute("aria-describedby"), err.id);

  // The group's own shell carries no error — the count (1) satisfies
  // minInstances (1); only the child failed. Direct child of the group's
  // OWN field div (not :scope from target — that div isn't target's direct
  // child), so a stray descendant error can't false-positive this check.
  const groupField = target.querySelector('[data-field="guests"]');
  const groupOwnError = Array.from(groupField.children).find((el) => el.getAttribute("data-fillo") === "error");
  assert.equal(groupOwnError, undefined, "no group-level error when the count itself is fine");
});

// KNOWN GAP (discovered writing this suite, core-owned — packages/react is
// out of scope for the fix): core's setValue clears errors[fieldId] by EXACT
// key match (controller.ts ~L852) — a group child's edit always writes
// through the GROUP's own setValue (fieldId = the group's plain id, per
// contract decision 8's read-patch-write), never the compound
// "${groupId}.${index}.${childId}" key validateGroupResponse actually filed
// the error under, so that clear never matches. submit()'s SUCCESS path
// (controller.ts ~L949) doesn't touch `errors` at all — only a FAILING
// revalidation replaces the whole set. RESOLVED at reconciliation: the
// controller's setValue now clears compound "fieldId."-prefixed keys along
// with the exact key, so a group child edit clears its own stale error.
test(
  "repeating group: fixing an invalid child clears its own error live, matching top-level fields",
  async () => {
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: guestsForm({ maxInstances: 2 }),
        formId: "f-test",
        client: fakeClient(),
        initialData: { guests: [{}] },
      }),
    );
    await submitForm(target);
    const nameField = target.querySelector('[data-field="guests.0.name"]');
    const input = nameField.querySelector("input");
    await type(input, "Ada");
    assert.equal(
      !!nameField.querySelector('[data-fillo="error"]'),
      false,
      "child error should clear once answered, the same instant a top-level field's does",
    );
  },
);

test("repeating group: an untouched required group renders its count error in the group's own shell, not per-child", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: guestsForm({ minInstances: 2, maxInstances: 3 }),
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  assert.equal(target.querySelectorAll(".fillo-group-instance").length, 2, "padding still renders 2 cards");

  await submitForm(target);

  const groupField = target.querySelector('[data-field="guests"]');
  const groupError = groupField.querySelector(':scope > [data-fillo="error"]');
  assert.ok(groupError, "the group's own shell carries the count error");
  assert.match(groupError.textContent, /at least 2/i);

  // data[groupId] was never written (padding only), so validateResponse's
  // per-instance loop never ran — no per-child errors fire alongside it.
  const childErrors = target.querySelectorAll(".fillo-group-instance [data-fillo=\"error\"]");
  assert.equal(childErrors.length, 0);
});
