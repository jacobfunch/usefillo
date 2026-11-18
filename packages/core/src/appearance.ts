import type { BlockKind } from "./types.js";
import type { FormStatus } from "./controller.js";
import { normalizeFormTheme } from "./schema-validation.js";
import type { FormTheme } from "./types.js";

/**
 * The styling contract, shared by every renderer: named slots a consumer can
 * attach classes to, and data-* attributes that expose state so utility CSS
 * (Tailwind `data-[invalid]:…`) can react to it. Slot names and attribute
 * names are public API — renames are breaking; additions are minors.
 */

export const FILLO_SLOTS = [
  "root",
  "header",
  "title",
  "description",
  "pageTitle",
  "progress",
  "progressFill",
  "blocks",
  "field",
  "label",
  "fieldDescription",
  "control",
  "options",
  "option",
  "optionLabel",
  "error",
  "footer",
  "button",
  "success",
  "resume",
  "turnstile",
  "calculated",
] as const;

export type FilloSlot = (typeof FILLO_SLOTS)[number];

/** data-* names emitted alongside the stable fillo-* classes. */
export const FILLO_DATA_ATTRS = {
  /** Slot name, on every slot element: `data-fillo="control"`. */
  slot: "data-fillo",
  /** Field kind, on the field wrapper: `data-kind="email"`. */
  kind: "data-kind",
  /** Field id, on the field wrapper (pre-existing). */
  field: "data-field",
  invalid: "data-invalid",
  required: "data-required",
  /** Option id, on each choice row (pre-existing selector hook). */
  option: "data-option",
  /** Selected option row / active scale step / active star. */
  selected: "data-selected",
  /** Checkbox / toggle checked state. */
  checked: "data-checked",
  dragOver: "data-drag-over",
  /** Engine status on the root: idle | submitting | submitted | error. */
  state: "data-state",
  page: "data-page",
  lastPage: "data-last-page",
} as const;

/** State handed to `classNames` functions so classes can vary by it. */
export interface SlotState {
  slot: FilloSlot;
  kind?: BlockKind;
  fieldId?: string;
  optionId?: string;
  invalid?: boolean;
  required?: boolean;
  selected?: boolean;
  checked?: boolean;
  dragOver?: boolean;
  status?: FormStatus;
  /** "primary" | "ghost" on the button slot. */
  variant?: string;
}

export type SlotClass = string | ((state: SlotState) => string);

export interface FilloAppearance {
  /** Highest-precedence theme tokens (over prop/code/dashboard themes). */
  theme?: FormTheme;
  /** Class strings appended after the built-in fillo-* class, per slot. */
  classNames?: Partial<Record<FilloSlot, SlotClass>>;
  /** Per-field overrides, keyed by field id — appended after the slot class. */
  fields?: Record<string, Partial<Record<FilloSlot, SlotClass>>>;
}

/**
 * Resolve the consumer classes for a slot: general slot class first, then the
 * per-field override. Returns "" when nothing applies. The badge is
 * deliberately not a slot — appearance can never reach it.
 */
export function resolveSlotClass(
  appearance: FilloAppearance | undefined,
  state: SlotState,
): string {
  if (!appearance?.classNames && !appearance?.fields) return "";
  const parts: string[] = [];
  const general = appearance.classNames?.[state.slot];
  if (general) parts.push(typeof general === "function" ? general(state) : general);
  const field = state.fieldId ? appearance.fields?.[state.fieldId]?.[state.slot] : undefined;
  if (field) parts.push(typeof field === "function" ? field(state) : field);
  return parts.filter(Boolean).join(" ");
}

/** Append resolved consumer classes to a base fillo-* class string. */
export function slotClass(
  base: string,
  appearance: FilloAppearance | undefined,
  state: SlotState,
): string {
  const extra = resolveSlotClass(appearance, state);
  return extra ? `${base} ${extra}` : base;
}

/** The CSS custom properties the default theme runs on. `themeProp` names the
 * FormTheme key that sets a token (inline, synced to the hosted page); tokens
 * without one are stylesheet-only and overridable from consumer CSS. */
export const FILLO_THEME_VARS = [
  { var: "--fillo-primary", themeProp: "primary" },
  { var: "--fillo-bg", themeProp: "background" },
  { var: "--fillo-text", themeProp: "text" },
  { var: "--fillo-radius", themeProp: "radius" },
  { var: "--fillo-font", themeProp: "fontFamily" },
  { var: "--fillo-muted" },
  { var: "--fillo-border" },
  { var: "--fillo-control-border" },
  { var: "--fillo-control-bg" },
  { var: "--fillo-error" },
  { var: "--fillo-primary-contrast" },
] as const;

// ---------- Dark-scheme inference (contract: "Dark is a supported first-class path") ----------

/** Luminance where contrast-against-white equals contrast-against-black —
 *  the standard balanced cutoff for picking a light or dark UI scheme from
 *  one background color. */
const DARK_LUMINANCE_THRESHOLD = Math.sqrt(1.05 * 0.05) - 0.05;

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

function srgbToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 black .. 1 white) of a #rgb/#rrggbb color, or
 *  null for anything else this can't parse (named colors, rgb()/hsl(), CSS
 *  variables, …) — left alone with no inference. */
function relativeLuminance(token: string): number | null {
  const trimmed = token.trim();
  let hex: string | null = null;
  const six = HEX6.exec(trimmed);
  if (six) {
    hex = `${six[1]}${six[2]}${six[3]}`;
  } else {
    const three = HEX3.exec(trimmed);
    if (three) hex = `${three[1]}${three[1]}${three[2]}${three[2]}${three[3]}${three[3]}`;
  }
  if (!hex) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * Infer `colorScheme` for a `FormTheme` with a fixed hex `background` and no
 * fixed light/dark scheme. A fixed background cannot safely keep following
 * the visitor's OS: a light-only host viewed on a dark OS otherwise gets dark
 * controls on a white form (and the reverse for dark backgrounds).
 *
 * Explicit `light`/`dark` always wins. An absent scheme or `auto` is resolved
 * from the background's WCAG relative luminance, even when `text` is omitted,
 * so the remaining muted/border/control/error/contrast tokens stay readable.
 * A missing or non-`#rgb`/`#rrggbb` background passes through unchanged.
 *
 * Returns a `FormTheme`, not just the scheme, so a renderer can drop this
 * in ahead of its existing code with no other change:
 * `const safeTheme = resolveThemeAppearance(normalizeFormTheme(theme));`
 * then read `.colorScheme`/`.primary`/… exactly as today — inferred and
 * explicit schemes cascade through the same shipped
 * `[data-fillo-color-scheme="dark"]` CSS, so no new CSS is needed.
 */
export function resolveThemeAppearance(theme: FormTheme | null): FormTheme | null {
  if (
    !theme ||
    theme.colorScheme === "light" ||
    theme.colorScheme === "dark" ||
    !theme.background ||
    // A form with dark colors of its own follows the light/dark setting.
    themeHasDarkPalette(theme)
  ) {
    return theme;
  }
  const luminance = relativeLuminance(theme.background);
  if (luminance == null) return theme;
  return { ...theme, colorScheme: luminance > DARK_LUMINANCE_THRESHOLD ? "light" : "dark" };
}

/**
 * True when the theme switches palettes with the light/dark setting: it has
 * dark colors and its scheme is not fixed (omitted or "auto"). A dark logo
 * alone switches nothing.
 */
export function themeHasDarkPalette(theme: FormTheme | null | undefined): boolean {
  if (!theme || theme.colorScheme === "light" || theme.colorScheme === "dark") return false;
  const dark = theme.dark;
  return Boolean(dark && (dark.primary || dark.background || dark.text));
}

// ---------- Theme → DOM (shared by every renderer) ----------

/** Near-black button text (white is the other tone). */
const ON_LIGHT_TEXT = "#18181b";

/**
 * The button-text tone that reads on a #rgb/#rrggbb color: "light" (white
 * text) or "dark" (near-black text), whichever has the higher WCAG contrast.
 * Null when the color can't be parsed.
 */
function onColorTone(color: string): "light" | "dark" | null {
  const luminance = relativeLuminance(color);
  if (luminance == null) return null;
  const withWhite = 1.05 / (luminance + 0.05);
  const withDark = (luminance + 0.05) / ((relativeLuminance(ON_LIGHT_TEXT) ?? 0) + 0.05);
  return withWhite >= withDark ? "light" : "dark";
}

const PALETTE_VARS = [
  ["primary", "--fillo-primary"],
  ["background", "--fillo-bg"],
  ["text", "--fillo-text"],
] as const;

/** The stylesheet's own tokens, for the half of a light-dark() pair a theme
 *  leaves unset. */
const DEFAULT_PALETTE = {
  light: { primary: "#18181b", background: "transparent", text: "#18181b" },
  dark: { primary: "#fafafa", background: "transparent", text: "#f4f4f5" },
} as const;

export interface ThemeDomAttributes {
  /** Inline custom properties for the form root (`--fillo-primary`, …). */
  vars: Record<string, string>;
  /** `data-fillo-*` attributes for the form root. */
  attrs: Record<string, string>;
}

/**
 * Turn an untrusted theme into the form root's inline custom properties and
 * data attributes — one implementation for every renderer.
 *
 * A theme with a dark palette (see themeHasDarkPalette) emits each color as
 * `light-dark(light, dark)`, so it follows the form's own color-scheme: the
 * host page's when `colorScheme` is omitted, the visitor's device on "auto".
 * `data-fillo-on-primary` (and `-dark`) name the text tone that reads on a
 * custom accent; the stylesheet maps them to `--fillo-primary-contrast`, which
 * stays overridable from consumer CSS.
 */
export function resolveThemeDom(theme: FormTheme | null | undefined): ThemeDomAttributes | null {
  const safe = resolveThemeAppearance(normalizeFormTheme(theme));
  if (!safe) return null;
  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  if (safe.colorScheme) attrs["data-fillo-color-scheme"] = safe.colorScheme;

  const dark = themeHasDarkPalette(safe) ? safe.dark : undefined;
  for (const [key, name] of PALETTE_VARS) {
    const light = safe[key];
    if (!dark) {
      if (light) vars[name] = light;
      continue;
    }
    const darkValue = dark[key];
    if (!light && !darkValue) continue;
    vars[name] =
      `light-dark(${light ?? DEFAULT_PALETTE.light[key]}, ${darkValue ?? DEFAULT_PALETTE.dark[key]})`;
  }
  if (safe.radius) vars["--fillo-radius"] = safe.radius;
  if (safe.fontFamily) vars["--fillo-font"] = safe.fontFamily;

  if (dark) {
    const lightTone = onColorTone(safe.primary ?? DEFAULT_PALETTE.light.primary);
    const darkTone = onColorTone(dark.primary ?? DEFAULT_PALETTE.dark.primary);
    if (lightTone && darkTone) {
      attrs["data-fillo-on-primary"] = lightTone;
      attrs["data-fillo-on-primary-dark"] = darkTone;
    }
  } else if (safe.primary) {
    const tone = onColorTone(safe.primary);
    if (tone) attrs["data-fillo-on-primary"] = tone;
  }

  if (safe.primary || safe.background || safe.text || dark) {
    attrs["data-fillo-has-color-theme"] = "";
  }
  return { vars, attrs };
}
