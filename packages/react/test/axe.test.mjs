import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import axe from "axe-core";

// Verification gate from docs/decisions/input-quality.md ("Verification
// gates" — axe-core sweep) / the F6 gate list in
// docs/decisions/input-quality-audit-2026-07-19.md: every field kind,
// rendered in default/filled/error states, swept with axe-core.
//
// A full HTML shell (not just "<body>") — unlike this package's other jsdom
// test files. axe's default ruleset includes a few whole-PAGE rules
// (html-has-lang, document-title, landmark-one-main/region) that grade the
// HOST page's chrome, not the embedded form's own markup — a Fillo form is
// meant to be dropped into a host page that already owns that chrome (see
// the --fillo-bg:transparent decision in the contract). Rather than disable
// those rules, give the harness a minimal valid shell — lang, title, one
// <main> the form mounts into — so they pass honestly instead of firing on
// an artifact of the test harness.
const dom = new JSDOM(
  '<!DOCTYPE html><html lang="en"><head><title>Fillo axe sweep</title></head><body><main id="axe-root"></main></body></html>',
);
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

// Same shims as composites.test.mjs — the kitchen-sink form below renders
// phone (popover positioning), rating/scale (RTL probe via getComputedStyle)
// and signature (canvas), none of which jsdom implements natively.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.getComputedStyle = (...args) => dom.window.getComputedStyle(...args);
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
  document.getElementById("axe-root").appendChild(target);
  const root = createRoot(target);
  await act(async () => root.render(element));
  return { target, root };
}

/**
 * One field of every kind (input-quality contract §Verification gates), plus
 * the variants the gate spec calls out explicitly: a prefix+grouped number,
 * a multi_select with both an icon option and "Other", and a toggle-styled
 * checkbox alongside a plain one. Every field is required so a single empty
 * submit surfaces every kind's validation error at once for the "error"
 * state below.
 */
const KITCHEN_SINK_FORM = {
  version: 1,
  title: "Kitchen sink",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "full_name", kind: "short_text", label: "Full name", required: true },
        {
          id: "bio",
          kind: "long_text",
          label: "Tell us about yourself",
          description: "A couple of sentences is plenty.",
          required: true,
        },
        { id: "email", kind: "email", label: "Email", required: true },
        { id: "website", kind: "url", label: "Website", required: true },
        { id: "phone", kind: "phone", label: "Phone", defaultCountry: "US", required: true },
        { id: "quantity", kind: "number", label: "Quantity", required: true },
        {
          id: "unit_price",
          kind: "number",
          label: "Unit price",
          required: true,
          prefix: "$",
          notation: "grouped",
          decimals: 2,
        },
        {
          id: "plan",
          kind: "select",
          label: "Plan",
          required: true,
          options: [
            { id: "basic", label: "Basic" },
            { id: "pro", label: "Pro" },
          ],
        },
        {
          id: "feedback_topics",
          kind: "multi_select",
          label: "What did you like?",
          required: true,
          allowOther: true,
          options: [
            { id: "support", label: "Support", icon: "thumbs_up" },
            { id: "pricing", label: "Pricing" },
          ],
        },
        {
          id: "country",
          kind: "dropdown",
          label: "Country",
          required: true,
          options: [
            { id: "us", label: "United States" },
            { id: "dk", label: "Denmark" },
          ],
        },
        { id: "agree", kind: "checkbox", label: "I agree to the terms", required: true },
        {
          id: "newsletter",
          kind: "checkbox",
          label: "Subscribe to updates",
          required: true,
          appearance: "toggle",
        },
        {
          id: "satisfaction",
          kind: "rating",
          label: "How satisfied are you?",
          required: true,
          max: 5,
        },
        {
          id: "nps",
          kind: "linear_scale",
          label: "How likely are you to recommend us?",
          required: true,
          min: 0,
          max: 10,
          minLabel: "Not at all likely",
          maxLabel: "Extremely likely",
        },
        {
          id: "priorities",
          kind: "ranking",
          label: "Rank these priorities",
          required: true,
          options: [
            { id: "speed", label: "Speed" },
            { id: "cost", label: "Cost" },
            { id: "quality", label: "Quality" },
          ],
        },
        {
          id: "grid",
          kind: "matrix",
          label: "Rate each feature",
          required: true,
          rows: [
            { id: "r1", label: "Speed" },
            { id: "r2", label: "Support" },
          ],
          columns: [
            { id: "c1", label: "Poor" },
            { id: "c2", label: "Fair" },
            { id: "c3", label: "Good" },
          ],
        },
        { id: "signature", kind: "signature", label: "Sign here", required: true },
        { id: "start_date", kind: "date", label: "Start date", required: true },
        { id: "attachment", kind: "file_upload", label: "Attachment", required: true, maxFiles: 1 },
        { id: "campaign", kind: "hidden", label: "Campaign", defaultValue: "spring-2026" },
        {
          id: "total",
          kind: "calculated",
          label: "Total",
          calc: {
            op: "mul",
            args: [
              { op: "value", fieldId: "quantity" },
              { op: "value", fieldId: "unit_price" },
            ],
          },
          decimals: 2,
          prefix: "$",
        },
        {
          id: "guests",
          kind: "repeating_group",
          label: "Guests",
          itemLabel: "Guest",
          minInstances: 1,
          maxInstances: 3,
          // One text child and one radiogroup child (a DIFFERENT DOM shape
          // than the dropdown used elsewhere in this suite's own repeating-
          // group tests) so the sweep covers a composite widget nested
          // inside an instance card, not just a plain input.
          fields: [
            { id: "guest_name", kind: "short_text", label: "Guest name", required: true },
            {
              id: "guest_meal",
              kind: "select",
              label: "Meal preference",
              required: true,
              options: [
                { id: "veg", label: "Vegetarian" },
                { id: "meat", label: "Meat" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const FILLED_DATA = {
  full_name: "Ada Lovelace",
  bio: "I build accessible forms and love clean APIs.",
  email: "ada@example.com",
  website: "https://example.com",
  phone: "+4532123456",
  quantity: 4,
  unit_price: 19.99,
  plan: "pro",
  // "support" is the icon option; the second entry is free text — exercises
  // both the icon-selected check marker AND the "Other" input in one pass.
  feedback_topics: ["support", "Great onboarding!"],
  country: "dk",
  agree: true,
  newsletter: true,
  satisfaction: 4,
  nps: 9,
  priorities: ["cost", "speed", "quality"],
  grid: { r1: "c3", r2: "c2" },
  signature: "data:image/png;base64,AAAA",
  start_date: "2026-07-19",
  attachment: [{ fileId: "file_1", name: "resume.pdf", size: 2048, mime: "application/pdf" }],
  campaign: "spring-2026",
  // "total" is engine-derived from quantity * unit_price — no initialData.
  // Two instances (of a 3-max group): exercises multiple instance cards,
  // Add not-yet-disabled, and Remove enabled (count above the floor) in the
  // same pass as every other field's filled state.
  guests: [
    { guest_name: "Grace Hopper", guest_meal: "veg" },
    { guest_name: "Alan Turing", guest_meal: "meat" },
  ],
};

/**
 * Known pre-existing defects this sweep once exposed (input-quality
 * gate-building pass, 2026-07-19) — both fixed as part of the carried-forward
 * fix wave (docs/decisions/input-quality.md ledger items #1 and #2):
 * aria-required is now scoped to hosts whose role supports it (fieldAria()
 * takes a `required` opt; multi_select/ranking/matrix's role="group"
 * wrappers and the file_upload dropzone's role="button" pass `false`), and
 * the matrix corner cell is a `<td>` instead of an empty `<th>`. Left empty
 * (not deleted) as the mechanism for any future accepted pre-existing defect
 * — the two now-real regression tests below (former test.todo) cover both
 * fixes directly.
 */
const KNOWN_PREEXISTING_VIOLATIONS = new Set();

function formatViolations(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .map((n) => `    - ${n.target.join(" ")}\n      ${n.failureSummary ?? ""}`)
        .join("\n");
      return `${v.id} [${v.impact}] ${v.help}\n${nodes}`;
    })
    .join("\n\n");
}

async function runAxe(container) {
  return axe.run(container, {
    rules: {
      // jsdom has no layout/paint engine — no real font metrics, no
      // compositing, nothing to sample rendered pixels from. axe's
      // color-contrast rule needs actual rendered color values, so a "pass"
      // or "fail" here would be equally meaningless. Contrast is verified
      // instead by the audit's computed relative-luminance math
      // (docs/decisions/input-quality-audit-2026-07-19.md, "Verified
      // clean") plus the static token assertions in styles-contract.test.mjs.
      "color-contrast": { enabled: false },
    },
  });
}

async function assertNoAxeViolations(container, label) {
  const results = await runAxe(container);
  const unexpected = results.violations.filter((v) => !KNOWN_PREEXISTING_VIOLATIONS.has(v.id));
  assert.equal(
    unexpected.length,
    0,
    `axe found ${unexpected.length} unexpected violation(s) in the "${label}" state:\n\n${formatViolations(unexpected)}`,
  );
}

test("axe: kitchen-sink form, default (unanswered) state — zero violations", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: KITCHEN_SINK_FORM,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  await assertNoAxeViolations(target, "default");
});

test("axe: kitchen-sink form, filled state — zero violations", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: KITCHEN_SINK_FORM,
      formId: "f-test",
      client: fakeClient(),
      initialData: FILLED_DATA,
    }),
  );
  await assertNoAxeViolations(target, "filled");
});

test("axe: kitchen-sink form, error state (failed submit) — zero violations", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: KITCHEN_SINK_FORM,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  // Sanity: confirm the error state actually triggered — otherwise a zero
  // violation count here would prove nothing.
  assert.ok(
    target.querySelector('[aria-invalid="true"]') && target.querySelector('[data-fillo="error"]'),
    "expected the failed submit to render inline validation",
  );
  await assertNoAxeViolations(target, "error");
});

// ---------- Formerly-known defects, now fixed (ledger #1/#2) — real
// assertions instead of test.todo, so a regression surfaces here directly
// instead of only as a generic "unexpected violation" above. ----------

test("axe: aria-required should not land on role=group (multi_select/ranking/matrix) or role=button (file_upload dropzone) wrappers", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: KITCHEN_SINK_FORM,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const results = await runAxe(target);
  assert.equal(results.violations.filter((v) => v.id === "aria-allowed-attr").length, 0);
});

test("axe: matrix's empty corner <th> should not fire empty-table-header", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: KITCHEN_SINK_FORM,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const results = await runAxe(target);
  assert.equal(results.violations.filter((v) => v.id === "empty-table-header").length, 0);
});
