/**
 * Pure keyboard-navigation math for a roving-tabindex radiogroup (choice
 * radios, rating, linear_scale, matrix rows) — shared by both renderers so
 * the arrow/Home/End handling isn't duplicated and can't drift (audit
 * P2.3: today's `radiogroupKeyDown`/`bindRadioKeys` copies wrap at the
 * extremes, have no Home/End, and are RTL-blind).
 *
 * No DOM/framework dependency: given the pressed key, the currently active
 * index, and the option count, this returns the new index to select and
 * focus, or `null` when `key` isn't a navigation key (the caller falls
 * through to its own handling, e.g. Space/Enter selection).
 *
 * `index` is expected in range (`0`..`length-1`, e.g. from a roving-tabindex
 * helper that already normalizes "nothing selected" to `0` — matching both
 * renderers' existing `rovingIndex`). Out-of-range input is still handled
 * safely: the result is clamped to `[0, length-1]` the same as any other
 * step, with no special-casing for negative or overflowing starting indexes.
 */
export function radioGroupStep(
  key: string,
  index: number,
  length: number,
  opts?: { rtl?: boolean },
): number | null {
  if (length <= 0) return null;
  const rtl = opts?.rtl ?? false;

  if (key === "Home") return 0;
  if (key === "End") return length - 1;

  let delta: number;
  switch (key) {
    case "ArrowRight":
      delta = rtl ? -1 : 1;
      break;
    case "ArrowLeft":
      delta = rtl ? 1 : -1;
      break;
    case "ArrowDown":
      delta = 1;
      break;
    case "ArrowUp":
      delta = -1;
      break;
    default:
      return null;
  }

  // Clamp, never wrap: the contract treats hitting an end as meaningful
  // (e.g. a 1-5 rating shouldn't cycle from 5 back to 1 on ArrowRight).
  const next = index + delta;
  return Math.min(length - 1, Math.max(0, next));
}
