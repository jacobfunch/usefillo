import test from "node:test";
import assert from "node:assert/strict";
import {
  PHONE_COUNTRIES,
  PHONE_PICKER_COUNTRIES,
  countryByDialCode,
  countryByIso,
  countryByTimeZone,
  isPossiblePhone,
  parsePhone,
} from "../dist/index.js";

// ---------- countryByTimeZone ----------

test("maps common browser timezones to phone countries", () => {
  assert.equal(countryByTimeZone("Europe/Copenhagen")?.iso2, "DK");
  assert.equal(countryByTimeZone("America/New_York")?.iso2, "US");
  assert.equal(countryByTimeZone("America/Toronto")?.iso2, "CA");
  assert.equal(countryByTimeZone("Asia/Kolkata")?.iso2, "IN");
  assert.equal(countryByTimeZone("Australia/Sydney")?.iso2, "AU");
});

test("ignores unknown or empty browser timezones", () => {
  assert.equal(countryByTimeZone(undefined), undefined);
  assert.equal(countryByTimeZone("Etc/UTC"), undefined);
  assert.equal(countryByTimeZone("Not/A_Timezone"), undefined);
});

// ---------- full ITU country coverage ----------

test("PHONE_COUNTRIES covers effectively all of ISO 3166-1 (~240+, curated 70 included)", () => {
  assert.ok(PHONE_COUNTRIES.length >= 240, `expected ~240+, got ${PHONE_COUNTRIES.length}`);
  const iso2s = new Set(PHONE_COUNTRIES.map((c) => c.iso2));
  assert.equal(iso2s.size, PHONE_COUNTRIES.length, "iso2 codes must be unique");
  for (const c of PHONE_COUNTRIES) {
    assert.match(c.iso2, /^[A-Z]{2}$/, `bad iso2: ${c.iso2}`);
    assert.match(c.dialCode, /^\d{1,4}$/, `bad dialCode for ${c.iso2}: ${c.dialCode}`);
    assert.equal(typeof c.name, "string");
    assert.ok(c.name.length > 0, `empty name for ${c.iso2}`);
  }
});

test("curated countries keep their exact metadata (lengths/groups/example unchanged)", () => {
  const us = countryByIso("US");
  assert.deepEqual(us.lengths, [10]);
  assert.deepEqual(us.groups, [3, 3, 4]);
  assert.equal(us.example, "2015550123");
  assert.equal(us.dialCode, "1");

  const dk = countryByIso("DK");
  assert.deepEqual(dk.lengths, [8]);
  assert.deepEqual(dk.groups, [2, 2, 2, 2]);
  assert.equal(dk.dialCode, "45");

  const br = countryByIso("BR");
  assert.deepEqual(br.lengths, [10, 11]);
  assert.deepEqual(br.groups, [2, 5, 4]);
});

test("packed (non-curated) countries have empty format metadata", () => {
  const kz = countryByIso("KZ");
  assert.ok(kz, "Kazakhstan should be present");
  assert.deepEqual(kz.lengths, []);
  assert.deepEqual(kz.groups, []);
  assert.equal(kz.example, "");
  assert.equal(kz.dialCode, "7");

  for (const iso2 of ["AF", "XK", "VA", "TL", "WS"]) {
    const c = countryByIso(iso2);
    assert.ok(c, `${iso2} should resolve`);
  }
});

test("names are runtime-derived, not a hardcoded literal (Intl.DisplayNames when available)", () => {
  // Node's test runner ships full ICU, so this environment always has
  // Intl.DisplayNames — assert real localization happened, not just the
  // iso2 fallback, for both curated and packed entries.
  assert.equal(countryByIso("US").name, "United States");
  assert.equal(countryByIso("DK").name, "Denmark");
  assert.equal(countryByIso("KZ").name, "Kazakhstan");
  assert.equal(countryByIso("JP").name, "Japan");
});

test("PHONE_PICKER_COUNTRIES is a same-length, Collator-sorted view; PHONE_COUNTRIES order is untouched", () => {
  assert.equal(PHONE_PICKER_COUNTRIES.length, PHONE_COUNTRIES.length);
  // Sorted ascending by localized name.
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  for (let i = 1; i < PHONE_PICKER_COUNTRIES.length; i++) {
    assert.ok(
      collator.compare(PHONE_PICKER_COUNTRIES[i - 1].name, PHONE_PICKER_COUNTRIES[i].name) <= 0,
      `not sorted at ${i}: ${PHONE_PICKER_COUNTRIES[i - 1].name} vs ${PHONE_PICKER_COUNTRIES[i].name}`,
    );
  }
  // PHONE_COUNTRIES itself must still start with the curated set in its
  // original order (US, CA, GB, ...) — countryByDialCode's tie-break and
  // callers using PHONE_COUNTRIES[0] as a default depend on this.
  assert.equal(PHONE_COUNTRIES[0].iso2, "US");
  assert.equal(PHONE_COUNTRIES[1].iso2, "CA");
  assert.equal(PHONE_COUNTRIES[2].iso2, "GB");
});

// ---------- countryByDialCode: longest-prefix + curated-first tie-break ----------

test("countryByDialCode resolves curated countries unchanged (spot checks)", () => {
  assert.equal(countryByDialCode("4512345678")?.iso2, "DK");
  assert.equal(countryByDialCode("12015550123")?.iso2, "US");
  assert.equal(countryByDialCode("447400123456")?.iso2, "GB");
});

test("countryByDialCode: curated-first tie-break is stable for shared dial codes", () => {
  // "1" is shared by US/CA (curated) and 23 packed NANP territories —
  // today's behavior (US wins, first in array) must not change.
  assert.equal(countryByDialCode("15145550123")?.iso2, "US");
  assert.equal(countryByDialCode("1")?.iso2, "US");
  // "7" is shared by curated Russia and packed Kazakhstan.
  assert.equal(countryByDialCode("7")?.iso2, "RU");
  // "44" is shared by curated UK and packed Channel Islands.
  assert.equal(countryByDialCode("44")?.iso2, "GB");
  // "61" is shared by curated Australia and packed Christmas/Cocos Islands.
  assert.equal(countryByDialCode("61")?.iso2, "AU");
  // "64" is shared by curated New Zealand and packed Pitcairn.
  assert.equal(countryByDialCode("64")?.iso2, "NZ");
  // "47" is shared by curated Norway and packed Svalbard/Bouvet Island.
  assert.equal(countryByDialCode("47")?.iso2, "NO");
});

test("countryByDialCode: longest-prefix match over the full set", () => {
  // "420" (Czechia, curated) must win over any shorter false-prefix match.
  assert.equal(countryByDialCode("420601123456")?.iso2, "CZ");
  // A packed 3-digit code resolves correctly against the full table.
  assert.equal(countryByDialCode("998901234567")?.iso2, "UZ");
});

test("countryByDialCode returns undefined for digits matching nothing", () => {
  assert.equal(countryByDialCode(""), undefined);
});

// ---------- isPossiblePhone ----------

test("isPossiblePhone: curated countries keep exact-length validation", () => {
  assert.equal(isPossiblePhone("+4512345678"), true); // DK: exactly 8 national digits
  assert.equal(isPossiblePhone("+451234567"), false); // DK: 7 digits, not in lengths [8]
  assert.equal(isPossiblePhone("+45123456789"), false); // DK: 9 digits, not in lengths [8]
  assert.equal(isPossiblePhone("+12015550123"), true); // US: exactly 10 national digits
  assert.equal(isPossiblePhone("+1201555012"), false); // US: 9 digits, not in lengths [10]
});

test("isPossiblePhone: unknown-length (packed) countries fall back to E.164 8-15 possibility", () => {
  // Uzbekistan (dial "998", packed — unknown lengths, no curated collision):
  // total E.164 digits must be 8-15, nothing more specific is known.
  assert.equal(isPossiblePhone("+998" + "12345"), true); // 3+5=8 digits total: possible (minimum)
  assert.equal(isPossiblePhone("+998" + "1234"), false); // 3+4=7 digits total: too short
  assert.equal(isPossiblePhone("+998" + "1".repeat(12)), true); // 3+12=15 digits: still possible (maximum)
  assert.equal(isPossiblePhone("+998" + "1".repeat(13)), false); // 3+13=16 digits: too long
  // Vatican City (dial "379", packed — a second unknown-length country).
  assert.equal(isPossiblePhone("+379" + "12345"), true); // 3+5=8: possible
  assert.equal(isPossiblePhone("+379" + "1234"), false); // 3+4=7: too short
});

test("isPossiblePhone: dial codes shared with a curated country still use the curated exact-length rule", () => {
  // "7" resolves to curated Russia (curated-first tie-break over packed
  // Kazakhstan) — RU has lengths=[10], so the loose 8-15 fallback must NOT
  // apply here even though "7" is also Kazakhstan's dial code.
  assert.equal(isPossiblePhone("+7" + "9123456789"), true); // RU example: 10 national digits
  assert.equal(isPossiblePhone("+7" + "1234567"), false); // 7 national digits: not in RU's [10]
});

test("isPossiblePhone: unresolved dial code / empty / non-plus digits", () => {
  assert.equal(isPossiblePhone(""), false);
  assert.equal(isPossiblePhone("+"), false);
  assert.equal(isPossiblePhone("+4"), false); // pending, far too short regardless
});

// ---------- parsePhone: pending-international state (the "+" corruption fix) ----------

test("parsePhone('+') alone is pending, not a silent revert to fallback", () => {
  const fallback = countryByIso("DK");
  const p = parsePhone("+", fallback);
  assert.equal(p.pending, true);
  assert.equal(p.country, undefined);
  assert.equal(p.raw, "+");
  assert.equal(p.national, "");
  assert.equal(p.e164, "");
});

test("parsePhone('+4') is pending: digits are a real prefix but resolve nothing yet", () => {
  const p = parsePhone("+4");
  assert.equal(p.pending, true);
  assert.equal(p.country, undefined);
  assert.equal(p.raw, "+4");
  assert.equal(p.national, "4");
  assert.equal(p.e164, "+4");
});

test("parsePhone('+45') resolves Denmark (not pending)", () => {
  const p = parsePhone("+45");
  assert.equal(p.pending, undefined);
  assert.equal(p.country?.iso2, "DK");
  assert.equal(p.national, "");
  assert.equal(p.e164, "+45");
});

test("parsePhone('+1') resolves United States (curated tie-break, not pending)", () => {
  const p = parsePhone("+1");
  assert.equal(p.pending, undefined);
  assert.equal(p.country?.iso2, "US");
  assert.equal(p.national, "");
});

test("parsePhone: digits-without-plus behavior is unchanged", () => {
  const noFallback = parsePhone("5551234");
  assert.equal(noFallback.pending, undefined);
  assert.equal(noFallback.country, undefined);
  assert.equal(noFallback.national, "5551234");
  assert.equal(noFallback.e164, "+5551234");

  const dk = countryByIso("DK");
  const withFallback = parsePhone("32123456", dk);
  assert.equal(withFallback.pending, undefined);
  assert.equal(withFallback.country?.iso2, "DK");
  assert.equal(withFallback.national, "32123456");
  assert.equal(withFallback.e164, "+4532123456");

  // Empty / whitespace-only, no plus: unchanged early-return shape.
  const empty = parsePhone("   ", dk);
  assert.equal(empty.pending, undefined);
  assert.equal(empty.country?.iso2, "DK");
  assert.equal(empty.national, "");
  assert.equal(empty.e164, "");
});

test("parsePhone: a fully-typed international number resolves normally with no stale-digit hint", () => {
  // Without `previousDigits`, "+5551234" is taken at face value: "55" is a
  // real dial code (Brazil), so it resolves — this is correct when the
  // respondent actually typed all of it fresh.
  const p = parsePhone("+5551234");
  assert.equal(p.pending, undefined);
  assert.equal(p.country?.iso2, "BR");
  assert.equal(p.national, "51234");
});

test("parsePhone: stale digits + a freshly-prepended '+' stay pending (do not resolve Brazil by coincidence)", () => {
  // The respondent had "5551234" in the field (leftover national digits for
  // some other, unrelated entry) and only typed "+" — the digits after "+"
  // are byte-identical to what was already there, so this must NOT
  // silently resolve Brazil just because "55" happens to be its dial code.
  const p = parsePhone("+5551234", undefined, { previousDigits: "5551234" });
  assert.equal(p.pending, true);
  assert.equal(p.country, undefined);
  assert.equal(p.raw, "+5551234");
  assert.equal(p.national, "5551234");
});

test("parsePhone: previousDigits only suppresses resolution when digits are UNCHANGED — a genuine edit resolves normally", () => {
  // The respondent typed "+" over stale "1234", then kept typing more
  // digits — digits now differ from previousDigits, so this is a real
  // edit and should resolve like any other international number.
  const p = parsePhone("+5551234", undefined, { previousDigits: "1234" });
  assert.equal(p.pending, undefined);
  assert.equal(p.country?.iso2, "BR");
});

test("parsePhone: previousDigits does not suppress resolution for '+45' from empty stale digits", () => {
  const p = parsePhone("+45", undefined, { previousDigits: "" });
  assert.equal(p.pending, undefined);
  assert.equal(p.country?.iso2, "DK");
});

test("parsePhone: previousDigits is ignored on the non-plus path", () => {
  const p = parsePhone("5551234", undefined, { previousDigits: "5551234" });
  assert.equal(p.pending, undefined);
  assert.equal(p.national, "5551234");
});
