import {
  PHONE_COUNTRIES,
  PHONE_PICKER_COUNTRIES,
  countryByIso,
  countryByTimeZone,
  digitsOnly,
  flagEmoji,
  formatNational,
  parsePhone,
  positionPhonePopover,
  toE164,
  type PhoneCountry,
  type PhonePopoverPlacement,
  type PhoneField as PhoneFieldSchema,
} from "@usefillo/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FieldComponentProps } from "./api.js";
import { useFilloAnnounce, useFilloFieldIds } from "./context.js";
import { useFieldSlots, useStrings } from "./appearance.js";

/** Respondent's region from the browser locale ("en-GB" → "GB"). */
function localeCountry(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const tag = navigator.languages?.[0] || navigator.language || "";
  const region = tag.split("-")[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : undefined;
}

function browserTimeZone(): string | undefined {
  if (typeof Intl === "undefined") return undefined;
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === "string" && timeZone ? timeZone : undefined;
  } catch {
    return undefined;
  }
}

/** National digits of a stored E.164 value, relative to the chosen country. */
function nationalFor(stored: string, country: PhoneCountry): string {
  const digits = digitsOnly(stored);
  return digits.startsWith(country.dialCode) ? digits.slice(country.dialCode.length) : digits;
}

// positionPhonePopover + PHONE_POPOVER_VIEWPORT_GAP now live in @usefillo/core
// so this renderer and @usefillo/dom share one implementation.

export function PhoneField({ field, value, error, setValue, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const slots = useFieldSlots(field, error);
  const strings = useStrings();
  const schema = field as PhoneFieldSchema;
  const stored = typeof value === "string" ? value : "";

  // Country is authoritative for display (so +1 stays Canada if the user chose
  // it). Seed it deterministically — stored number → author default → first —
  // so the server render and first client render agree (no hydration mismatch).
  // The timezone/locale guess resolves to the *server's* region during SSR, so
  // it can't run here; it's applied after mount below.
  const [country, setCountry] = useState<PhoneCountry>(
    () =>
      parsePhone(stored).country ?? countryByIso(schema.defaultCountry) ?? PHONE_COUNTRIES[0]!,
  );
  // True once the respondent types a number or picks a country — freezes the
  // post-mount region guess so it can't clobber a deliberate choice.
  const touched = useRef(false);

  // Saved-progress/identified-response restoration lands after the first
  // client render. Until the respondent acts, let that external E.164 value
  // correct the initially guessed country instead of formatting it with the
  // wrong dial plan.
  useEffect(() => {
    if (touched.current || !stored) return;
    const restoredCountry = parsePhone(stored).country;
    if (restoredCountry) setCountry(restoredCountry);
  }, [stored]);

  // Upgrade to the respondent's region (timezone → locale) after mount, unless a
  // stored value or author default already fixes the country, or they've acted.
  useEffect(() => {
    if (touched.current) return;
    if (parsePhone(stored).country || countryByIso(schema.defaultCountry)) return;
    const guess = countryByTimeZone(browserTimeZone()) ?? countryByIso(localeCountry());
    if (guess) setCountry(guess);
    // Run once per mount — later edits set `touched` and drive country directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An unresolved "+"-prefixed edit (pending: no dial code has matched yet)
  // holds the raw typed text verbatim instead of the computed national
  // grouping — there's no country to format against, and reformatting a bare
  // "+" would be exactly the corruption this field exists to prevent.
  const [pendingRaw, setPendingRaw] = useState<string | null>(null);

  const national = nationalFor(stored, country);
  const display = pendingRaw ?? formatNational(country, national);

  const inputRef = useRef<HTMLInputElement>(null);
  const caretDigits = useRef<number | null>(null);

  // After a reformat, drop the caret just past the Nth digit it was behind.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || caretDigits.current == null) return;
    const target = caretDigits.current;
    caretDigits.current = null;
    if (target === 0) return el.setSelectionRange(0, 0);
    let seen = 0;
    let pos = display.length;
    for (let i = 0; i < display.length; i++) {
      if (/\d/.test(display[i]!) && ++seen === target) {
        pos = i + 1;
        break;
      }
    }
    el.setSelectionRange(pos, pos);
  });

  const commit = (c: PhoneCountry, nat: string) => setValue(nat ? toE164(c, nat) : "");

  function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    touched.current = true;
    const el = e.target;
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    caretDigits.current = digitsOnly(raw.slice(0, caret)).length;
    // A leading "+" means the respondent is entering an international number;
    // let the dial code drive the country selection.
    if (raw.trimStart().startsWith("+")) {
      // previousDigits = the national digits already in the field before
      // this edit, so a bare "+" just prepended to unchanged stale digits
      // stays pending instead of greedily resolving a country from a
      // coincidental prefix match (the old "+55…" -> Brazil corruption).
      const p = parsePhone(raw, country, { previousDigits: national });
      if (p.pending) {
        // No dial code has resolved yet (a lone "+", a partial dial code, or
        // stale digits that didn't actually change): don't reassign the
        // country and don't reformat the input out from under the caret —
        // hold the raw text verbatim and commit it as-is. Left unfinished,
        // validation flags it at submit like any other incomplete number.
        setPendingRaw(p.raw ?? raw);
        setValue(p.raw ?? raw);
        return;
      }
      setPendingRaw(null);
      if (p.country) setCountry(p.country);
      commit(p.country ?? country, p.country ? p.national : digitsOnly(raw));
      return;
    }
    setPendingRaw(null);
    commit(country, digitsOnly(raw));
  }

  function pickCountry(c: PhoneCountry) {
    touched.current = true;
    setPendingRaw(null);
    setCountry(c);
    commit(c, national); // keep the typed national digits, swap the dial code
    inputRef.current?.focus();
  }

  const describedBy =
    [field.description ? ids.descriptionId : null, error ? ids.errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div {...slots.wrapperProps(`fillo-field fillo-field--phone${error ? " fillo-field--error" : ""}`)}>
      <label className={slots.label} data-fillo="label" id={ids.labelId} htmlFor={ids.inputId}>
        {field.label}
        {!field.required && <span className="fillo-optional">{strings.optional}</span>}
      </label>
      {field.description && (
        <p className={slots.description} data-fillo="fieldDescription" id={ids.descriptionId}>
          {field.description}
        </p>
      )}
      <div className="fillo-phone">
        <CountrySelect country={country} onPick={pickCountry} labelledBy={ids.labelId} />
        <input
          ref={inputRef}
          id={ids.inputId}
          className={slots.control("fillo-input fillo-phone-input")}
          data-fillo="control"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={display}
          placeholder={formatNational(country, country.example)}
          onChange={onInput}
          aria-invalid={error ? true : undefined}
          aria-required={field.required ? true : undefined}
          aria-describedby={describedBy}
        />
      </div>
      {error && (
        <p className={slots.error} data-fillo="error" id={ids.errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Accessible country picker: a button that opens a searchable listbox. */
function CountrySelect({
  country,
  onPick,
  labelledBy,
}: {
  country: PhoneCountry;
  onPick: (c: PhoneCountry) => void;
  labelledBy: string;
}) {
  const strings = useStrings();
  const announce = useFilloAnnounce();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<PhonePopoverPlacement>("below");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // A printable key on the closed trigger opens the popover AND seeds the
  // filter with that character (closed-state typeahead) — read once by the
  // open effect below, then cleared.
  const seedRef = useRef<string | null>(null);
  const listId = `${labelledBy}-countries`;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PHONE_PICKER_COUNTRIES;
    const qDigits = q.replace(/[^\d]/g, "");
    return PHONE_PICKER_COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.iso2.toLowerCase() === q ||
        (qDigits.length > 0 && c.dialCode.startsWith(qDigits)),
    );
  }, [query]);

  // Open → focus search, seed the query from a typeahead keystroke (if any),
  // and reset the highlight — to the first match when seeded, otherwise to
  // the current country's position in the full list.
  useEffect(() => {
    if (!open) return;
    const seed = seedRef.current ?? "";
    seedRef.current = null;
    setQuery(seed);
    setActive(seed ? 0 : Math.max(0, PHONE_PICKER_COUNTRIES.indexOf(country)));
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, country]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the popover inside the visible viewport for narrow or short embeds.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => setPlacement(positionPhonePopover(rootRef.current, popoverRef.current));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, matches.length]);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  // Contract §Announcements: narrate the filtered result count as the
  // respondent types — debounced so it fires once typing pauses, never on
  // every keystroke (P2.7: "no announcements for … filter count"). Depends on
  // the resolved TEXT (a primitive), not the `strings` object itself — that
  // object is a fresh reference on every render anywhere in the form, which
  // would otherwise reset this timer on unrelated keystrokes elsewhere.
  const resultsAnnouncement = strings.phoneResultsCount(matches.length);
  useEffect(() => {
    if (!open || !query.trim()) return;
    const id = setTimeout(() => announce(resultsAnnouncement), 300);
    return () => clearTimeout(id);
  }, [open, query, resultsAnnouncement, announce]);

  function choose(c: PhoneCountry | undefined) {
    if (!c) return;
    // Selection commits focus straight to the national input (documented APG
    // deviation below), so nothing else would otherwise announce the pick.
    announce(strings.phoneCountrySelected(c.name));
    onPick(c);
    setOpen(false);
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus(); // don't strand focus in the closed popover
    }
  }

  // Closed-state keyboard for the disclosure trigger: Enter/Space already
  // open it as native button clicks; add the arrows, and let a printable
  // character open + seed the filter in one keystroke.
  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      seedRef.current = e.key;
      setOpen(true);
    }
  }

  // Tab-away closes the popover instead of leaving it open with stale
  // aria-expanded. relatedTarget is the reliable signal for where focus is
  // headed; when an engine doesn't populate it, re-check activeElement once
  // the focus change has actually settled. Deliberately does NOT return
  // focus to the trigger — it's already moving where the respondent sent it
  // (documented APG deviation).
  function onCompositeBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (next) {
      if (!rootRef.current?.contains(next)) setOpen(false);
      return;
    }
    queueMicrotask(() => {
      if (!rootRef.current?.contains(document.activeElement)) setOpen(false);
    });
  }

  return (
    <div className="fillo-phone-country" ref={rootRef} onBlur={onCompositeBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="fillo-phone-flag"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Country: ${country.name} (+${country.dialCode})`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="fillo-phone-flag-emoji" aria-hidden="true">
          {flagEmoji(country.iso2)}
        </span>
        <span className="fillo-phone-dial">+{country.dialCode}</span>
        <span className="fillo-phone-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={popoverRef} className={`fillo-phone-popover fillo-phone-popover--${placement}`}>
          <input
            ref={searchRef}
            className="fillo-phone-search"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label="Search country or code"
            aria-activedescendant={matches[active] ? `${listId}-opt-${active}` : undefined}
            placeholder="Search country or code"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKey}
          />
          <ul className="fillo-phone-list" role="listbox" id={listId} aria-label="Country">
            {matches.map((c, i) => (
              <li
                key={c.iso2}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={c.iso2 === country.iso2}
                className={`fillo-phone-option${i === active ? " fillo-phone-option--active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus; choose before blur
                  choose(c);
                }}
              >
                <span className="fillo-phone-flag-emoji" aria-hidden="true">
                  {flagEmoji(c.iso2)}
                </span>
                <span className="fillo-phone-option-name">{c.name}</span>
                <span className="fillo-phone-option-dial">+{c.dialCode}</span>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="fillo-phone-empty" role="option" aria-disabled="true">
                No matches
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
