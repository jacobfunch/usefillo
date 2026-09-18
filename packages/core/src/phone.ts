/**
 * Lightweight, dependency-free phone metadata + helpers powering the SDK's
 * phone field. Deliberately small: it carries enough to render a country
 * picker, format as-you-type, and do a *possible-length* check. Authoritative
 * validation + canonical normalization happen server-side with full
 * libphonenumber data (bundle size is irrelevant there), so this stays lean and
 * the stored value is always E.164.
 *
 * Coverage is every ITU dial code (~all of ISO 3166-1): 70 curated entries
 * below carry full formatting metadata; every other country is packed
 * "iso2+dialCode" data with no metadata (formatNational/isPossiblePhone fall
 * back to grouping-in-3s / plain E.164 possibility). Names are resolved at
 * runtime via Intl.DisplayNames — zero hardcoded English name literals.
 */

export interface PhoneCountry {
  /** ISO 3166-1 alpha-2, uppercase ("US"). Also drives the flag emoji. */
  iso2: string;
  /** Localized display name, resolved via `Intl.DisplayNames` (falls back
   *  to the iso2 code when that API is unavailable). */
  name: string;
  /** Country calling code without the "+" ("1", "44", "33"). */
  dialCode: string;
  /** Valid national-number lengths in digits. Empty = accept a generic range. */
  lengths: number[];
  /** Digit group sizes for display formatting, e.g. [3,3,4] → "415 555 0123". */
  groups: number[];
  /** Example national number (digits only) for the input placeholder. */
  example: string;
}

// ---------- Localized country names (Intl.DisplayNames, built once) ----------

// undefined = not yet attempted, null = attempted and unavailable, an
// instance = built. Some engines have Intl without Intl.DisplayNames (the
// file's typeof Intl === "undefined" guard, extended for those engines).
let regionNames: Intl.DisplayNames | null | undefined;

function regionDisplayNames(): Intl.DisplayNames | undefined {
  if (regionNames !== undefined) return regionNames ?? undefined;
  if (typeof Intl === "undefined" || typeof Intl.DisplayNames === "undefined") {
    regionNames = null;
    return undefined;
  }
  try {
    regionNames = new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    regionNames = null;
  }
  return regionNames ?? undefined;
}

/** Localized country name for an iso2 code; the iso2 code itself when
 *  DisplayNames can't produce one (unavailable, or unrecognized). */
function regionName(iso2: string): string {
  try {
    return regionDisplayNames()?.of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
}

// iso2, dial, lengths, groups, example. Detailed for high-traffic markets;
// the rest still appear in the picker and fall back to generic grouping/length.
// Name is intentionally NOT authored here — see regionName() above.
const C = (
  iso2: string,
  dialCode: string,
  lengths: number[] = [],
  groups: number[] = [],
  example = "",
): PhoneCountry => ({ iso2, name: regionName(iso2), dialCode, lengths, groups, example });

/** Curated country metadata: full formatting metadata for high-traffic
 *  markets. Order matters for `countryByDialCode`'s tie-break (curated wins
 *  shared codes over packed, US before CA on shared "1") — NOT for picker
 *  display order, see `PHONE_PICKER_COUNTRIES`. */
const CURATED_COUNTRIES: PhoneCountry[] = [
  C("US", "1", [10], [3, 3, 4], "2015550123"),
  C("CA", "1", [10], [3, 3, 4], "5145550123"),
  C("GB", "44", [10], [4, 6], "7400123456"),
  C("AU", "61", [9], [3, 3, 3], "412345678"),
  C("DE", "49", [10, 11], [4, 7], "15123456789"),
  C("FR", "33", [9], [1, 2, 2, 2, 2], "612345678"),
  C("IN", "91", [10], [5, 5], "8123456789"),
  C("DK", "45", [8], [2, 2, 2, 2], "32123456"),
  C("SE", "46", [9], [2, 3, 4], "701234567"),
  C("NO", "47", [8], [3, 2, 3], "40612345"),
  C("FI", "358", [9, 10], [2, 3, 4], "412345678"),
  C("NL", "31", [9], [1, 4, 4], "612345678"),
  C("BE", "32", [9], [3, 2, 2, 2], "470123456"),
  C("ES", "34", [9], [3, 3, 3], "612345678"),
  C("IT", "39", [9, 10], [3, 3, 4], "3123456789"),
  C("PT", "351", [9], [3, 3, 3], "912345678"),
  C("IE", "353", [9], [2, 3, 4], "851234567"),
  C("CH", "41", [9], [2, 3, 2, 2], "781234567"),
  C("AT", "43", [10, 11], [3, 7], "6641234567"),
  C("PL", "48", [9], [3, 3, 3], "512345678"),
  C("CZ", "420", [9], [3, 3, 3], "601123456"),
  C("GR", "30", [10], [3, 3, 4], "6912345678"),
  C("RO", "40", [9], [3, 3, 3], "712345678"),
  C("HU", "36", [9], [2, 3, 4], "201234567"),
  C("UA", "380", [9], [2, 3, 2, 2], "501234567"),
  C("RU", "7", [10], [3, 3, 2, 2], "9123456789"),
  C("TR", "90", [10], [3, 3, 2, 2], "5012345678"),
  C("IL", "972", [9], [2, 3, 4], "501234567"),
  C("AE", "971", [9], [2, 3, 4], "501234567"),
  C("SA", "966", [9], [2, 3, 4], "512345678"),
  C("ZA", "27", [9], [2, 3, 4], "711234567"),
  C("NG", "234", [10], [3, 3, 4], "8021234567"),
  C("KE", "254", [9], [3, 3, 3], "712123456"),
  C("EG", "20", [10], [3, 3, 4], "1001234567"),
  C("BR", "55", [10, 11], [2, 5, 4], "11961234567"),
  C("MX", "52", [10], [3, 3, 4], "2221234567"),
  C("AR", "54", [10], [4, 6], "1123456789"),
  C("CL", "56", [9], [1, 4, 4], "221234567"),
  C("CO", "57", [10], [3, 3, 4], "3211234567"),
  C("PE", "51", [9], [3, 3, 3], "912345678"),
  C("CN", "86", [11], [3, 4, 4], "13123456789"),
  C("JP", "81", [10], [2, 4, 4], "9012345678"),
  C("KR", "82", [9, 10], [2, 4, 4], "1023456789"),
  C("SG", "65", [8], [4, 4], "81234567"),
  C("HK", "852", [8], [4, 4], "51234567"),
  C("TW", "886", [9], [3, 3, 3], "912345678"),
  C("MY", "60", [9, 10], [2, 3, 4], "123456789"),
  C("ID", "62", [10, 11], [3, 4, 4], "81234567890"),
  C("TH", "66", [9], [2, 3, 4], "812345678"),
  C("PH", "63", [10], [3, 3, 4], "9171234567"),
  C("VN", "84", [9], [3, 3, 3], "912345678"),
  C("PK", "92", [10], [3, 3, 4], "3012345678"),
  C("BD", "880", [10], [2, 4, 4], "1812345678"),
  C("NZ", "64", [9, 10], [2, 3, 4], "211234567"),
  C("SK", "421", [9], [3, 3, 3], "912123456"),
  C("BG", "359", [9], [2, 3, 4], "481234567"),
  C("HR", "385", [8, 9], [2, 3, 4], "921234567"),
  C("RS", "381", [8, 9], [2, 3, 4], "601234567"),
  C("SI", "386", [8], [2, 3, 3], "31234567"),
  C("LT", "370", [8], [3, 2, 3], "61234567"),
  C("LV", "371", [8], [2, 3, 3], "21234567"),
  C("EE", "372", [7, 8], [3, 4], "51234567"),
  C("IS", "354", [7], [3, 4], "6111234"),
  C("LU", "352", [9], [3, 3, 3], "628123456"),
  C("MA", "212", [9], [3, 3, 3], "650123456"),
  C("CR", "506", [8], [4, 4], "83123456"),
  C("EC", "593", [9], [2, 3, 4], "991234567"),
  C("UY", "598", [8], [1, 3, 4], "94231234"),
  C("QA", "974", [8], [4, 4], "33123456"),
  C("KW", "965", [8], [4, 4], "50012345"),
];

// ---------- Every remaining ITU-assigned country dial code (packed) ----------

/**
 * "ISO2+dialCode" tokens, whitespace-separated (iso2 is always 2 letters,
 * no other separator needed) — every ITU country dial code not already in
 * CURATED_COUNTRIES, parsed once at init into PhoneCountry entries with
 * lengths/groups/example left empty (formatNational groups these in 3s;
 * isPossiblePhone falls back to E.164 possibility, 8-15 digits).
 *
 * Aims for complete ISO 3166-1 coverage from ITU E.164 assignments.
 * Excluded: non-geographic/global-service codes (+800, +808, +870, +88x,
 * +979, +991, …) — none map to an ISO territory anyway — and the few ISO
 * territories with no assigned dialing plan (Antarctica, Heard/McDonald
 * Islands, US Minor Outlying Islands). Shared codes are real, not bugs:
 * NANP "1" (23 entries here + curated US/CA), "7" (Kazakhstan + curated
 * Russia), "44" (Channel Islands + curated UK), "61" (Christmas/Cocos +
 * curated Australia), "500" (Falklands/South Georgia), "599"
 * (Curaçao/Caribbean Netherlands), and a few territories that dial entirely
 * through a parent's code (Åland, Bouvet Island, Svalbard & Jan Mayen).
 * The curated-first tie-break above keeps the curated set's resolution
 * unchanged.
 */
const PACKED_DIAL_CODES =
  "AD376 AF93 AG1 AI1 AL355 AM374 AO244 AS1 AW297 AX358 AZ994 BA387 BB1 BF226 BH973 BI257 BJ229 BL590 BM1 BN673 BO591 BQ599 BS1 BT975 BV47 BW267 BY375 BZ501 CC61 CD243 CF236 CG242 CI225 CK682 CM237 CU53 CV238 CW599 CX61 CY357 DJ253 DM1 DO1 DZ213 EH212 ER291 ET251 FJ679 FK500 FM691 FO298 GA241 GD1 GE995 GF594 GG44 GH233 GI350 GL299 GM220 GN224 GP590 GQ240 GS500 GT502 GU1 GW245 GY592 HN504 HT509 IM44 IO246 IQ964 IR98 JE44 JM1 JO962 KG996 KH855 KI686 KM269 KN1 KP850 KY1 KZ7 LA856 LB961 LC1 LI423 LK94 LR231 LS266 LY218 MC377 MD373 ME382 MF590 MG261 MH692 MK389 ML223 MM95 MN976 MO853 MP1 MQ596 MR222 MS1 MT356 MU230 MV960 MW265 MZ258 NA264 NC687 NE227 NF672 NI505 NP977 NR674 NU683 OM968 PA507 PF689 PG675 PM508 PN64 PR1 PS970 PW680 PY595 RE262 RW250 SB677 SC248 SD249 SH290 SJ47 SL232 SM378 SN221 SO252 SR597 SS211 ST239 SV503 SX1 SY963 SZ268 TC1 TD235 TF262 TG228 TJ992 TK690 TL670 TM993 TN216 TO676 TT1 TV688 TZ255 UG256 UZ998 VA379 VC1 VE58 VG1 VI1 VU678 WF681 WS685 XK383 YE967 YT262 ZM260 ZW263";

/** Parse PACKED_DIAL_CODES-shaped text into minimal PhoneCountry entries. */
function parsePackedCountries(packed: string): PhoneCountry[] {
  const out: PhoneCountry[] = [];
  for (const token of packed.trim().split(/\s+/)) {
    const iso2 = token.slice(0, 2);
    const dialCode = token.slice(2);
    out.push({ iso2, name: regionName(iso2), dialCode, lengths: [], groups: [], example: "" });
  }
  return out;
}

/**
 * Every known phone country: the 70 curated entries (rich metadata) then
 * every other ITU dial code (name + dial code only). Order is NOT display
 * order (see PHONE_PICKER_COUNTRIES) — it's the tie-break priority
 * `countryByDialCode` resolves shared codes with, preserved so growing this
 * list from 70 to ~240 doesn't change how any of the original 70 resolve.
 */
export const PHONE_COUNTRIES: PhoneCountry[] = [
  ...CURATED_COUNTRIES,
  ...parsePackedCountries(PACKED_DIAL_CODES),
];

/**
 * PHONE_COUNTRIES reordered for a picker UI: localized name, Intl.Collator-
 * compared (falls back to iso2 order without Intl.Collator). Kept separate
 * from PHONE_COUNTRIES, whose order countryByDialCode depends on for
 * curated-first tie-breaking — sorting by name would flip those ties (e.g.
 * "Canada" before "United States" would flip which one "+1…" resolves to).
 */
export const PHONE_PICKER_COUNTRIES: PhoneCountry[] = sortForPicker(PHONE_COUNTRIES);

function sortForPicker(countries: PhoneCountry[]): PhoneCountry[] {
  if (typeof Intl === "undefined" || typeof Intl.Collator === "undefined") {
    return [...countries].sort((a, b) => (a.iso2 < b.iso2 ? -1 : a.iso2 > b.iso2 ? 1 : 0));
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  return [...countries].sort((a, b) => collator.compare(a.name, b.name));
}

const byIso = new Map(PHONE_COUNTRIES.map((c) => [c.iso2, c]));

// Best-effort browser timezone hints for countries in PHONE_COUNTRIES. Unknown
// or ambiguous zones intentionally fall through to the locale/default fallback.
const timeZoneIso: Record<string, string> = {
  "Africa/Cairo": "EG",
  "Africa/Casablanca": "MA",
  "Africa/Johannesburg": "ZA",
  "Africa/Lagos": "NG",
  "Africa/Nairobi": "KE",
  "America/Adak": "US",
  "America/Anchorage": "US",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Argentina/Cordoba": "AR",
  "America/Argentina/Mendoza": "AR",
  "America/Bahia": "BR",
  "America/Belem": "BR",
  "America/Bogota": "CO",
  "America/Boise": "US",
  "America/Boa_Vista": "BR",
  "America/Cancun": "MX",
  "America/Chicago": "US",
  "America/Chihuahua": "MX",
  "America/Campo_Grande": "BR",
  "America/Costa_Rica": "CR",
  "America/Cuiaba": "BR",
  "America/Denver": "US",
  "America/Detroit": "US",
  "America/Edmonton": "CA",
  "America/Fortaleza": "BR",
  "America/Guayaquil": "EC",
  "America/Halifax": "CA",
  "America/Hermosillo": "MX",
  "America/Indiana/Indianapolis": "US",
  "America/Indianapolis": "US",
  "America/Juneau": "US",
  "America/Kentucky/Louisville": "US",
  "America/Lima": "PE",
  "America/Los_Angeles": "US",
  "America/Maceio": "BR",
  "America/Manaus": "BR",
  "America/Matamoros": "MX",
  "America/Mazatlan": "MX",
  "America/Merida": "MX",
  "America/Mexico_City": "MX",
  "America/Moncton": "CA",
  "America/Monterrey": "MX",
  "America/Montevideo": "UY",
  "America/New_York": "US",
  "America/Noronha": "BR",
  "America/Nome": "US",
  "America/North_Dakota/Center": "US",
  "America/Ojinaga": "MX",
  "America/Phoenix": "US",
  "America/Porto_Velho": "BR",
  "America/Punta_Arenas": "CL",
  "America/Recife": "BR",
  "America/Regina": "CA",
  "America/Rio_Branco": "BR",
  "America/Santiago": "CL",
  "America/Sao_Paulo": "BR",
  "America/Sitka": "US",
  "America/St_Johns": "CA",
  "America/Tijuana": "MX",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Whitehorse": "CA",
  "America/Winnipeg": "CA",
  "America/Yakutat": "US",
  "Asia/Bangkok": "TH",
  "Asia/Calcutta": "IN",
  "Asia/Dacca": "BD",
  "Asia/Dhaka": "BD",
  "Asia/Dubai": "AE",
  "Asia/Hong_Kong": "HK",
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Jakarta": "ID",
  "Asia/Jerusalem": "IL",
  "Asia/Karachi": "PK",
  "Asia/Kolkata": "IN",
  "Asia/Kuala_Lumpur": "MY",
  "Asia/Kuwait": "KW",
  "Asia/Manila": "PH",
  "Asia/Qatar": "QA",
  "Asia/Riyadh": "SA",
  "Asia/Seoul": "KR",
  "Asia/Shanghai": "CN",
  "Asia/Saigon": "VN",
  "Asia/Singapore": "SG",
  "Asia/Taipei": "TW",
  "Asia/Tel_Aviv": "IL",
  "Asia/Tokyo": "JP",
  "Asia/Urumqi": "CN",
  "Atlantic/Reykjavik": "IS",
  "Australia/Adelaide": "AU",
  "Australia/Brisbane": "AU",
  "Australia/Darwin": "AU",
  "Australia/Hobart": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Perth": "AU",
  "Australia/Sydney": "AU",
  "Europe/Amsterdam": "NL",
  "Europe/Athens": "GR",
  "Europe/Belgrade": "RS",
  "Europe/Berlin": "DE",
  "Europe/Bratislava": "SK",
  "Europe/Brussels": "BE",
  "Europe/Bucharest": "RO",
  "Europe/Budapest": "HU",
  "Europe/Copenhagen": "DK",
  "Europe/Dublin": "IE",
  "Europe/Helsinki": "FI",
  "Europe/Zagreb": "HR",
  "Europe/Istanbul": "TR",
  "Europe/Kiev": "UA",
  "Europe/Kyiv": "UA",
  "Europe/Lisbon": "PT",
  "Europe/Ljubljana": "SI",
  "Europe/London": "GB",
  "Europe/Luxembourg": "LU",
  "Europe/Madrid": "ES",
  "Europe/Moscow": "RU",
  "Europe/Oslo": "NO",
  "Europe/Paris": "FR",
  "Europe/Prague": "CZ",
  "Europe/Riga": "LV",
  "Europe/Rome": "IT",
  "Europe/Sofia": "BG",
  "Europe/Stockholm": "SE",
  "Europe/Tallinn": "EE",
  "Europe/Vienna": "AT",
  "Europe/Vilnius": "LT",
  "Europe/Warsaw": "PL",
  "Europe/Zurich": "CH",
  "Pacific/Auckland": "NZ",
};

/** Flag emoji from an ISO-3166 alpha-2 code (regional-indicator letters). */
export function flagEmoji(iso2: string): string {
  const cc = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "🏳️";
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export function countryByIso(iso2: string | undefined): PhoneCountry | undefined {
  return iso2 ? byIso.get(iso2.toUpperCase()) : undefined;
}

export function countryByTimeZone(timeZone: string | undefined): PhoneCountry | undefined {
  return countryByIso(timeZone ? timeZoneIso[timeZone] : undefined);
}

/** Country whose dial code is the longest prefix of these digits (no "+"). */
export function countryByDialCode(digits: string): PhoneCountry | undefined {
  let best: PhoneCountry | undefined;
  for (const c of PHONE_COUNTRIES) {
    if (digits.startsWith(c.dialCode) && (!best || c.dialCode.length > best.dialCode.length)) {
      best = c;
    }
  }
  return best;
}

/** Keep only 0-9 (and a leading "+") from arbitrary input. */
export function digitsOnly(input: string): string {
  return input.replace(/[^\d]/g, "");
}

/** Group national digits per the country's format (cosmetic; generic = 3s). */
export function formatNational(country: PhoneCountry | undefined, national: string): string {
  const digits = digitsOnly(national);
  if (!digits) return "";
  const groups = country?.groups?.length ? country.groups : [];
  const out: string[] = [];
  let i = 0;
  for (const size of groups) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + size));
    i += size;
  }
  // Remaining digits beyond the template: chunk in 3s so overflow still reads well.
  while (i < digits.length) {
    out.push(digits.slice(i, i + 3));
    i += 3;
  }
  return out.join(" ");
}

/** Assemble the canonical E.164 value from a country + national digits. */
export function toE164(country: PhoneCountry, national: string): string {
  const digits = digitsOnly(national);
  return digits ? `+${country.dialCode}${digits}` : "";
}

export interface ParsedPhone {
  /** Best-guess country, if the dial code matched one we know. Always unset
   *  while `pending`. */
  country?: PhoneCountry;
  /** National significant digits: dial code stripped once a country is
   *  known, otherwise every digit typed after "+" (or all digits, with no
   *  "+" and no fallback). */
  national: string;
  /** Canonical E.164 ("+…"), or "" if there were no digits. */
  e164: string;
  /**
   * True for a "+"-prefixed value that hasn't resolved a country: no digits
   * at all ("+"), digits that prefix a real dial code without completing
   * one ("+4"), or digits identical to `ParsePhoneOptions.previousDigits` —
   * a bare "+" just prepended to unchanged, stale digits.
   *
   * `national`/`e164` still carry the typed digits (a caller that ignores
   * `pending` degrades gracefully). The renderer should hold off committing
   * a stored value while pending, and redisplay `raw` verbatim instead of
   * `formatNational(country, national)` — there's no country to format
   * against yet, and reformatting a bare "+" into "" is the corruption this
   * field exists to prevent.
   */
  pending?: boolean;
  /** The trimmed input, verbatim. Set only when `pending`. */
  raw?: string;
}

export interface ParsePhoneOptions {
  /**
   * National digits already in the field before this edit (dial code
   * already stripped — the same shape `parsePhone` returns as `national`).
   * Lets `parsePhone` recognize a bare "+" just prepended to unchanged
   * digits and stay `pending` instead of resolving a country from a
   * coincidental prefix match: without this hint, stale digits from a
   * previous, unrelated number always resolve a country the instant "+"
   * lands in front of them (an old "5551234" would silently become
   * Brazilian the moment "+" is typed, since "55" is Brazil's dial code).
   * Pass the pre-edit digits on every keystroke; once they actually change,
   * resolution proceeds normally on the next call.
   */
  previousDigits?: string;
}

/**
 * Parse a stored/typed value into country + national + E.164. Accepts E.164
 * ("+4915123456789"), a bare international number, or — with `fallback` — a
 * national number typed without a dial code.
 *
 * See `ParsedPhone.pending`/`ParsePhoneOptions.previousDigits` for the
 * pending-international-entry contract: a "+"-prefixed value that doesn't
 * resolve a dial code (incl. a lone "+") returns pending instead of
 * silently reverting to `fallback` with an emptied value, and
 * `previousDigits` stops stale leftover digits from resolving a country
 * they never meant to represent, just because "+" was prepended.
 */
export function parsePhone(
  value: string,
  fallback?: PhoneCountry,
  opts?: ParsePhoneOptions,
): ParsedPhone {
  const trimmed = (value ?? "").trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = digitsOnly(trimmed);

  if (hasPlus) {
    if (!digits) return { national: "", e164: "", pending: true, raw: trimmed };
    const previous = opts?.previousDigits ? digitsOnly(opts.previousDigits) : "";
    if (previous && digits === previous) {
      // Only the "+" changed since last time — don't let digits that were
      // already there (and never meant as an international prefix) resolve
      // a country just because they coincidentally match one.
      return { national: digits, e164: `+${digits}`, pending: true, raw: trimmed };
    }
    const country = countryByDialCode(digits);
    if (country) {
      const national = digits.slice(country.dialCode.length);
      return { country, national, e164: `+${digits}` };
    }
    return { national: digits, e164: `+${digits}`, pending: true, raw: trimmed };
  }

  if (!digits) return { country: fallback, national: "", e164: "" };

  // No "+": treat as a national number for the fallback country if given.
  if (fallback) {
    const national = digits.startsWith(fallback.dialCode)
      ? digits.slice(fallback.dialCode.length)
      : digits;
    return { country: fallback, national, e164: `+${fallback.dialCode}${national}` };
  }
  return { national: digits, e164: `+${digits}` };
}

/**
 * Cheap "could this be a real number?" check used for inline feedback. Length
 * only — never claims more than it knows; the server does authoritative
 * validation. `country` (when known) tightens the accepted lengths.
 */
export function isPossiblePhone(value: string): boolean {
  const { country, national, e164 } = parsePhone(value);
  if (!e164) return false;
  const total = digitsOnly(e164).length;
  // E.164 allows at most 15 digits incl. the country code; ITU min is ~7-8.
  if (total < 8 || total > 15) return false;
  if (country?.lengths.length) return country.lengths.includes(national.length);
  return national.length >= 4;
}

// ---------- Country-picker popover positioning (shared by every renderer) ----------

/** Whether the country-picker popover opens below or above its trigger. */
export type PhonePopoverPlacement = "below" | "above";

/** Minimum gap kept between the popover and the viewport edge, in px. */
export const PHONE_POPOVER_VIEWPORT_GAP = 8;

/**
 * Decide whether the country-picker popover should open below or above its
 * anchor and size it to fit the viewport, writing the result to CSS custom
 * properties on the popover. Pure DOM math with no framework assumptions, so
 * the React and vanilla renderers share one implementation instead of drifting
 * copies. Returns "below" when there is nothing to position (SSR / detached).
 */
export function positionPhonePopover(
  anchor: HTMLElement | null,
  popover: HTMLElement | null,
): PhonePopoverPlacement {
  if (!anchor || !popover || typeof window === "undefined") return "below";

  const gap = PHONE_POPOVER_VIEWPORT_GAP;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const anchorRect = anchor.getBoundingClientRect();
  const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap);
  const spaceAbove = Math.max(0, anchorRect.top - gap);
  const placement: PhonePopoverPlacement =
    spaceBelow < popover.scrollHeight && spaceAbove > spaceBelow ? "above" : "below";
  const availableHeight = placement === "above" ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(0, Math.min(availableHeight, viewportHeight - gap * 2));
  const maxWidth = Math.max(0, viewportWidth - gap * 2);

  popover.style.setProperty("--fillo-phone-popover-max-height", `${Math.floor(maxHeight)}px`);
  popover.style.setProperty("--fillo-phone-popover-max-width", `${Math.floor(maxWidth)}px`);
  popover.style.setProperty("--fillo-phone-popover-offset-x", "0px");

  const width = Math.min(popover.offsetWidth, maxWidth);
  // The popover is anchored with `inset-inline-start: 0` (styles.css) and
  // nudged into the viewport purely physically, via `transform:
  // translateX()`. inset-inline-start is the anchor's LEFT edge in ltr but
  // its RIGHT edge in rtl, so the unshifted physical left edge this overflow
  // math corrects from has to flip with it too, or the nudge fires backwards
  // under rtl (ledger #5, docs/decisions/input-quality.md) — an anchor near
  // the viewport's left edge would get pushed further left instead of back
  // on screen. Both callers (react/dom) pass real elements, so reading
  // direction off the anchor itself needs no new parameter.
  const rtl = getComputedStyle(anchor).direction === "rtl";
  const unshiftedLeft = rtl ? anchorRect.right - width : anchorRect.left;
  let offsetX = 0;
  const rightOverflow = unshiftedLeft + width - (viewportWidth - gap);
  if (rightOverflow > 0) offsetX -= rightOverflow;
  const leftOverflow = gap - (unshiftedLeft + offsetX);
  if (leftOverflow > 0) offsetX += leftOverflow;
  popover.style.setProperty("--fillo-phone-popover-offset-x", `${Math.round(offsetX)}px`);

  return placement;
}
