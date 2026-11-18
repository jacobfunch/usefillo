import test from "node:test";
import assert from "node:assert/strict";
import { radioGroupStep } from "../dist/index.js";

// ---------- basic step directions ----------

test("ArrowRight/ArrowDown step forward by 1", () => {
  assert.equal(radioGroupStep("ArrowRight", 2, 5), 3);
  assert.equal(radioGroupStep("ArrowDown", 2, 5), 3);
});

test("ArrowLeft/ArrowUp step backward by 1", () => {
  assert.equal(radioGroupStep("ArrowLeft", 2, 5), 1);
  assert.equal(radioGroupStep("ArrowUp", 2, 5), 1);
});

// ---------- clamping (no wrap) ----------

test("clamps at the end (no wrap) on ArrowRight/ArrowDown", () => {
  assert.equal(radioGroupStep("ArrowRight", 4, 5), 4);
  assert.equal(radioGroupStep("ArrowDown", 4, 5), 4);
});

test("clamps at the start (no wrap) on ArrowLeft/ArrowUp", () => {
  assert.equal(radioGroupStep("ArrowLeft", 0, 5), 0);
  assert.equal(radioGroupStep("ArrowUp", 0, 5), 0);
});

test("clamps safely for out-of-range starting indexes (negative or overflowing)", () => {
  assert.equal(radioGroupStep("ArrowRight", -1, 5), 0);
  assert.equal(radioGroupStep("ArrowLeft", -1, 5), 0);
  assert.equal(radioGroupStep("ArrowRight", 10, 5), 4);
  assert.equal(radioGroupStep("ArrowLeft", 10, 5), 4);
});

// ---------- Home / End ----------

test("Home jumps to 0, End jumps to length-1, regardless of current index", () => {
  assert.equal(radioGroupStep("Home", 3, 7), 0);
  assert.equal(radioGroupStep("End", 3, 7), 6);
  assert.equal(radioGroupStep("Home", 0, 7), 0);
  assert.equal(radioGroupStep("End", 6, 7), 6);
});

// ---------- non-navigation keys ----------

test("returns null for keys that aren't navigation keys", () => {
  for (const key of [" ", "Enter", "Escape", "Tab", "a", "PageUp", "PageDown"]) {
    assert.equal(radioGroupStep(key, 2, 5), null, `expected null for ${key}`);
  }
});

// ---------- length edge cases ----------

test("returns null for a zero or negative length group", () => {
  assert.equal(radioGroupStep("ArrowRight", 0, 0), null);
  assert.equal(radioGroupStep("Home", 0, 0), null);
  assert.equal(radioGroupStep("ArrowRight", 0, -1), null);
});

test("a single-option group clamps to the only index", () => {
  assert.equal(radioGroupStep("ArrowRight", 0, 1), 0);
  assert.equal(radioGroupStep("ArrowLeft", 0, 1), 0);
  assert.equal(radioGroupStep("Home", 0, 1), 0);
  assert.equal(radioGroupStep("End", 0, 1), 0);
});

// ---------- RTL: Left/Right swap, Up/Down never swap ----------

test("rtl swaps ArrowLeft/ArrowRight", () => {
  assert.equal(radioGroupStep("ArrowRight", 2, 5, { rtl: true }), 1);
  assert.equal(radioGroupStep("ArrowLeft", 2, 5, { rtl: true }), 3);
});

test("rtl does NOT swap ArrowUp/ArrowDown", () => {
  assert.equal(radioGroupStep("ArrowDown", 2, 5, { rtl: true }), 3);
  assert.equal(radioGroupStep("ArrowUp", 2, 5, { rtl: true }), 1);
});

test("rtl clamping still applies at the (swapped) extremes", () => {
  // Under rtl, ArrowRight moves toward index 0 — clamp there, not wrap.
  assert.equal(radioGroupStep("ArrowRight", 0, 5, { rtl: true }), 0);
  // ArrowLeft moves toward the end — clamp there.
  assert.equal(radioGroupStep("ArrowLeft", 4, 5, { rtl: true }), 4);
});

test("rtl does not affect Home/End", () => {
  assert.equal(radioGroupStep("Home", 3, 7, { rtl: true }), 0);
  assert.equal(radioGroupStep("End", 3, 7, { rtl: true }), 6);
});

test("rtl: false behaves identically to omitting opts", () => {
  assert.equal(radioGroupStep("ArrowRight", 2, 5, { rtl: false }), radioGroupStep("ArrowRight", 2, 5));
  assert.equal(radioGroupStep("ArrowLeft", 2, 5, { rtl: false }), radioGroupStep("ArrowLeft", 2, 5));
});
