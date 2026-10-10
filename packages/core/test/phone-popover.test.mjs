import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// positionPhonePopover (phone.ts, "Country-picker popover positioning") is
// pure DOM math with no framework state: it reads the anchor/popover
// elements it's given and writes CSS custom properties back, so react/dom
// share one implementation instead of drifting copies. Exercised here with a
// minimal jsdom fixture (react/dom's own suites additionally cover it wired
// to their real trigger/popover markup) so the ltr/rtl overflow correction
// — ledger #5, docs/decisions/input-quality.md: the CSS anchor is
// `inset-inline-start` (direction-aware) but the JS nudge read only
// `rect.left` (not) — gets a direct, fast unit test independent of either
// renderer.
const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

const { positionPhonePopover, PHONE_POPOVER_VIEWPORT_GAP } = await import("../dist/index.js");

function setViewport(width, height) {
  Object.defineProperty(dom.window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: height, configurable: true });
}

/** A real (jsdom) element with just the geometry positionPhonePopover reads
 *  overridden — getBoundingClientRect() and, for direction, inline style
 *  (which getComputedStyle reflects even in jsdom's limited CSS engine). */
function fakeAnchor(rect, direction = "ltr") {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => rect;
  el.style.direction = direction;
  document.body.appendChild(el);
  return el;
}

function fakePopover({ offsetWidth, scrollHeight }) {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { value: offsetWidth, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  document.body.appendChild(el);
  return el;
}

function offsetX(popover) {
  return Number.parseFloat(popover.style.getPropertyValue("--fillo-phone-popover-offset-x"));
}

test("positionPhonePopover returns \"below\" and touches no styles for a null anchor/popover (SSR/detached)", () => {
  assert.equal(positionPhonePopover(null, null), "below");
});

test("ltr: an anchor flush with the left edge needs no nudge", () => {
  setViewport(400, 600);
  const anchor = fakeAnchor({ left: 10, right: 50, top: 10, bottom: 30, width: 40, height: 20 }, "ltr");
  const popover = fakePopover({ offsetWidth: 200, scrollHeight: 100 });
  positionPhonePopover(anchor, popover);
  assert.equal(offsetX(popover), 0);
});

test("ltr: an anchor near the right edge nudges the popover left to stay on screen", () => {
  setViewport(400, 600);
  const anchor = fakeAnchor({ left: 350, right: 390, top: 10, bottom: 30, width: 40, height: 20 }, "ltr");
  const popover = fakePopover({ offsetWidth: 200, scrollHeight: 100 });
  positionPhonePopover(anchor, popover);
  assert.equal(offsetX(popover), -158);
});

test("rtl: an anchor flush with the right edge needs no nudge (the rtl mirror of the ltr left-edge case)", () => {
  setViewport(400, 600);
  const anchor = fakeAnchor({ left: 350, right: 390, top: 10, bottom: 30, width: 40, height: 20 }, "rtl");
  const popover = fakePopover({ offsetWidth: 200, scrollHeight: 100 });
  positionPhonePopover(anchor, popover);
  assert.equal(offsetX(popover), 0);
});

test("rtl: an anchor near the left edge nudges the popover right to stay on screen (ledger #5 — the ltr-biased math left this at 0, rendering the popover mostly off-screen)", () => {
  setViewport(400, 600);
  const anchor = fakeAnchor({ left: 10, right: 50, top: 10, bottom: 30, width: 40, height: 20 }, "rtl");
  const popover = fakePopover({ offsetWidth: 200, scrollHeight: 100 });
  positionPhonePopover(anchor, popover);
  // Mirror image of the ltr-near-right-edge case above: same magnitude,
  // opposite sign (nudged right, not left).
  assert.equal(offsetX(popover), 158);
});

test("rtl vs ltr: the identical anchor rect nudges in mirrored directions", () => {
  setViewport(400, 600);
  const rect = { left: 10, right: 50, top: 10, bottom: 30, width: 40, height: 20 };
  const ltrAnchor = fakeAnchor(rect, "ltr");
  const ltrPopover = fakePopover({ offsetWidth: 200, scrollHeight: 100 });
  positionPhonePopover(ltrAnchor, ltrPopover);

  const rtlAnchor = fakeAnchor(rect, "rtl");
  const rtlPopover = fakePopover({ offsetWidth: 200, scrollHeight: 100 });
  positionPhonePopover(rtlAnchor, rtlPopover);

  assert.equal(offsetX(ltrPopover), 0, "ltr: safely inside from the left edge, no nudge");
  assert.equal(offsetX(rtlPopover), 158, "rtl: the SAME rect overflows the left edge once mirrored, nudged right");
});

test("placement flips above when there isn't room below but there is above", () => {
  setViewport(400, 200);
  // top=150 leaves 50px above (minus gap); bottom=160 leaves 40px below
  // (minus gap) in a 200px-tall viewport — above has more room, and the
  // popover (scrollHeight 100) doesn't fit below either way.
  const anchor = fakeAnchor({ left: 10, right: 50, top: 150, bottom: 160, width: 40, height: 10 });
  const popover = fakePopover({ offsetWidth: 100, scrollHeight: 100 });
  const placement = positionPhonePopover(anchor, popover);
  assert.equal(placement, "above");
});
