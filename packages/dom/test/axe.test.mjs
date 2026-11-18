import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import axe from "axe-core";

// Verification gate from docs/decisions/input-quality.md ("Verification
// gates" — axe-core sweep) / the F6 gate list in
// docs/decisions/input-quality-audit-2026-07-19.md: every field kind,
// rendered in default/filled/error states, swept with axe-core. Twin of
// packages/react/test/axe.test.mjs — same kitchen-sink form/data, this
// package's renderForm/dispatch/tick idioms.
//
// A full HTML shell (not just "<body>") — unlike this package's other jsdom
// test file. axe's default ruleset includes a few whole-PAGE rules
// (html-has-lang, document-title, landmark-one-main/region) that grade the
// HOST page's chrome, not the embedded form's own markup — a Fillo form is
// meant to be dropped into a host page that already owns that chrome. Rather
// than disable those rules, give the harness a minimal valid shell — lang,
// title, one <main> the form mounts into — so they pass honestly instead of
// firing on an artifact of the test harness.
const dom = new JSDOM(
  '<!DOCTYPE html><html lang="en"><head><title>Fillo axe sweep</title></head><body><main id="axe-root"></main></body></html>',
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Node = dom.window.Node;
globalThis.File = dom.window.File;
globalThis.customElements = dom.window.customElements;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
// Same shims as renderer.test.mjs — the kitchen-sink form below renders
// phone (popover positioning) and signature (canvas), neither of which
// jsdom implements natively.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

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

const { renderForm } = await import("../dist/index.js");

const tick = () => new Promise((r) => setTimeout(r, 0));
const dispatch = (el, type) =>
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const localClient = {
  submit: async () => ({ ok: true, responseId: "r-test" }),
  startSession: async () => null,
  reportProgress: () => {},
  uploadFile: async (_formId, file) => ({
    fileId: `local:${file.name}:${file.size}`,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  }),
};

function mount(form, opts = {}) {
  const target = document.createElement("div");
  document.getElementById("axe-root").appendChild(target);
  renderForm(target, {
    form,
    ...(!opts.formId && !opts.client && !opts.renderOnly
      ? { formId: "f-test", client: localClient }
      : {}),
    ...opts,
  });
  return target;
}

/**
 * One field of every kind (input-quality contract §Verification gates), plus
 * the variants the gate spec calls out explicitly: a prefix+grouped number,
 * a multi_select with both an icon option and "Other", and a toggle-styled
 * checkbox alongside a plain one. Every field is required so a single empty
 * submit surfaces every kind's validation error at once for the "error"
 * state below. Twin of packages/react/test/axe.test.mjs's KITCHEN_SINK_FORM.
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
          id: "guests",
          kind: "repeating_group",
          label: "Guests",
          itemLabel: "Guest",
          minInstances: 1,
          maxInstances: 3,
          fields: [
            { id: "guest_name", kind: "short_text", label: "Guest name", required: true },
            {
              id: "guest_meal",
              kind: "select",
              label: "Meal",
              required: true,
              options: [
                { id: "veg", label: "Vegetarian" },
                { id: "reg", label: "Regular" },
              ],
            },
          ],
        },
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
  guests: [
    { guest_name: "Grace Hopper", guest_meal: "veg" },
    { guest_name: "Alan Turing", guest_meal: "reg" },
  ],
  // "total" is engine-derived from quantity * unit_price — no initialData.
};

/**
 * Known pre-existing defects this sweep once exposed (input-quality
 * gate-building pass, 2026-07-19) — all fixed as part of the carried-forward
 * fix wave (docs/decisions/input-quality.md ledger items #1, #2, #3):
 * aria-required is now scoped to hosts whose role supports it
 * (applyFieldAria() takes a `requiredSupported` opt; multi_select/ranking/
 * matrix's role="group" wrappers pass `false`), the matrix corner cell is a
 * `<td>` instead of an empty `<th>`, and file_upload now has the same
 * activatable role="button" dropzone as @usefillo/react (also passing
 * `requiredSupported: false`) instead of a bare native input. Left empty
 * (not deleted) as the mechanism for any future accepted pre-existing defect
 * — the two now-real regression tests below (former test.todo) cover the
 * first two fixes directly; the dropzone parity fix has its own dedicated
 * coverage in renderer.test.mjs.
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
      // clean") plus the static token assertions in
      // packages/react/test/styles-contract.test.mjs (shared stylesheet).
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
  const target = mount(KITCHEN_SINK_FORM);
  await assertNoAxeViolations(target, "default");
});

test("axe: kitchen-sink form, filled state — zero violations", async () => {
  const target = mount(KITCHEN_SINK_FORM, { initialData: FILLED_DATA });
  await assertNoAxeViolations(target, "filled");
});

test("axe: kitchen-sink form, error state (failed submit) — zero violations", async () => {
  const target = mount(KITCHEN_SINK_FORM);
  dispatch(target.querySelector("form"), "submit");
  await tick();
  // Sanity: confirm the error state actually triggered — otherwise a zero
  // violation count here would prove nothing.
  assert.ok(
    target.querySelector('[aria-invalid="true"]') && target.querySelector('[data-fillo="error"]'),
    "expected the failed submit to render inline validation",
  );
  await assertNoAxeViolations(target, "error");
});

test("axe: kitchen-sink form, challenge-gated (Turnstile) state — zero violations", async () => {
  // A fake global short-circuits the script loader (as the turnstile.test.mjs
  // suite does), so the widget's container stays an empty div — in a real
  // browser Cloudflare fills it with its own accessible iframe, but jsdom
  // never loads that; the empty placeholder is what this sweep can see, and
  // it (plus the slot wrapper) should be clean either way.
  globalThis.turnstile = { render: () => "w1", reset() {}, remove() {} };
  try {
    const target = mount(KITCHEN_SINK_FORM, {
      challenge: { provider: "turnstile", siteKey: "sitekey-test" },
    });
    await tick();
    assert.ok(
      target.querySelector('[data-fillo="turnstile-slot"]'),
      "expected the widget slot to render",
    );
    await assertNoAxeViolations(target, "challenge-gated");
  } finally {
    delete globalThis.turnstile;
  }
});

// ---------- Formerly-known defects, now fixed (ledger #1/#2) — real
// assertions instead of test.todo, so a regression surfaces here directly
// instead of only as a generic "unexpected violation" above. ----------

test("axe: aria-required should not land on role=group (multi_select/ranking/matrix) wrappers", async () => {
  const target = mount(KITCHEN_SINK_FORM);
  const results = await runAxe(target);
  assert.equal(results.violations.filter((v) => v.id === "aria-allowed-attr").length, 0);
});

test("axe: matrix's empty corner <th> should not fire empty-table-header", async () => {
  const target = mount(KITCHEN_SINK_FORM);
  const results = await runAxe(target);
  assert.equal(results.violations.filter((v) => v.id === "empty-table-header").length, 0);
});
