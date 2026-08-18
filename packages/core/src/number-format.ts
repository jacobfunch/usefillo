/**
 * Grouped-number display + parsing for the Number field's `notation` input
 * — browser-locale detection (`"grouped"`) or an author-fixed style
 * (`"grouped-comma"` = `1,234.56`, `"grouped-dot"` = `1.234,56`); design
 * contract: docs/decisions/number-formatting.md. All helpers are pure,
 * side-effect-free, and DOM-free, so the same code runs in @usefillo/react,
 * @usefillo/dom, and Node. All are strictly display-only — grouping never
 * touches validation, canonical storage, or the wire (contract decision 2)
 * — and all degrade to canonical text instead of throwing when `Intl` is
 * unavailable.
 */

/** Clamp a `decimals` option to the field's supported 0–6 range. Mirrors
 *  calc.ts's clampDecimals; kept local so this module has no cross-import. */
function clampDecimals(decimals: number): number {
  return Math.max(0, Math.min(6, Math.round(decimals)));
}

/**
 * The `Intl` locale a `notation` value pins the separators to — the single
 * source of the notation→locale map, consumed by BOTH renderers (never
 * duplicate it). Notation values are named by the GROUP separator:
 * - `"grouped"` (and unset): `undefined` — detect from the respondent's
 *   browser locale, exactly the pre-fixed-style behavior;
 * - `"grouped-comma"`: `"en-US"` — comma groups, dot decimal, `1,234.56`;
 * - `"grouped-dot"`: `"de-DE"` — dot groups, comma decimal, `1.234,56`.
 */
export function localeForNotation(
  notation?: "grouped" | "grouped-comma" | "grouped-dot",
): string | undefined {
  switch (notation) {
    case "grouped-comma":
      return "en-US";
    case "grouped-dot":
      return "de-DE";
    case "grouped":
    case undefined:
      return undefined;
  }
}

/**
 * Locale-grouped display text for a finite number — the blurred value of a
 * `notation: "grouped"` number input. `maximumFractionDigits` is set
 * explicitly to 20 when `decimals` is unset: Intl's own silent default (3)
 * would truncate/round a longer fraction on display, silently disagreeing
 * with the stored value. When `decimals` is set it pins both the minimum and
 * maximum fraction digits — padding to a stable width, the same contract
 * `formatAnswer`'s toFixed follows. Non-finite input and a missing `Intl`
 * both fall back to canonical text; this must never throw mid-keystroke.
 */
export function formatGroupedNumber(
  value: number,
  opts?: { locale?: string; decimals?: number },
): string {
  if (!Number.isFinite(value)) return String(value);
  const decimals = opts?.decimals === undefined ? undefined : clampDecimals(opts.decimals);
  if (typeof Intl === "undefined") {
    return decimals === undefined ? String(value) : value.toFixed(decimals);
  }
  const format: Intl.NumberFormatOptions = { useGrouping: true };
  if (decimals === undefined) {
    format.maximumFractionDigits = 20;
  } else {
    format.minimumFractionDigits = decimals;
    format.maximumFractionDigits = decimals;
  }
  return new Intl.NumberFormat(opts?.locale, format).format(value);
}

/** Remove every occurrence of a literal (non-regex) separator. A "" input is
 *  left untouched — `"".split("")` would otherwise be a no-op the slow way. */
function stripAll(text: string, separator: string): string {
  return separator ? text.split(separator).join("") : text;
}

/** Map a locale decimal mark to the canonical ".". A no-op when it already
 *  is "." — which also covers the always-accepted "." fallback below. */
function toCanonicalDecimal(text: string, decimal: string): string {
  return decimal === "." ? text : text.split(decimal).join(".");
}

/**
 * Resolve a body whose `group` separator may be EITHER genuine grouping or a
 * decimal mark in the respondent's own habit — the two cases where those
 * roles collide, applied symmetrically:
 * - "." groups (de-DE and kin): "." is ALSO the always-accepted decimal;
 * - "," groups (en-US and kin): a comma-decimal respondent types "12,5"
 *   meaning 12.5 — stripping the comma as grouping would silently read 125.
 * `decimal` is the locale's real decimal mark ("," under de-DE, "." under
 * en-US).
 *
 * If that real decimal mark is present, it wins outright: everything before
 * it is grouping (every `group` there is stripped) and everything after is
 * the fraction. Otherwise the `group` runs are checked structurally —
 * genuine grouping is chunks of exactly 3 digits with a 1–3 digit leading
 * chunk NOT starting with 0 (grouped output never emits a zero-led head, so
 * "0,123" / de-DE "0.123" is unambiguously a decimal — not a 1000×-corrupted
 * 123); anything that doesn't fit means the LAST `group` is a decimal
 * point, not a group separator (so a bare "1234.5" still parses under
 * de-DE, and "12,5" reads as 12.5 — not 125 — under en-US).
 */
function resolveAmbiguousGrouping(body: string, group: string, decimal: string): string {
  if (decimal !== group && body.includes(decimal)) {
    const i = body.lastIndexOf(decimal);
    const intPart = stripAll(body.slice(0, i), group);
    const fracPart = body.slice(i + decimal.length);
    return `${intPart}.${fracPart}`;
  }
  const segments = body.split(group);
  if (segments.length === 1) return body;
  const isPureGrouping = segments.every((seg, i) =>
    i === 0 ? /^[1-9]\d{0,2}$/.test(seg) : /^\d{3}$/.test(seg),
  );
  if (isPureGrouping) return segments.join("");
  return `${segments.slice(0, -1).join("")}.${segments.at(-1) ?? ""}`;
}

/**
 * Canonical text (what `Number()` can parse) for a grouped-number input's raw
 * typed text — this is what `setValue` receives on every keystroke (contract
 * decision 2: the input holds grouped text only while unfocused; `data`
 * always holds canonical numerics). Returns the INPUT UNCHANGED when it can't
 * produce a parseable result — validation flags it from there, same as an
 * unformatted number field today.
 *
 * Derives the locale's group/decimal marks via
 * `Intl.NumberFormat(locale).formatToParts(1234567.8)`, then:
 * - strips group separators — several locales (fr-FR among them) use
 *   U+00A0/U+202F no-break spaces, so any whitespace-class character is
 *   accepted as a group separator whenever the locale's own is whitespace;
 * - maps the locale decimal mark to ".";
 * - ALWAYS also accepts "." as a decimal mark regardless of locale — see
 *   {@link resolveAmbiguousGrouping} for the locale families where a "." or
 *   "," group separator collides with a decimal reading (a "," group run
 *   that isn't exact 3-digit chunking reads as a decimal, so "12,5" under a
 *   comma-grouping locale is 12.5, never a silently-stripped 125);
 * - preserves a leading minus;
 * - preserves partial typing states ("1234." stays "1234." — `Number()` can
 *   still parse it, and rewriting mid-keystroke fights the respondent).
 *
 * Empty/whitespace input and a missing `Intl` both return the input as-is.
 */
export function parseGroupedNumber(text: string, locale?: string): string {
  if (typeof Intl === "undefined") return text;
  if (text.trim() === "") return text;

  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.8);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";

  let body = text.trim();
  const negative = body.startsWith("-");
  if (negative) body = body.slice(1);

  if (/^\s$/.test(group)) {
    body = toCanonicalDecimal(body.replace(/\s/g, ""), decimal);
  } else if (group === "." || group === ",") {
    body = resolveAmbiguousGrouping(body, group, decimal);
  } else {
    body = toCanonicalDecimal(stripAll(body, group), decimal);
  }

  if (body === "" || body === "." || !/^\d*\.?\d*$/.test(body)) return text;
  return negative ? `-${body}` : body;
}

/**
 * Keystroke-level filter for a formatted number input's raw typed text (the
 * input-quality contract's "optional future: React Aria-style
 * `isValidPartialNumber` keystroke filter", `docs/decisions/input-quality.md`).
 * Permissive on separator PLACEMENT — {@link parseGroupedNumber} and server
 * validation own semantics — this only blocks characters or counts that can
 * never resolve to a number: letters and other symbols, a non-leading "-",
 * or more than one decimal mark.
 *
 * Reuses {@link parseGroupedNumber}'s locale-mark derivation
 * (`Intl.NumberFormat(locale).formatToParts`) and its two special cases: a
 * whitespace-class group separator accepts ANY whitespace character, and
 * where "." is itself the locale's group separator (the de-DE family), "."
 * is unlimited and only the locale's real decimal mark is capped at one.
 *
 * A candidate is validated as a WHOLE string, never character-by-character —
 * a bad paste is rejected in full, not trimmed down to its valid prefix
 * (React Aria's behavior). `Intl`-absent falls back to a minimal
 * digits/"."/"," character class (the leading-"-" rule still applies, since
 * it needs no locale data).
 */
export function isValidPartialNumberText(text: string, locale?: string): boolean {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  // Minus only as the leading character: a "-" anywhere left in `body` is
  // either a second leading dash ("--") or a misplaced one ("1-").
  if (body.includes("-")) return false;
  if (body === "") return true; // empty text, or a lone leading "-"

  if (typeof Intl === "undefined") {
    return /^[\d.,]*$/.test(body);
  }

  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.8);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const dotIsGroup = group === ".";
  const groupIsWhitespace = /^\s$/.test(group);
  // "." is always ALSO accepted as a decimal mark (parseGroupedNumber's rule)
  // — unless "." is already this locale's group separator, where it instead
  // joins the unlimited grouping check below and only the locale's real
  // decimal mark is capped here.
  const decimalMarks = dotIsGroup ? [decimal] : Array.from(new Set([".", decimal]));

  let decimalSeen = 0;
  for (const ch of body) {
    if (/\d/.test(ch)) continue;
    if (decimalMarks.includes(ch)) {
      if (++decimalSeen > 1) return false;
      continue;
    }
    if (groupIsWhitespace ? /\s/.test(ch) : ch === group) continue;
    return false;
  }
  return true;
}
