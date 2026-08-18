import {
  DEFAULT_STRINGS,
  DEFAULT_FIELD_STRINGS,
  FilloClient,
  FilloError,
  PHONE_COUNTRIES,
  PHONE_PICKER_COUNTRIES,
  countryByIso,
  countryByTimeZone,
  createClient,
  createFormController as coreCreateFormController,
  defineForm,
  digitsOnly,
  flagEmoji,
  formSchemasEqual,
  formatAnswer,
  formatGroupedNumber,
  formatNational,
  isBuildTimeDevEnv,
  isCodeForm,
  isField,
  isFilloError,
  isLikelyDevEnv,
  isValidPartialNumberText,
  localeForNotation,
  normalizeFormSchema,
  normalizeFormTheme,
  parseGroupedNumber,
  parsePhone,
  pipeBlock,
  positionPhonePopover,
  provisionWorkspace,
  needsExplicitSubmit,
  radioGroupStep,
  reachablePageSequence,
  REQUIRED_FIELD_MESSAGE,
  requiredFieldMessage,
  resolveThemeAppearance,
  shouldAutoSubmit,
  syncCodeForm,
  toE164,
  validateResponse,
  visibleFields,
  visibleGroupChildren,
  type Block,
  type PhoneCountry,
  type PhoneField,
  type ProvisionWorkspaceResult,
  type ChallengeConfig,
  type ChallengeTheme,
  type FormController,
  type FormControllerOptions,
  type FormControllerState,
  type ChoiceField,
  type CodeForm,
  type ContentBlock,
  type Field,
  type FieldKind,
  type FieldValue,
  type FileValue,
  type FormPage,
  type FormSchema,
  type FormTheme,
  type FilloClientOptions,
  type FilloRespondent,
  type GroupInstanceValue,
  type RepeatingGroupField,
  type ResponseData,
  type SelectOption,
  type FormStatus as CoreFormStatus,
} from "@usefillo/core";

// The standalone renderer's lifecycle = the engine's, plus the states only the
// DOM wrapper has (fetching the schema, a closed form). Extending the core type
// keeps them in sync instead of silently diverging.
export type FormStatus = CoreFormStatus | "loading" | "closed";

export interface FilloDomApi {
  form: FormSchema;
  formId?: string;
  client?: FilloClient;
  data: ResponseData;
  errors: Record<string, string>;
  status: FormStatus;
  pageIndex: number;
  pageCount: number;
  page: FormPage;
  blocks: Block[];
  isFirstPage: boolean;
  isLastPage: boolean;
  setValue: (fieldId: string, value: FieldValue, options?: { render?: boolean }) => void;
  next: () => void;
  back: () => void;
  submit: () => Promise<void>;
}

export interface FieldRenderContext {
  field: Field;
  value: FieldValue;
  error: string | undefined;
  ids: FilloDomFieldIds;
  api: FilloDomApi;
  setValue: (value: FieldValue, options?: { render?: boolean }) => void;
  uploadFiles?: (field: Extract<Field, { kind: "file_upload" }>, files: File[]) => Promise<void>;
}

export interface FilloDomFieldIds {
  inputId: string;
  labelId: string;
  descriptionId: string;
  errorId: string;
  name: string;
}

/** One in-flight/failed row for a file_upload field — mirrors @usefillo/react's
 *  InFlight[] granularity (audit P0.3), adapted to dom's imperative Map. Done
 *  files still live in `context.value` as FileValue[], not here. */
interface UploadRow {
  key: string;
  name: string;
  size: number;
  fraction: number;
  error?: string;
  tooLarge?: boolean;
}

type InternalFieldRenderContext = FieldRenderContext & {
  activeOtherFields?: Set<string>;
  getValue?: () => FieldValue;
  // Register an overlay's teardown (e.g. the phone country popover) so the
  // controller can close it — and drop its window/document listeners — on the
  // next full render or on destroy(). Returns an unregister callback.
  registerOverlay?: (close: () => void) => () => void;
  // Soft capacity/busy notices (too-many-files, oversized) — a plain string,
  // no live role (audit P2.1/P2.8: the visible node carries no live
  // semantics; `announce()` below is what actually narrates it).
  uploadNotice?: string;
  // Per-file in-flight/failed rows for this field (audit P0.3).
  uploadRows?: UploadRow[];
  uploadAction?: (key: string, action: "cancel" | "retry" | "dismiss") => void;
  // Why uploads are deliberately disabled before an attempt can start.
  uploadDisabledReason?: "storage_unavailable" | "render_only";
  storageFixUrl?: string | null;
  // The two persistent live-region channels (audit P2.1 hoist) — polite
  // status and assertive alert, both hoisted outside the re-rendered tree.
  announce?: (text: string) => void;
  announceAlert?: (text: string) => void;
  // Repeating-group support (contract decision 8/9). instanceId: the same
  // per-form namespace fieldIds() uses for top-level ids, needed so a
  // group's synthesized child contexts can derive compound ids the same
  // way. renderChildField: the SAME per-kind renderer dispatch renderBlock
  // uses (host `components`/`customComponents` overrides included) —
  // threaded so a group's own FieldRenderer (a plain function, no `this`)
  // can render instance children through the existing per-block path
  // instead of a parallel, override-blind copy of it. setGroupFocus:
  // records where focus belongs once an Add/Remove write reaches the
  // deferred queueRender() rebuild.
  instanceId?: string;
  renderChildField?: (context: FieldRenderContext) => HTMLElement | null;
  setGroupFocus?: (intent: GroupFocusIntent) => void;
};

export type FieldRenderer = (context: FieldRenderContext) => HTMLElement | null;

interface RenderFormBaseOptions {
  theme?: FormTheme;
  initialData?: ResponseData;
  /**
   * identify(): the host app's account context for the person filling the
   * form ({ id, email?, name?, traits? }). Recorded with the response as an
   * unverified claim. Late-bind with setRespondent() once a session loads.
   */
  respondent?: FilloRespondent;
  /**
   * Human-verification challenge config (public site key + provider). Normally
   * read from the form fetch/sync automatically; pass it explicitly only when
   * rendering an inline `form` schema and still wanting the widget (Fillo's
   * hosted page does this). Wins over anything the server delivers.
   */
  challenge?: ChallengeConfig;
  /**
   * Theme for the human-verification widget. Defaults to "auto" (the
   * visitor's OS preference); apps with their own theme switch pass
   * "light"/"dark" so the widget matches the surrounding form.
   */
  challengeTheme?: ChallengeTheme;
  /**
   * Bridge-mode visibility for the human check. "interaction-only" (default)
   * keeps it invisible unless Cloudflare needs the visitor to act; "always"
   * shows the classic widget box the whole time.
   */
  challengeAppearance?: "always" | "interaction-only";
  className?: string;
  components?: Partial<Record<FieldKind, FieldRenderer>>;
  customComponents?: Record<string, FieldRenderer>;
  onChange?: (data: ResponseData) => void;
  onSubmitted?: (responseId: string | undefined, data: ResponseData) => void;
  onError?: (error: FilloError) => void;
  /**
   * Show the developer chrome on a surface Fillo doesn't detect as local
   * development — a tunnel, a staging deploy, a production build you're
   * smoke-testing. COSMETIC ONLY: it renders the dev notices, developer-grade
   * submit failures, and a visible "Preview" badge, and it never changes
   * where submissions go or whether they are accepted (test submissions
   * authenticate with a credential, never a prop).
   */
  preview?: boolean;
  /**
   * Set false to hide the built-in dev notices (draft/staged/sync/no-client)
   * when your page provides its own context. The explicit Preview badge and
   * the production fail-closed states are unaffected.
   */
  devNotices?: boolean;
  renderSuccess?: (api: FilloDomApi) => HTMLElement;
  renderError?: (error: FilloError) => HTMLElement;
}

type HostedRenderFormOptions = RenderFormBaseOptions & {
  formId: string;
  form?: undefined;
  client?: FilloClient;
  renderOnly?: false;
};

type InlineTargetedRenderFormOptions = RenderFormBaseOptions & {
  form: FormSchema | CodeForm;
  formId: string;
  client?: FilloClient;
  renderOnly?: false;
};

type CodeBackedRenderFormOptions = RenderFormBaseOptions & {
  form: CodeForm;
  client: FilloClient;
  formId?: undefined;
  renderOnly?: false;
};

type RenderOnlyFormOptions = RenderFormBaseOptions & {
  form: FormSchema | CodeForm;
  client?: FilloClient;
  formId?: string;
  /** Explicit local preview: submission, uploads, and saved progress are disabled. */
  renderOnly: true;
};

export type RenderFormOptions =
  | HostedRenderFormOptions
  | InlineTargetedRenderFormOptions
  | CodeBackedRenderFormOptions
  | RenderOnlyFormOptions;

interface InternalRenderFormOptions extends RenderFormBaseOptions {
  form?: FormSchema | CodeForm;
  client?: FilloClient;
  formId?: string;
  renderOnly?: boolean;
}

export interface FilloDomForm {
  readonly element: HTMLElement;
  readonly status: FormStatus;
  readonly data: ResponseData;
  readonly form: FormSchema | null;
  setValue(fieldId: string, value: FieldValue): void;
  next(): void;
  back(): void;
  submit(): Promise<void>;
  /** Late-bind identify() context once the host session loads. */
  setRespondent(respondent: FilloRespondent | undefined): void;
  /** Persist unsaved saved-progress answers now (settings.saveProgress forms).
   *  The renderer already flushes on pagehide/visibility-hidden. */
  flushDraft(): void;
  /** Discard the saved draft and reset to a fresh fill ("Start over"). */
  resetDraft(): void;
  destroy(): void;
}

const FIELD_INPUT_PREFIX = "fillo-";
let domInstanceCounter = 0;

// A full render tears the tree down and rebuilds it, so keyboard focus has to be
// captured beforehand and restored afterwards. This locates the focused control
// well enough to put focus back on the equivalent new node.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `node` itself if it's focusable, else its first focusable descendant —
 *  composite widgets (rating/scale/ranking/matrix) mark `aria-invalid` on a
 *  non-focusable group `<div>`, so focus has to land on a child instead. */
function focusableWithin(node: HTMLElement): HTMLElement | null {
  return node.matches(FOCUSABLE_SELECTOR)
    ? node
    : node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

/** A repeating-group instance card's first focusable control that belongs to
 *  one of its CHILD fields — never the card's own header chrome (the Remove
 *  button sits earlier in document order than every child field, so a plain
 *  `focusableWithin(card)` would land a just-added card's focus on Remove,
 *  one keypress from deleting the card the respondent just created). */
function firstChildControl(card: HTMLElement): HTMLElement | null {
  const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return focusable.find((node) => !node.closest(".fillo-group-instance-header")) ?? null;
}

interface FocusDescriptor {
  id?: string;
  fieldId?: string;
  controlIndex?: number;
  rankOpt?: string;
  rankDir?: string;
  selStart?: number | null;
  selEnd?: number | null;
}

/**
 * Where focus belongs after a repeating group's Add/Remove (contract
 * decision 9) — computed synchronously inside the click handler, BEFORE
 * queueRender's deferred macrotask rebuild runs, and consumed once by
 * applyFocus/applyGroupFocus exactly like the "page"/"error" intents. Unlike
 * ranking's restoreFocus precedent (the moved item keeps its identity, so a
 * plain re-focus-by-descriptor works), Add/Remove change WHICH card is the
 * target — a new one that didn't exist at capture time, or the removed
 * card's neighbor — so a generic FocusDescriptor can't express it; this is
 * resolved by position against the tree render() just produced instead.
 */
interface GroupFocusIntent {
  groupId: string;
  /** Index of the target instance card in the freshly rendered tree; -1 = no
   *  card at that position (fall back to the Add button). */
  cardIndex: number;
  /** Add: the new card's first focusable control (fallback: the card
   *  itself). Remove: always the card's own tabIndex=-1 wrapper (its
   *  role="group" heading) — never a sibling's control. */
  intoControl: boolean;
}

function fieldIds(instanceId: string, fieldId: string): FilloDomFieldIds {
  const base = `${FIELD_INPUT_PREFIX}${instanceId}-${fieldId}`;
  return {
    inputId: base,
    labelId: `${base}-label`,
    descriptionId: `${base}-desc`,
    errorId: `${base}-error`,
    name: base,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  return node;
}

function themeStyle(node: HTMLElement, theme?: FormTheme): void {
  // resolveThemeAppearance infers colorScheme from a fixed background when
  // the scheme is absent or auto (contract: "Dark is a supported first-class
  // path") — run it before consuming colorScheme
  // below so an inferred scheme cascades through the same shipped
  // [data-fillo-color-scheme="dark"] CSS as an explicit one.
  const safeTheme = resolveThemeAppearance(normalizeFormTheme(theme));
  if (!safeTheme) return;
  if (safeTheme.colorScheme) node.setAttribute("data-fillo-color-scheme", safeTheme.colorScheme);
  if (safeTheme.primary) node.style.setProperty("--fillo-primary", safeTheme.primary);
  if (safeTheme.background) node.style.setProperty("--fillo-bg", safeTheme.background);
  if (safeTheme.text) node.style.setProperty("--fillo-text", safeTheme.text);
  if (safeTheme.radius) node.style.setProperty("--fillo-radius", safeTheme.radius);
  if (safeTheme.fontFamily) node.style.setProperty("--fillo-font", safeTheme.fontFamily);
  if (safeTheme.primary || safeTheme.background || safeTheme.text) {
    node.setAttribute("data-fillo-has-color-theme", "");
  }
}

function safeHttpUrl(href: string | undefined): string | null {
  try {
    if (!href) return null;
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function badgeUrl(href: string | undefined): string {
  const url = new URL(safeHttpUrl(href) ?? "https://fillo.so");
  url.searchParams.set("utm_source", "form_badge");
  return url.toString();
}

function inputValue(value: FieldValue): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** Grouped-notation unfocused display: grouped text when the stored value
 *  parses finite, else today's raw canonical text (unset/garbage stays
 *  visible as-is instead of showing a stray "0"). Shared by the initial
 *  render and the blur reformat. `locale` is core's localeForNotation
 *  mapping — undefined (browser detect) for notation:"grouped". */
function groupedInputValue(
  value: FieldValue,
  decimals: number | undefined,
  locale: string | undefined,
): string {
  const raw = inputValue(value);
  if (raw === "") return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? formatGroupedNumber(n, { locale, decimals }) : raw;
}

function appendChildren(
  parent: HTMLElement,
  children: Array<Node | null | undefined>,
): HTMLElement {
  for (const child of children) {
    if (child) parent.appendChild(child);
  }
  return parent;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const OPTION_ICON_PATHS: Record<NonNullable<SelectOption["icon"]>, string> = {
  thumbs_up:
    "M7 10v10M7 10l4.8-6.1a2 2 0 0 1 3.5 1.7L14.6 10h4.8a2.1 2.1 0 0 1 2 2.5l-1.1 5.4A3 3 0 0 1 17.4 20H7M3 10h4v10H3z",
  thumbs_down:
    "M7 14V4M7 14l4.8 6.1a2 2 0 0 0 3.5-1.7L14.6 14h4.8a2.1 2.1 0 0 0 2-2.5l-1.1-5.4A3 3 0 0 0 17.4 4H7M3 4h4v10H3z",
};

function optionIcon(icon: SelectOption["icon"]): SVGSVGElement | null {
  if (!icon) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "fillo-option-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", OPTION_ICON_PATHS[icon]);
  svg.appendChild(path);
  return svg;
}

/**
 * Validity / required / description wiring for a control or group element, so
 * assistive tech announces invalidity and ties it to the message text.
 *
 * `aria-required` only lands when the host's role supports it (ARIA 1.2's
 * per-role allowed-attributes table): real inputs and `role="radiogroup"` do,
 * but `role="group"` and `role="button"` do not — axe's aria-allowed-attr
 * flags it as critical (ledger #1, docs/decisions/input-quality.md). Callers
 * on a group/button host pass `requiredSupported: false`; the field's
 * required-ness is still conveyed (the shell's required styling/
 * `data-required`, plus, where a group wraps real inputs, per-input
 * aria-required — never scattered onto every checkbox in a group, which
 * stays a plain visual/label convention).
 */
function applyFieldAria(
  node: HTMLElement,
  field: Field,
  error: string | undefined,
  ids: FilloDomFieldIds,
  opts: { requiredSupported?: boolean } = {},
): void {
  if (error) node.setAttribute("aria-invalid", "true");
  if ((opts.requiredSupported ?? true) && field.required)
    node.setAttribute("aria-required", "true");
  const describedBy = [field.description ? ids.descriptionId : null, error ? ids.errorId : null]
    .filter(Boolean)
    .join(" ");
  if (describedBy) node.setAttribute("aria-describedby", describedBy);
}

/**
 * Native-radio keyboard behavior for button-based rating/scale controls.
 * The wrap-vs-clamp math is core's `radioGroupStep` (audit P2.3) — clamps at
 * the extremes (no wrap), adds Home/End, and reads direction fresh per
 * keydown so RTL forms get direction-aware arrows. `current` is the
 * currently-selected VALUE (or null); radioGroupStep takes the -1-sentinel
 * "nothing selected" index convention (core's own test: `ArrowRight`/
 * `ArrowLeft` from -1 both clamp to 0), which is deliberately NOT the
 * roving-tabindex `tabbable` position used for the DOM `tabindex` attribute
 * elsewhere — that one always normalizes to 0 so Tab has exactly one stop.
 */
function bindRadioKeys(
  group: HTMLElement,
  values: number[],
  current: number | null,
  select: (value: number) => void,
): void {
  group.addEventListener("keydown", (event) => {
    const rtl = getComputedStyle(group).direction === "rtl";
    const index = current === null ? -1 : values.indexOf(current);
    const next = radioGroupStep(event.key, index, values.length, { rtl });
    if (next === null) return;
    event.preventDefault();
    const value = values[next];
    if (value === undefined) return;
    select(value);
    group.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  });
}

function shell(
  field: Field,
  error: string | undefined,
  child: HTMLElement,
  ids: FilloDomFieldIds,
): HTMLElement {
  const wrap = el("div", {
    className: `fillo-field fillo-field--${field.kind}${error ? " fillo-field--error" : ""}`,
    attrs: { "data-fillo": "field", "data-field": field.id, "data-kind": field.kind },
  });
  wrap.toggleAttribute("data-invalid", Boolean(error));
  wrap.toggleAttribute("data-required", Boolean(field.required));
  const label = el("label", {
    className: "fillo-label",
    text: field.label,
    attrs: { id: ids.labelId, for: ids.inputId, "data-fillo": "label" },
  });
  // A repeating group's `required` is normalization-forced false — minInstances
  // owns completeness, so only a min-0 group reads as optional.
  const optionalMarker =
    !field.required && !(field.kind === "repeating_group" && (field.minInstances ?? 1) > 0);
  if (optionalMarker)
    label.appendChild(el("span", { className: "fillo-optional", text: " (optional)" }));
  wrap.appendChild(label);
  if (field.description)
    wrap.appendChild(
      el("p", {
        className: "fillo-description",
        text: field.description,
        attrs: { id: ids.descriptionId, "data-fillo": "fieldDescription" },
      }),
    );
  wrap.appendChild(child);
  // Plain describedby text, no role="alert": failed submit focuses the first
  // invalid control so its label and this guidance are announced together.
  if (error)
    wrap.appendChild(
      el("p", {
        className: "fillo-error",
        text: error,
        attrs: { id: ids.errorId, "data-fillo": "error" },
      }),
    );
  return wrap;
}

function textInput(type: string, context: FieldRenderContext): HTMLElement {
  const field = context.field;
  // notation/prefix/suffix only exist on number fields — undefined for every
  // other kind, so all the branches below fall through to today's behavior.
  const numberField = field.kind === "number" ? field : undefined;
  const grouped = numberField?.notation !== undefined;
  // "grouped" detects the browser locale (undefined); the fixed styles pin
  // the separators via core's notation→locale map, shared with @usefillo/react.
  const locale = localeForNotation(numberField?.notation);
  // Formatted = grouped OR affix-only. A native number input's value
  // sanitizer silently rejects separator/affix characters, so the whole
  // formatted path is type="text" + a decimal keypad, not just grouped.
  const formatted = grouped || Boolean(numberField?.prefix) || Boolean(numberField?.suffix);
  const input = el("input", {
    className: "fillo-input",
    attrs: { id: context.ids.inputId, type: formatted ? "text" : type, "data-fillo": "control" },
  });
  if (formatted) input.setAttribute("inputmode", "decimal");
  // Autocomplete per the input-quality contract: email/url get their token;
  // short_text/long_text/date/number get none (no guessing generic fields).
  if (type === "email") input.setAttribute("autocomplete", "email");
  else if (type === "url") input.setAttribute("autocomplete", "url");
  input.value = grouped
    ? groupedInputValue(context.value, numberField?.decimals, locale)
    : inputValue(context.value);
  if (field.placeholder) input.placeholder = field.placeholder;
  if ("maxLength" in field && field.maxLength !== undefined) {
    input.maxLength = field.maxLength;
  }
  if (numberField && !formatted) {
    // Only a bare number field (no grouping, no affixes) ever reaches this —
    // the formatted path is always type="text", where min/max are inert
    // (core validation enforces them either way).
    if (numberField.min !== undefined) input.min = String(numberField.min);
    if (numberField.max !== undefined) input.max = String(numberField.max);
  }
  if (formatted) {
    // Keystroke filter (isValidPartialNumberText, shared with @usefillo/react):
    // an edit — a pasted chunk included — that fails the check is rejected
    // wholesale, restoring the last-accepted text and caret instead of ever
    // reaching setValue. lastValid/lastCaret track the last accepted state so
    // a reject always reverts to real prior input, not a stale initial value.
    let lastValid = input.value;
    let lastCaret = input.value.length;
    const rejectEdit = () => {
      input.value = lastValid;
      input.setSelectionRange(lastCaret, lastCaret);
    };
    if (grouped) {
      // No unformat-on-focus: the respondent edits the formatted text as-is,
      // and every change still parses to canonical below — raw text while
      // typing, data stays canonical (never grouped) …
      input.addEventListener("input", () => {
        if (!isValidPartialNumberText(input.value, locale)) return rejectEdit();
        lastValid = input.value;
        lastCaret = input.selectionStart ?? input.value.length;
        context.setValue(parseGroupedNumber(input.value, locale), { render: false });
      });
      input.addEventListener("change", () => {
        if (!isValidPartialNumberText(input.value, locale)) return rejectEdit();
        lastValid = input.value;
        context.setValue(parseGroupedNumber(input.value, locale));
      });
      // … and grouped again once unfocused. "change" already re-renders (a
      // fresh, unfocused input shows grouped on its own) — this listener
      // covers blur WITHOUT a change (e.g. prefill/draft-restore focus with no
      // edit), where no re-render happens to reformat it.
      input.addEventListener("blur", () => {
        const live = (context as InternalFieldRenderContext).getValue?.() ?? context.value;
        input.value = groupedInputValue(live, numberField?.decimals, locale);
        lastValid = input.value;
        lastCaret = input.value.length;
      });
    } else {
      // Affix-only: same filter, no grouping transform — canonical text
      // passes straight through, same as today. `locale` is always undefined
      // here (no notation set), so the filter stays browser-locale driven.
      input.addEventListener("input", () => {
        if (!isValidPartialNumberText(input.value, locale)) return rejectEdit();
        lastValid = input.value;
        lastCaret = input.selectionStart ?? input.value.length;
        context.setValue(input.value, { render: false });
      });
      input.addEventListener("change", () => {
        if (!isValidPartialNumberText(input.value, locale)) return rejectEdit();
        lastValid = input.value;
        context.setValue(input.value);
      });
    }
  } else {
    input.addEventListener("input", () => context.setValue(input.value, { render: false }));
    input.addEventListener("change", () => context.setValue(input.value));
  }
  applyFieldAria(input, field, context.error, context.ids);
  // Adornments wrap the input only when prefix/suffix is set — notation alone
  // has nothing to adorn. shell() takes the wrapper in the input's place;
  // applyFieldAria above still targets the input itself.
  let control: HTMLElement = input;
  if (numberField && (numberField.prefix || numberField.suffix)) {
    control = appendChildren(el("div", { className: "fillo-number" }), [
      numberField.prefix
        ? el("span", { className: "fillo-number-prefix", text: numberField.prefix })
        : null,
      input,
      numberField.suffix
        ? el("span", { className: "fillo-number-suffix", text: numberField.suffix })
        : null,
    ]);
  }
  return shell(field, context.error, control, context.ids);
}

/** Respondent's region from the browser locale ("en-GB" → "GB"). */
function domLocaleCountry(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const tag = navigator.languages?.[0] || navigator.language || "";
  const region = tag.split("-")[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : undefined;
}

function domBrowserTimeZone(): string | undefined {
  if (typeof Intl === "undefined") return undefined;
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === "string" && timeZone ? timeZone : undefined;
  } catch {
    return undefined;
  }
}

function setCaretAfterDigits(input: HTMLInputElement, target: number): void {
  if (target <= 0) return input.setSelectionRange(0, 0);
  const s = input.value;
  let seen = 0;
  let pos = s.length;
  for (let i = 0; i < s.length; i++) {
    if (/\d/.test(s[i]!) && ++seen === target) {
      pos = i + 1;
      break;
    }
  }
  input.setSelectionRange(pos, pos);
}

// positionPhonePopover + PHONE_POPOVER_VIEWPORT_GAP live in @usefillo/core so
// this renderer and @usefillo/react share one implementation.

/** Framework-agnostic phone field: country picker + national input → E.164. */
function phoneInput(context: FieldRenderContext): HTMLElement {
  const schema = context.field as PhoneField;
  let country: PhoneCountry =
    parsePhone(inputValue(context.value)).country ??
    countryByIso(schema.defaultCountry) ??
    countryByTimeZone(domBrowserTimeZone()) ??
    countryByIso(domLocaleCountry()) ??
    PHONE_COUNTRIES[0]!;

  const wrap = el("div", { className: "fillo-phone" });
  const countryWrap = el("div", { className: "fillo-phone-country" });
  const flagBtn = el("button", {
    className: "fillo-phone-flag",
    attrs: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
  });
  const flagSpan = el("span", {
    className: "fillo-phone-flag-emoji",
    attrs: { "aria-hidden": "true" },
  });
  const dialSpan = el("span", { className: "fillo-phone-dial" });
  appendChildren(flagBtn, [
    flagSpan,
    dialSpan,
    el("span", { className: "fillo-phone-caret", text: "▾", attrs: { "aria-hidden": "true" } }),
  ]);
  appendChildren(countryWrap, [flagBtn]);

  const input = el("input", {
    className: "fillo-input fillo-phone-input",
    attrs: {
      id: context.ids.inputId,
      type: "tel",
      inputmode: "tel",
      autocomplete: "tel-national",
      "data-fillo": "control",
    },
  });
  applyFieldAria(input, context.field, context.error, context.ids);

  // `context.value` is only a per-render snapshot — commits made with
  // `{ render: false }` (every keystroke here) never touch it, so reading it
  // mid-session returns stale digits (previously a real bug: the second
  // keystroke's reformat would overwrite the field with digits from BEFORE
  // the first keystroke, since the "live" value it reformatted from was the
  // pre-session snapshot — confirmed by typing multiple digits and watching
  // the display collapse back down each time). Read the engine's live value
  // instead, same idiom as the grouped-number blur handler above.
  const liveValue = () => (context as InternalFieldRenderContext).getValue?.() ?? context.value;
  const nationalFromValue = () => {
    const digits = digitsOnly(inputValue(liveValue()));
    return digits.startsWith(country.dialCode) ? digits.slice(country.dialCode.length) : digits;
  };
  const syncFlag = () => {
    flagSpan.textContent = flagEmoji(country.iso2);
    dialSpan.textContent = `+${country.dialCode}`;
    flagBtn.setAttribute("aria-label", `Country: ${country.name} (+${country.dialCode})`);
  };
  const syncInput = () => {
    input.value = formatNational(country, nationalFromValue());
    input.placeholder = formatNational(country, country.example);
  };
  const commit = (nat: string) =>
    context.setValue(nat ? toE164(country, nat) : "", { render: false });
  // Pending international entry (a "+" that hasn't resolved a country yet):
  // hold the raw text verbatim instead of running it through toE164, which
  // would corrupt it by gluing on the wrong/no-longer-relevant dial code.
  const commitRaw = (raw: string) => context.setValue(raw, { render: false });

  syncFlag();
  syncInput();

  input.addEventListener("input", () => {
    const raw = input.value;
    const caret = input.selectionStart ?? raw.length;
    const before = digitsOnly(raw.slice(0, caret)).length;
    if (raw.trimStart().startsWith("+")) {
      // previousDigits: the national digits already in the field before this
      // keystroke — lets parsePhone tell a genuine new international prefix
      // apart from a bare "+" just prepended to unchanged stale digits (core
      // P0.2: that used to silently reassign the country, e.g. an old
      // "55…" national number becoming Brazilian the moment "+" landed).
      const p = parsePhone(raw, country, { previousDigits: nationalFromValue() });
      if (p.pending) {
        // No country resolved yet: don't touch `country`, don't reformat
        // (there's nothing to format against), just hold what was typed.
        commitRaw(p.raw ?? raw);
        return;
      }
      if (p.country) {
        country = p.country;
        syncFlag();
      }
      commit(p.country ? p.national : digitsOnly(raw));
    } else {
      commit(digitsOnly(raw));
    }
    input.value = formatNational(country, nationalFromValue());
    setCaretAfterDigits(input, before);
  });

  // Country popover, built on demand.
  const registerOverlay = (context as InternalFieldRenderContext).registerOverlay;
  const announce = (context as InternalFieldRenderContext).announce;
  let popover: HTMLElement | null = null;
  let active = 0;
  // PHONE_PICKER_COUNTRIES (Intl.Collator-sorted display order) for the list
  // the respondent browses/searches — PHONE_COUNTRIES stays reserved for
  // dial-code RESOLUTION (parsePhone / the default-country fallback above),
  // whose priority order (curated markets first) must not shift.
  let matches: PhoneCountry[] = PHONE_PICKER_COUNTRIES;
  let stopPopoverLayout: (() => void) | null = null;
  let unregisterOverlay: (() => void) | null = null;
  // Debounced (~300ms) filter-count announcement — typing every keystroke
  // through a live region is spam; only the settled result count narrates.
  let resultsTimer: ReturnType<typeof setTimeout> | undefined;
  const listId = `${context.ids.inputId}-countries`;

  const syncPopoverLayout = () => {
    if (!popover) return;
    const placement = positionPhonePopover(countryWrap, popover);
    popover.classList.toggle("fillo-phone-popover--above", placement === "above");
    popover.classList.toggle("fillo-phone-popover--below", placement === "below");
  };
  const bindPopoverLayout = () => {
    stopPopoverLayout?.();
    const update = () => syncPopoverLayout();
    syncPopoverLayout();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    stopPopoverLayout = () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  };
  // Tab-away closes the popover (audit P1.8: it used to leave a stale
  // aria-expanded="true" behind). The containment check covers the whole
  // trigger+popover composite (mirrors @usefillo/react's wrapper onBlur), so
  // Shift+Tab back onto the trigger doesn't close it. relatedTarget isn't
  // populated everywhere, so fall back to a microtask activeElement check.
  const onFocusOut = (event: FocusEvent) => {
    const related = event.relatedTarget as Node | null;
    if (related) {
      if (!countryWrap.contains(related)) closePopover();
      return;
    }
    queueMicrotask(() => {
      if (popover && !countryWrap.contains(document.activeElement)) closePopover();
    });
  };
  const closePopover = () => {
    clearTimeout(resultsTimer);
    stopPopoverLayout?.();
    stopPopoverLayout = null;
    popover?.remove();
    popover = null;
    flagBtn.setAttribute("aria-expanded", "false");
    flagBtn.removeAttribute("aria-controls");
    document.removeEventListener("mousedown", onOutside);
    countryWrap.removeEventListener("focusout", onFocusOut);
    unregisterOverlay?.();
    unregisterOverlay = null;
  };
  const onOutside = (e: MouseEvent) => {
    if (!countryWrap.contains(e.target as Node)) closePopover();
  };
  const pick = (c: PhoneCountry | undefined) => {
    if (!c) return;
    country = c;
    syncFlag();
    commit(nationalFromValue());
    syncInput();
    closePopover();
    // Selection commits focus straight to the national input (deliberate
    // deviation from APG's return-to-trigger, documented in the contract),
    // so nothing else announces the pick — the live region does instead.
    announce?.(DEFAULT_FIELD_STRINGS.phoneCountrySelected(c.name));
    input.focus();
  };

  const openPopover = (seed?: string) => {
    const pop = el("div", { className: "fillo-phone-popover fillo-phone-popover--below" });
    const search = el("input", {
      className: "fillo-phone-search",
      attrs: {
        type: "text",
        role: "combobox",
        "aria-expanded": "true",
        "aria-controls": listId,
        "aria-autocomplete": "list",
        "aria-label": "Search country or code",
        placeholder: "Search country or code",
      },
    });
    if (seed) search.value = seed;
    const list = el("ul", {
      className: "fillo-phone-list",
      attrs: { role: "listbox", id: listId, "aria-label": "Country" },
    });

    const renderList = () => {
      list.replaceChildren();
      if (matches.length === 0) {
        // A listbox's children must all be role="option" (audit P2.7/spec
        // §7) — aria-disabled marks it non-activatable instead of omitting
        // the role.
        list.appendChild(
          el("li", {
            className: "fillo-phone-empty",
            text: "No matches",
            attrs: { role: "option", "aria-disabled": "true" },
          }),
        );
        // No option exists for the index to reference — an empty list must
        // not leave a dangling aria-activedescendant pointing at nothing.
        search.removeAttribute("aria-activedescendant");
        syncPopoverLayout();
        return;
      }
      matches.forEach((c, i) => {
        const li = el("li", {
          className: `fillo-phone-option${i === active ? " fillo-phone-option--active" : ""}`,
          attrs: {
            id: `${listId}-opt-${i}`,
            role: "option",
            "aria-selected": String(c.iso2 === country.iso2),
          },
        });
        appendChildren(li, [
          el("span", {
            className: "fillo-phone-flag-emoji",
            text: flagEmoji(c.iso2),
            attrs: { "aria-hidden": "true" },
          }),
          el("span", { className: "fillo-phone-option-name", text: c.name }),
          el("span", { className: "fillo-phone-option-dial", text: `+${c.dialCode}` }),
        ]);
        li.addEventListener("mouseenter", () => {
          active = i;
          search.setAttribute("aria-activedescendant", li.id);
          syncActive();
        });
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(c);
        });
        list.appendChild(li);
      });
      search.setAttribute("aria-activedescendant", `${listId}-opt-${active}`);
      syncPopoverLayout();
    };
    const syncActive = () => {
      [...list.children].forEach((li, i) =>
        li.classList.toggle("fillo-phone-option--active", i === active),
      );
      document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
    };

    const filter = (q: string) => {
      const query = q.trim().toLowerCase();
      const qDigits = query.replace(/[^\d]/g, "");
      matches = !query
        ? PHONE_PICKER_COUNTRIES
        : PHONE_PICKER_COUNTRIES.filter(
            (c) =>
              c.name.toLowerCase().includes(query) ||
              c.iso2.toLowerCase() === query ||
              (qDigits.length > 0 && c.dialCode.startsWith(qDigits)),
          );
      active = 0;
      renderList();
      // Debounced (~300ms): announce the settled count, not every keystroke.
      clearTimeout(resultsTimer);
      resultsTimer = setTimeout(
        () => announce?.(DEFAULT_FIELD_STRINGS.phoneResultsCount(matches.length)),
        300,
      );
    };

    search.addEventListener("input", () => filter(search.value));
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (matches.length === 0) return;
        active = Math.min(active + 1, matches.length - 1);
        syncActive();
        search.setAttribute("aria-activedescendant", `${listId}-opt-${active}`);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (matches.length === 0) return;
        active = Math.max(active - 1, 0);
        syncActive();
        search.setAttribute("aria-activedescendant", `${listId}-opt-${active}`);
      } else if (e.key === "Enter") {
        e.preventDefault();
        pick(matches[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePopover();
        flagBtn.focus();
      }
    });

    appendChildren(pop, [search, list]);
    popover = pop;
    countryWrap.appendChild(pop);
    flagBtn.setAttribute("aria-expanded", "true");
    flagBtn.setAttribute("aria-controls", listId);
    if (seed) {
      filter(seed);
    } else {
      matches = PHONE_PICKER_COUNTRIES;
      active = Math.max(0, PHONE_PICKER_COUNTRIES.indexOf(country));
      renderList();
    }
    bindPopoverLayout();
    syncActive();
    document.addEventListener("mousedown", onOutside);
    countryWrap.addEventListener("focusout", onFocusOut);
    // Let the controller close us (and drop our global listeners) if the form
    // re-renders or unmounts while we're open.
    unregisterOverlay = registerOverlay?.(closePopover) ?? null;
    requestAnimationFrame(() => {
      search.focus();
      if (seed) {
        const end = search.value.length;
        search.setSelectionRange(end, end);
      }
    });
  };

  flagBtn.addEventListener("click", () => (popover ? closePopover() : openPopover()));
  // Closed-state keyboard map (audit P1.8 — APG's select-only combobox
  // baseline, adapted per the contract's disclosure-button-+-filterable-
  // listbox amendment): Enter/Space already open via the native button
  // click; add ArrowDown/Up, and a printable character both opens the
  // popover and seeds the filter with it (typeahead-opens), matching a
  // native combobox.
  flagBtn.addEventListener("keydown", (event) => {
    if (popover) return; // already open — the popover's own handlers apply
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openPopover();
      return;
    }
    if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      openPopover(event.key);
    }
  });

  appendChildren(wrap, [countryWrap, input]);
  return shell(context.field, context.error, wrap, context.ids);
}

function longText(context: FieldRenderContext): HTMLElement {
  const textarea = el("textarea", {
    className: "fillo-input fillo-textarea",
    attrs: { id: context.ids.inputId, rows: "4", "data-fillo": "control" },
  });
  textarea.value = typeof context.value === "string" ? context.value : "";
  if (context.field.placeholder) textarea.placeholder = context.field.placeholder;
  if ("maxLength" in context.field && context.field.maxLength !== undefined) {
    textarea.maxLength = context.field.maxLength;
  }
  textarea.addEventListener("input", () => context.setValue(textarea.value, { render: false }));
  textarea.addEventListener("change", () => context.setValue(textarea.value));
  applyFieldAria(textarea, context.field, context.error, context.ids);
  return shell(context.field, context.error, textarea, context.ids);
}

function singleChoice(context: FieldRenderContext): HTMLElement {
  const field = context.field as ChoiceField;
  const options = displayOptions(field);
  const value = typeof context.value === "string" ? context.value : "";
  const activeOtherFields = (context as InternalFieldRenderContext).activeOtherFields;
  const isOther = value !== "" && !field.options.some((option) => option.id === value);
  const otherActive = isOther || (value === "" && activeOtherFields?.has(field.id) === true);
  const wrap = el("div", {
    className: "fillo-options",
    attrs: { role: "radiogroup", "aria-labelledby": context.ids.labelId, "data-fillo": "options" },
  });
  applyFieldAria(wrap, field, context.error, context.ids);

  for (const option of options) {
    const label = el("label", {
      className: `fillo-option${option.icon ? " fillo-option--has-icon" : ""}${
        value === option.id ? " fillo-option--selected" : ""
      }`,
      attrs: { "data-option": option.id, "data-fillo": "option" },
    });
    label.toggleAttribute("data-selected", value === option.id);
    const input = el("input", {
      className: "fillo-option-input",
      attrs: { type: "radio", name: context.ids.name },
    });
    input.checked = value === option.id;
    input.addEventListener("change", () => {
      activeOtherFields?.delete(field.id);
      context.setValue(option.id);
    });
    appendChildren(label, [
      input,
      optionIcon(option.icon),
      el("span", {
        className: "fillo-option-label",
        text: option.label,
        attrs: { "data-fillo": "optionLabel" },
      }),
      // Icon-mode hides the native input visually (CSS), so an SVG recolor
      // was the only selected-state signal — add a decorative shape signal
      // that survives forced-colors (audit P1.2; state still lives on the
      // input, this marker is non-authoritative).
      option.icon && value === option.id
        ? el("span", {
            className: "fillo-option-check",
            text: "✓",
            attrs: { "aria-hidden": "true" },
          })
        : null,
    ]);
    wrap.appendChild(label);
  }

  if (field.allowOther) {
    const label = el("label", {
      className: `fillo-option fillo-option--other${otherActive ? " fillo-option--selected fillo-option--with-other" : ""}`,
      attrs: { "data-fillo": "option" },
    });
    label.toggleAttribute("data-selected", otherActive);
    const input = el("input", {
      className: "fillo-option-input",
      attrs: { type: "radio", name: context.ids.name },
    });
    input.checked = otherActive;
    input.addEventListener("change", () => {
      activeOtherFields?.add(field.id);
      context.setValue("", { render: true });
    });
    appendChildren(label, [
      appendChildren(el("span", { className: "fillo-option-main" }), [
        input,
        el("span", {
          className: "fillo-option-label",
          text: DEFAULT_STRINGS.other,
          attrs: { "data-fillo": "optionLabel" },
        }),
      ]),
    ]);
    if (otherActive) {
      const other = el("input", {
        className: "fillo-input fillo-other-input",
        attrs: { type: "text", "aria-label": DEFAULT_STRINGS.otherPrompt },
      });
      other.value = isOther ? value : "";
      other.placeholder = DEFAULT_STRINGS.otherPlaceholder;
      other.addEventListener("input", () => {
        activeOtherFields?.add(field.id);
        context.setValue(other.value, { render: false });
      });
      other.addEventListener("change", () => {
        activeOtherFields?.add(field.id);
        context.setValue(other.value);
      });
      label.appendChild(other);
      if (!isOther) queueMicrotask(() => other.focus());
    }
    wrap.appendChild(label);
  }

  return shell(field, context.error, wrap, context.ids);
}

function multiChoice(context: FieldRenderContext): HTMLElement {
  const field = context.field as ChoiceField;
  const options = displayOptions(field);
  const selected = Array.isArray(context.value) ? (context.value as string[]) : [];
  const knownIds = new Set(field.options.map((option) => option.id));
  const otherText = selected.find((value) => !knownIds.has(value));
  const activeOtherFields = (context as InternalFieldRenderContext).activeOtherFields;
  const getSelected = () => {
    const current = (context as InternalFieldRenderContext).getValue?.() ?? context.value;
    return Array.isArray(current) ? (current as string[]) : [];
  };
  const wrap = el("div", {
    className: "fillo-options",
    attrs: { role: "group", "aria-labelledby": context.ids.labelId, "data-fillo": "options" },
  });
  applyFieldAria(wrap, field, context.error, context.ids, { requiredSupported: false });

  const setSelected = (next: string[]) => context.setValue(next);
  for (const option of options) {
    const label = el("label", {
      className: `fillo-option${option.icon ? " fillo-option--has-icon" : ""}${
        selected.includes(option.id) ? " fillo-option--selected" : ""
      }`,
      attrs: { "data-option": option.id, "data-fillo": "option" },
    });
    label.toggleAttribute("data-selected", selected.includes(option.id));
    const input = el("input", { className: "fillo-option-input", attrs: { type: "checkbox" } });
    input.checked = selected.includes(option.id);
    input.addEventListener("change", () => {
      const current = getSelected();
      setSelected(
        input.checked ? [...current, option.id] : current.filter((id) => id !== option.id),
      );
    });
    appendChildren(label, [
      input,
      optionIcon(option.icon),
      el("span", {
        className: "fillo-option-label",
        text: option.label,
        attrs: { "data-fillo": "optionLabel" },
      }),
      option.icon && selected.includes(option.id)
        ? el("span", {
            className: "fillo-option-check",
            text: "✓",
            attrs: { "aria-hidden": "true" },
          })
        : null,
    ]);
    wrap.appendChild(label);
  }

  if (field.allowOther) {
    const active = otherText !== undefined || activeOtherFields?.has(field.id) === true;
    const label = el("label", {
      className: `fillo-option fillo-option--other${active ? " fillo-option--selected fillo-option--with-other" : ""}`,
      attrs: { "data-fillo": "option" },
    });
    label.toggleAttribute("data-selected", active);
    const input = el("input", { className: "fillo-option-input", attrs: { type: "checkbox" } });
    input.checked = active;
    input.addEventListener("change", () => {
      const rest = getSelected().filter((value) => knownIds.has(value));
      if (input.checked) {
        activeOtherFields?.add(field.id);
        setSelected(rest);
      } else {
        activeOtherFields?.delete(field.id);
        setSelected(rest);
      }
    });
    appendChildren(label, [
      appendChildren(el("span", { className: "fillo-option-main" }), [
        input,
        el("span", {
          className: "fillo-option-label",
          text: DEFAULT_STRINGS.other,
          attrs: { "data-fillo": "optionLabel" },
        }),
      ]),
    ]);
    if (active) {
      const other = el("input", {
        className: "fillo-input fillo-other-input",
        attrs: { type: "text", "aria-label": DEFAULT_STRINGS.otherPrompt },
      });
      other.value = otherText ?? "";
      other.placeholder = DEFAULT_STRINGS.otherPlaceholder;
      other.addEventListener("input", () => {
        activeOtherFields?.add(field.id);
        const rest = getSelected().filter((value) => knownIds.has(value));
        context.setValue(other.value ? [...rest, other.value] : rest, { render: false });
      });
      other.addEventListener("change", () => {
        activeOtherFields?.add(field.id);
        const rest = getSelected().filter((value) => knownIds.has(value));
        context.setValue(other.value ? [...rest, other.value] : rest);
      });
      label.appendChild(other);
      if (otherText === undefined) queueMicrotask(() => other.focus());
    }
    wrap.appendChild(label);
  }

  return shell(field, context.error, wrap, context.ids);
}

function otherValue(field: ChoiceField): string {
  let value = "__fillo_other__";
  const ids = new Set(field.options.map((option) => option.id));
  while (ids.has(value)) value += "_";
  return value;
}

function dropdown(context: FieldRenderContext): HTMLElement {
  const field = context.field as ChoiceField;
  const value = typeof context.value === "string" ? context.value : "";
  const other = otherValue(field);
  const activeOtherFields = (context as InternalFieldRenderContext).activeOtherFields;
  const isOther = value !== "" && !field.options.some((option) => option.id === value);
  const otherActive = isOther || (value === "" && activeOtherFields?.has(field.id) === true);
  const wrap = el("div");
  const selectWrap = el("div", { className: "fillo-select-wrap" });
  const select = el("select", {
    className: "fillo-input fillo-select",
    attrs: { id: context.ids.inputId, "data-fillo": "control" },
  });
  select.appendChild(
    el("option", { text: field.placeholder ?? "Choose...", attrs: { value: "" } }),
  );
  for (const option of displayOptions(field)) {
    select.appendChild(el("option", { text: option.label, attrs: { value: option.id } }));
  }
  if (field.allowOther)
    select.appendChild(
      el("option", { text: `${DEFAULT_STRINGS.other}…`, attrs: { value: other } }),
    );
  select.value = otherActive ? other : value;
  select.addEventListener("change", () => {
    if (select.value === other) {
      activeOtherFields?.add(field.id);
      context.setValue("", { render: true });
    } else {
      activeOtherFields?.delete(field.id);
      context.setValue(select.value || null);
    }
  });
  applyFieldAria(select, field, context.error, context.ids);
  appendChildren(selectWrap, [
    select,
    el("span", { className: "fillo-select-icon", attrs: { "aria-hidden": "true" } }),
  ]);
  wrap.appendChild(selectWrap);
  if (otherActive) {
    const other = el("input", {
      className: "fillo-input fillo-other-input fillo-other-input--block",
      attrs: { type: "text", "aria-label": DEFAULT_STRINGS.otherPrompt },
    });
    other.value = isOther ? value : "";
    other.placeholder = DEFAULT_STRINGS.otherPlaceholder;
    other.addEventListener("input", () => {
      activeOtherFields?.add(field.id);
      context.setValue(other.value, { render: false });
    });
    other.addEventListener("change", () => {
      activeOtherFields?.add(field.id);
      context.setValue(other.value);
    });
    wrap.appendChild(other);
    if (!isOther) queueMicrotask(() => other.focus());
  }
  return shell(field, context.error, wrap, context.ids);
}

function checkbox(context: FieldRenderContext): HTMLElement {
  if (context.field.kind === "checkbox" && context.field.appearance === "toggle") {
    const wrap = el("div", {
      className: `fillo-field fillo-field--checkbox fillo-field--toggle${context.error ? " fillo-field--error" : ""}`,
      attrs: {
        "data-fillo": "field",
        "data-field": context.field.id,
        "data-kind": context.field.kind,
      },
    });
    wrap.toggleAttribute("data-invalid", Boolean(context.error));
    wrap.toggleAttribute("data-required", Boolean(context.field.required));
    const label = el("label", { className: "fillo-toggle", attrs: { "data-fillo": "option" } });
    label.toggleAttribute("data-checked", context.value === true);
    const labelText = el("span", {
      className: "fillo-option-label",
      text: context.field.label,
      attrs: { "data-fillo": "optionLabel" },
    });
    if (!context.field.required)
      labelText.appendChild(el("span", { className: "fillo-optional", text: " (optional)" }));
    const copy = el("span", { className: "fillo-toggle-copy" });
    copy.appendChild(labelText);
    // Native checkbox semantics (audit P2.5): this is an answer field, not an
    // immediate-effect control, so it drops role="switch" and its aria-checked
    // management — the pill CSS/class stays untouched.
    const input = el("input", {
      className: "fillo-toggle-input",
      attrs: {
        id: context.ids.inputId,
        type: "checkbox",
      },
    });
    input.checked = context.value === true;
    input.addEventListener("change", () => {
      context.setValue(input.checked);
    });
    applyFieldAria(input, context.field, context.error, context.ids);
    appendChildren(label, [
      copy,
      input,
      appendChildren(
        el("span", { className: "fillo-toggle-track", attrs: { "aria-hidden": "true" } }),
        [el("span", { className: "fillo-toggle-thumb" })],
      ),
    ]);
    wrap.appendChild(label);
    if (context.field.description)
      wrap.appendChild(
        el("p", {
          className: "fillo-description",
          text: context.field.description,
          attrs: { id: context.ids.descriptionId, "data-fillo": "fieldDescription" },
        }),
      );
    if (context.error)
      wrap.appendChild(
        el("p", {
          className: "fillo-error",
          text: context.error,
          attrs: { id: context.ids.errorId, "data-fillo": "error" },
        }),
      );
    return wrap;
  }

  const wrap = el("div", {
    className: `fillo-field fillo-field--checkbox${context.error ? " fillo-field--error" : ""}`,
    attrs: {
      "data-fillo": "field",
      "data-field": context.field.id,
      "data-kind": context.field.kind,
    },
  });
  wrap.toggleAttribute("data-invalid", Boolean(context.error));
  wrap.toggleAttribute("data-required", Boolean(context.field.required));
  const label = el("label", { className: "fillo-option", attrs: { "data-fillo": "option" } });
  label.toggleAttribute("data-checked", context.value === true);
  const input = el("input", {
    className: "fillo-option-input",
    attrs: { id: context.ids.inputId, type: "checkbox" },
  });
  input.checked = context.value === true;
  input.addEventListener("change", () => context.setValue(input.checked));
  applyFieldAria(input, context.field, context.error, context.ids);
  const labelText = el("span", {
    className: "fillo-option-label",
    text: context.field.label,
    attrs: { "data-fillo": "optionLabel" },
  });
  if (!context.field.required)
    labelText.appendChild(el("span", { className: "fillo-optional", text: " (optional)" }));
  appendChildren(label, [input, labelText]);
  wrap.appendChild(label);
  if (context.field.description)
    wrap.appendChild(
      el("p", {
        className: "fillo-description",
        text: context.field.description,
        attrs: { id: context.ids.descriptionId, "data-fillo": "fieldDescription" },
      }),
    );
  if (context.error)
    wrap.appendChild(
      el("p", {
        className: "fillo-error",
        text: context.error,
        attrs: { id: context.ids.errorId, "data-fillo": "error" },
      }),
    );
  return wrap;
}

function rating(context: FieldRenderContext): HTMLElement {
  if (context.field.kind !== "rating") return el("div");
  const max = typeof context.field.max === "number" ? context.field.max : 5;
  const current = typeof context.value === "number" ? context.value : 0;
  const values = Array.from({ length: max }, (_, index) => index + 1);
  const selected = current > 0 ? current : null;
  const tabbable = selected === null ? 0 : Math.max(0, values.indexOf(selected));
  const wrap = el("div", {
    className: "fillo-rating",
    attrs: {
      id: context.ids.inputId,
      role: "radiogroup",
      "aria-labelledby": context.ids.labelId,
      "data-fillo": "control",
    },
  });
  applyFieldAria(wrap, context.field, context.error, context.ids);
  for (const [index, n] of values.entries()) {
    const button = el("button", {
      className: `fillo-star${n <= current ? " fillo-star--active" : ""}`,
      // Shape signal, not just color, so the selected state survives
      // forced-colors (audit P1.2): filled "★" once selected, hollow "☆"
      // otherwise.
      text: n <= current ? "★" : "☆",
      attrs: {
        type: "button",
        role: "radio",
        "aria-label": `${n} of ${max}`,
        "aria-checked": String(n === current),
        tabindex: String(index === tabbable ? 0 : -1),
        "data-fillo": "option",
      },
    });
    button.toggleAttribute("data-selected", n <= current);
    button.addEventListener("click", (event) => {
      // Space/Enter activation dispatches a click with detail 0 — an
      // already-checked value is a no-op on keyboard (APG); pointer
      // click-again (detail >= 1) still clears it.
      if (event.detail === 0 && n === current) return;
      context.setValue(n === current ? null : n);
    });
    wrap.appendChild(button);
  }
  bindRadioKeys(wrap, values, selected, (value) => context.setValue(value));
  return shell(context.field, context.error, wrap, context.ids);
}

function linearScale(context: FieldRenderContext): HTMLElement {
  if (context.field.kind !== "linear_scale") return el("div");
  const min = typeof context.field.min === "number" ? context.field.min : 1;
  const max = typeof context.field.max === "number" ? context.field.max : 10;
  const current = typeof context.value === "number" ? context.value : null;
  const values = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  const tabbable = current === null ? 0 : Math.max(0, values.indexOf(current));
  const minLabelId = `${context.ids.inputId}-min`;
  const maxLabelId = `${context.ids.inputId}-max`;
  const wrap = el("div");
  const steps = el("div", {
    className: "fillo-scale",
    attrs: {
      id: context.ids.inputId,
      role: "radiogroup",
      "aria-labelledby": context.ids.labelId,
      "data-fillo": "control",
    },
  });
  applyFieldAria(steps, context.field, context.error, context.ids);
  const describedBy = [
    context.field.minLabel ? minLabelId : null,
    context.field.maxLabel ? maxLabelId : null,
    steps.getAttribute("aria-describedby"),
  ]
    .filter(Boolean)
    .join(" ");
  if (describedBy) steps.setAttribute("aria-describedby", describedBy);
  for (const [index, n] of values.entries()) {
    const button = el("button", {
      className: `fillo-scale-step${context.value === n ? " fillo-scale-step--active" : ""}`,
      text: String(n),
      attrs: {
        type: "button",
        role: "radio",
        "aria-label": String(n),
        "aria-checked": String(context.value === n),
        tabindex: String(index === tabbable ? 0 : -1),
        "data-fillo": "option",
      },
    });
    button.toggleAttribute("data-selected", context.value === n);
    button.addEventListener("click", (event) => {
      // Same keyboard-no-op/pointer-clears split as rating (contract
      // amendment: "keyboard activation on an already-checked value is a
      // no-op").
      if (event.detail === 0 && context.value === n) return;
      context.setValue(context.value === n ? null : n);
    });
    steps.appendChild(button);
  }
  bindRadioKeys(steps, values, current, (value) => context.setValue(value));
  wrap.appendChild(steps);
  if ("minLabel" in context.field || "maxLabel" in context.field) {
    appendChildren(wrap, [
      appendChildren(el("div", { className: "fillo-scale-labels" }), [
        el("span", { text: String(context.field.minLabel ?? ""), attrs: { id: minLabelId } }),
        el("span", { text: String(context.field.maxLabel ?? ""), attrs: { id: maxLabelId } }),
      ]),
    ]);
  }
  return shell(context.field, context.error, wrap, context.ids);
}

function ranking(context: FieldRenderContext): HTMLElement | null {
  const field = context.field;
  if (field.kind !== "ranking") return null;
  const announce = (context as InternalFieldRenderContext).announce;
  const answered = Array.isArray(context.value) ? (context.value as string[]) : [];
  const order = [
    ...answered.filter((id) => field.options.some((option) => option.id === id)),
    ...field.options.map((option) => option.id).filter((id) => !answered.includes(id)),
  ];
  const group = el("div", {
    attrs: {
      id: context.ids.inputId,
      role: "group",
      "aria-labelledby": context.ids.labelId,
      "data-fillo": "control",
    },
  });
  applyFieldAria(group, context.field, context.error, context.ids, { requiredSupported: false });
  const list = el("ol", { className: "fillo-ranking" });
  for (const [index, id] of order.entries()) {
    const option = field.options.find((item) => item.id === id);
    if (!option) continue;
    const item = el("li", { className: "fillo-ranking-item" });
    const controls = el("span", { className: "fillo-ranking-controls" });
    const move = (delta: number) => {
      const target = index + delta;
      if (target < 0 || target >= order.length) return;
      const next = [...order];
      [next[index], next[target]] = [next[target]!, next[index]!];
      context.setValue(next);
      // Contract: a polite live region announces "«label», position n of m"
      // after a move (audit P1.5's missing piece).
      announce?.(DEFAULT_FIELD_STRINGS.rankingPosition(option.label, target + 1, order.length));
    };
    // Stable per-option ids so focus can follow the moved option across the
    // re-render a reorder triggers (a plain positional restore would strand
    // focus on whichever option swapped into the old slot).
    const up = el("button", {
      className: "fillo-ranking-move",
      text: "↑",
      attrs: {
        type: "button",
        "data-fillo-rank-opt": id,
        "data-fillo-rank-dir": "up",
        // Per-row label (audit P1.5 [D]: every row read "Up"/"Down" alike);
        // wording matches @usefillo/react's.
        "aria-label": `Move ${option.label} up`,
      },
    });
    up.toggleAttribute("disabled", index === 0);
    up.addEventListener("click", () => move(-1));
    const down = el("button", {
      className: "fillo-ranking-move",
      text: "↓",
      attrs: {
        type: "button",
        "data-fillo-rank-opt": id,
        "data-fillo-rank-dir": "down",
        "aria-label": `Move ${option.label} down`,
      },
    });
    down.toggleAttribute("disabled", index === order.length - 1);
    down.addEventListener("click", () => move(1));
    appendChildren(controls, [up, down]);
    appendChildren(item, [
      el("span", { className: "fillo-ranking-index", text: String(index + 1) }),
      el("span", { className: "fillo-ranking-label", text: option.label }),
      controls,
    ]);
    list.appendChild(item);
  }
  group.appendChild(list);
  return shell(context.field, context.error, group, context.ids);
}

function matrix(context: FieldRenderContext): HTMLElement | null {
  const field = context.field;
  if (field.kind !== "matrix") return null;
  const answers = (
    context.value && typeof context.value === "object" && !Array.isArray(context.value)
      ? context.value
      : {}
  ) as Record<string, string>;
  const table = el("table", { className: "fillo-matrix" });
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  // The corner above the row-label column names nothing — a <th> here is an
  // empty header (axe empty-table-header, ledger #2); HTML-AAM/APG's fix is
  // a plain <td>, not a labeled th (there's no label to give it).
  headRow.appendChild(document.createElement("td"));
  for (const col of field.columns)
    headRow.appendChild(el("th", { text: col.label, attrs: { scope: "col" } }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of field.rows) {
    const rowLabelId = `${context.ids.inputId}-${row.id}`;
    const answered = answers[row.id] !== undefined;
    // A required row is invalid only once it's been left unanswered and the
    // field has surfaced an error (mirrors @usefillo/react's Matrix).
    const rowInvalid = Boolean(context.error) && Boolean(field.required) && !answered;
    const radioId = (col: SelectOption) => `${context.ids.inputId}-${row.id}-${col.id}`;
    const tr = document.createElement("tr");
    const th = el("th", { attrs: { scope: "row" } });
    // The row's radiogroup lives on an element inside the <th> — the radios
    // themselves are scattered across sibling <td> cells and reached via
    // aria-owns, since they can't be DOM-nested inside a single element
    // within a table row (audit P1.9). Labelled by BOTH the field label and
    // the row header so AT announces "<field label>, <row label>".
    const rowGroup = el("div", {
      attrs: {
        role: "radiogroup",
        "aria-labelledby": `${context.ids.labelId} ${rowLabelId}`,
        "aria-owns": field.columns.map(radioId).join(" "),
      },
    });
    rowGroup.appendChild(el("span", { text: row.label, attrs: { id: rowLabelId } }));
    th.appendChild(rowGroup);
    tr.appendChild(th);
    for (const col of field.columns) {
      // data-label feeds the narrow-viewport stacked layout (::before content);
      // the label wrapper fills the cell as one pointer target (audit P1.3).
      const td = el("td", { attrs: { "data-label": col.label } });
      const cellLabel = el("label", { className: "fillo-matrix-cell" });
      const input = el("input", {
        className: "fillo-option-input",
        attrs: {
          id: radioId(col),
          type: "radio",
          name: `${context.ids.name}-${row.id}`,
          "aria-label": `${row.label}: ${col.label}`,
        },
      });
      if (field.required) input.setAttribute("aria-required", "true");
      if (rowInvalid) input.setAttribute("aria-invalid", "true");
      input.checked = answers[row.id] === col.id;
      input.addEventListener("change", () => context.setValue({ ...answers, [row.id]: col.id }));
      cellLabel.appendChild(input);
      td.appendChild(cellLabel);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const group = el("div", {
    className: "fillo-matrix-wrap",
    attrs: {
      id: context.ids.inputId,
      role: "group",
      "aria-labelledby": context.ids.labelId,
      "data-fillo": "control",
    },
  });
  applyFieldAria(group, context.field, context.error, context.ids, { requiredSupported: false });
  group.appendChild(table);
  return shell(context.field, context.error, group, context.ids);
}

function signature(context: FieldRenderContext): HTMLElement {
  const wrap = el("div", { className: "fillo-signature-field" });
  const pad = el("div", { className: "fillo-signature", attrs: { "data-fillo": "control" } });
  // A <canvas> isn't a labelable element and isn't reachable by keyboard, so
  // drawing on it is a pointer-only enhancement — the type-to-sign text input
  // below is the keyboard path, and carries the field id so the shell's
  // <label for> lands on it. The canvas itself now exposes an accessible
  // name/state (role="img" + a live aria-label, audit P1.6) instead of being
  // aria-hidden, so AT can hear "signed"/"empty" even without using the
  // typed-name path (e.g. a restored draft signed by drawing).
  const canvas = el("canvas", {
    className: "fillo-signature-canvas",
    attrs: { role: "img" },
  });
  const clear = el("button", {
    className: "fillo-signature-clear",
    text: "Clear",
    attrs: { type: "button" },
  });
  const hint = el("div", {
    className: "fillo-signature-hint",
    text: "Sign here",
    attrs: { "aria-hidden": "true" },
  });
  canvas.width = 720;
  canvas.height = 220;
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let hasInk = typeof context.value === "string" && context.value.startsWith("data:image/");
  const syncSignatureLabel = () => {
    canvas.setAttribute(
      "aria-label",
      hasInk ? DEFAULT_FIELD_STRINGS.signatureSigned : DEFAULT_FIELD_STRINGS.signatureEmpty,
    );
  };
  syncSignatureLabel();

  // Repaint a stored signature (page nav, or another field re-rendering the form).
  if (hasInk && ctx) {
    const image = new Image();
    image.onload = () => ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = String(context.value);
    hint.style.display = "none";
  }

  const typed = el("input", {
    className: "fillo-input fillo-signature-type-input",
    attrs: {
      id: context.ids.inputId,
      type: "text",
      autocomplete: "name",
    },
  });
  applyFieldAria(typed, context.field, context.error, context.ids);

  // Keyboard/screen-reader path: render the typed name onto the same canvas so
  // the stored value is always a PNG data URL, whichever method was used.
  const drawTyped = (text: string) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (text.trim()) {
      ctx.fillStyle = getComputedStyle(canvas).color || "#18181b";
      ctx.font = `italic ${Math.min(96, canvas.height * 0.45)}px "Segoe Script", "Brush Script MT", cursive`;
      ctx.textBaseline = "middle";
      ctx.fillText(text, 24, canvas.height / 2);
      hasInk = true;
      hint.style.display = "none";
      // render:false — like text inputs, keep the canvas pixels instead of
      // rebuilding the field on every keystroke.
      context.setValue(canvas.toDataURL("image/png"), { render: false });
    } else {
      hasInk = false;
      hint.style.display = "";
      context.setValue(null, { render: false });
    }
    syncSignatureLabel();
  };
  typed.addEventListener("input", () => drawTyped(typed.value));

  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (!ctx) return;
    drawing = true;
    hasInk = true;
    hint.style.display = "none";
    syncSignatureLabel();
    // Drawing supersedes a typed name — clear the input so the two paths don't
    // visually contradict each other.
    if (typed.value) typed.value = "";
    canvas.setPointerCapture(event.pointerId);
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drawing || !ctx) return;
    const p = point(event);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.strokeStyle = getComputedStyle(canvas).color || "#18181b";
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    // render:false so lifting the pen doesn't rebuild (and blank) the canvas.
    if (hasInk) context.setValue(canvas.toDataURL("image/png"), { render: false });
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  clear.addEventListener("click", () => {
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    hint.style.display = "";
    typed.value = "";
    syncSignatureLabel();
    context.setValue(null, { render: false });
  });
  appendChildren(pad, [canvas, hint, clear]);
  const typeWrap = el("div", { className: "fillo-signature-type" });
  // Persistent visible instructional label (ported from @usefillo/react —
  // audit P1.6: a placeholder alone disappears once typing starts and isn't
  // a substitute for a label).
  const typeLabel = el("label", {
    className: "fillo-signature-type-label",
    text: "Or type your full name to sign",
    attrs: { for: context.ids.inputId },
  });
  appendChildren(typeWrap, [typeLabel, typed]);
  appendChildren(wrap, [pad, typeWrap]);
  return shell(context.field, context.error, wrap, context.ids);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** One upload-row action — a single reset so `.fillo-file-remove` and
 *  `.fillo-file-retry` (react's classes, audit P0.3) are the only things that
 *  differ between icon-only and text call sites. */
function uploadSvg(paths: string[], size = 22): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "fillo-file-state-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function fileStateIcon(state: "uploading" | "done" | "failed"): HTMLElement {
  const mark = el("span", {
    className: `fillo-file-state fillo-file-state--${state}`,
    attrs: { "aria-hidden": "true" },
  });
  mark.appendChild(
    state === "done"
      ? uploadSvg([
          "M3.75 12a8.25 8.25 0 1 0 16.5 0 8.25 8.25 0 1 0-16.5 0",
          "m8.5 12 2.25 2.25 4.75-5",
        ])
      : state === "failed"
        ? uploadSvg([
            "M3.75 12a8.25 8.25 0 1 0 16.5 0 8.25 8.25 0 1 0-16.5 0",
            "M12 7.75v5.5",
            "M12 16.5h.01",
          ])
        : uploadSvg(["M7.25 3.75h6.5l3 3v13.5h-9.5z", "M13.75 3.75v3h3"]),
  );
  return mark;
}

function closeIcon(): SVGSVGElement {
  const icon = uploadSvg(["m7 7 10 10M17 7 7 17"], 16);
  icon.setAttribute("class", "fillo-file-action-icon");
  return icon;
}

function fileActionBtn(
  className: string,
  label: string,
  content: string | SVGSVGElement,
  onClick: () => void,
): HTMLButtonElement {
  const btn = el("button", { className, attrs: { type: "button", "aria-label": label } });
  btn.append(content);
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * An activatable dropzone (Enter/Space, drag & drop, click-to-browse — react's
 * exact pattern, upload.tsx ~200-249, ported here for renderer parity: this
 * package used to expose only a bare, always-visible native input, ledger #3)
 * wrapping the native picker, plus a per-file `<ul class="fillo-files">`
 * (audit P0.3 — ported from react's InFlight[] structure). Done files come
 * from `context.value`; in-flight/failed rows come from the controller.
 * Progress ticks mutate the row in place (render:false) — only start/finish/
 * fail triggers a full re-render.
 */
function fileUpload(context: FieldRenderContext): HTMLElement | null {
  const field = context.field;
  if (field.kind !== "file_upload") return null;
  const internal = context as InternalFieldRenderContext;
  const uploadDisabledReason = internal.uploadDisabledReason;
  const canUpload = uploadDisabledReason === undefined;
  const maxFiles = field.maxFiles ?? 1;
  const maxMb = field.maxFileSizeMb ?? 500;

  const done = Array.isArray(context.value) ? (context.value as FileValue[]) : [];
  const rows = internal.uploadRows ?? [];
  // Room left in the field right now — gates whether the dropzone/input show
  // at all (react parity: a full field hides the entry point entirely, same
  // as the label's `for` target then pointing at nothing) and whether a
  // failed row's Retry makes sense (retrying into a full field would just be
  // sliced off).
  const remaining = maxFiles - done.length - rows.filter((row) => row.error === undefined).length;

  const wrap = el("div");

  if (remaining > 0) {
    // The hidden input is the operable target the dropzone forwards clicks
    // and keyboard activation to. `hidden` removes it from the accessibility
    // tree entirely, not just visually (react's exact pattern) — the
    // dropzone below, not the input, carries the accessible name and state.
    const input = el("input", {
      className: "fillo-input",
      attrs: { id: context.ids.inputId, type: "file", hidden: "" },
    });
    if (maxFiles > 1) input.multiple = true;
    if (field.accept?.length) input.accept = field.accept.join(",");
    input.disabled = !canUpload;
    input.addEventListener("change", () => {
      // Pre-empted: the server is known to refuse the upload while storage is
      // unconnected, so even a forced change event must not start one.
      if (!canUpload) return;
      const files = Array.from(input.files ?? []);
      input.value = ""; // re-picking the same file(s) must still fire "change"
      void context.uploadFiles?.(field, files);
    });

    const dropzone = el("div", {
      className: `fillo-dropzone${canUpload ? "" : " fillo-dropzone--disabled"}`,
      attrs: {
        role: "button",
        tabindex: "0",
        "aria-labelledby": context.ids.labelId,
        "data-fillo": "control",
      },
    });
    // No aria-required: role="button" doesn't support it (axe aria-allowed-
    // attr, ledger #1) — applyFieldAria still wires aria-invalid/describedby.
    applyFieldAria(dropzone, field, context.error, context.ids, { requiredSupported: false });
    if (!canUpload) dropzone.setAttribute("aria-disabled", "true");
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("fillo-dropzone--over");
      dropzone.setAttribute("data-drag-over", "");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("fillo-dropzone--over");
      dropzone.removeAttribute("data-drag-over");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("fillo-dropzone--over");
      dropzone.removeAttribute("data-drag-over");
      if (canUpload) void context.uploadFiles?.(field, Array.from(e.dataTransfer?.files ?? []));
    });
    dropzone.addEventListener("click", () => {
      if (canUpload) input.click();
    });
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (canUpload) input.click();
      }
    });
    dropzone.appendChild(input);
    if (canUpload) {
      appendChildren(dropzone, [
        el("span", {
          className: "fillo-dropzone-title",
          text: DEFAULT_FIELD_STRINGS.dropzoneTitle(maxFiles > 1),
        }),
        el("span", {
          className: "fillo-dropzone-hint",
          text: DEFAULT_FIELD_STRINGS.dropzoneHint(maxMb),
        }),
      ]);
    } else if (uploadDisabledReason === "render_only") {
      dropzone.appendChild(
        el("span", {
          className: "fillo-dropzone-hint",
          text: DEFAULT_FIELD_STRINGS.uploadsRenderOnly,
        }),
      );
    } else if (internal.storageFixUrl) {
      const hint = el("span", {
        className: "fillo-dropzone-hint",
        text: "Connect file storage to enable uploads",
      });
      hint.append(" — ");
      hint.appendChild(
        el("a", {
          text: internal.storageFixUrl,
          attrs: { href: internal.storageFixUrl, target: "_blank", rel: "noopener noreferrer" },
        }),
      );
      dropzone.appendChild(hint);
    } else {
      dropzone.appendChild(
        el("span", {
          className: "fillo-dropzone-hint",
          text: DEFAULT_FIELD_STRINGS.uploadsUnavailable,
        }),
      );
    }
    wrap.appendChild(dropzone);
  }

  if (done.length > 0 || rows.length > 0) {
    const list = el("ul", { className: "fillo-files" });
    for (const file of done) {
      const li = el("li", { className: "fillo-file fillo-file--done" });
      const content = el("span", { className: "fillo-file-content" });
      appendChildren(content, [
        el("span", { className: "fillo-file-name", text: file.name }),
        el("span", {
          className: "fillo-file-meta",
          text: DEFAULT_FIELD_STRINGS.uploadedFile(formatBytes(file.size)),
        }),
      ]);
      const actions = el("span", { className: "fillo-file-actions" });
      actions.appendChild(
        fileActionBtn(
          "fillo-file-remove",
          `${DEFAULT_FIELD_STRINGS.uploadRemove} ${file.name}`,
          closeIcon(),
          () => context.setValue(done.filter((f) => f.fileId !== file.fileId)),
        ),
      );
      appendChildren(li, [fileStateIcon("done"), content, actions]);
      list.appendChild(li);
    }
    for (const row of rows) {
      const failed = row.error !== undefined;
      const li = el("li", {
        className: `fillo-file${failed ? " fillo-file--failed" : ""}`,
      });
      li.appendChild(fileStateIcon(failed ? "failed" : "uploading"));
      const content = el("span", { className: "fillo-file-content" });
      content.appendChild(el("span", { className: "fillo-file-name", text: row.name }));
      if (failed) {
        // The failure was already announced via announceAlert() the moment it
        // happened (controller-side) — this text is plain, no live role
        // (audit P2.1/P2.8: visible nodes carry no live semantics).
        const actions = el("span", { className: "fillo-file-actions" });
        content.appendChild(el("span", { className: "fillo-file-error", text: row.error ?? "" }));
        li.appendChild(content);
        if (!row.tooLarge && remaining > 0) {
          actions.appendChild(
            fileActionBtn(
              "fillo-file-retry",
              `${DEFAULT_FIELD_STRINGS.uploadRetry} ${row.name}`,
              DEFAULT_FIELD_STRINGS.uploadRetry,
              () => internal.uploadAction?.(row.key, "retry"),
            ),
          );
        }
        actions.appendChild(
          fileActionBtn(
            "fillo-file-remove",
            `${DEFAULT_FIELD_STRINGS.uploadDismiss} ${row.name}`,
            closeIcon(),
            () => internal.uploadAction?.(row.key, "dismiss"),
          ),
        );
        li.appendChild(actions);
      } else {
        const bar = el("span", { className: "fillo-progress-bar" });
        bar.style.width = `${row.fraction * 100}%`;
        content.appendChild(
          el("span", {
            className: "fillo-file-meta",
            text: DEFAULT_FIELD_STRINGS.uploadingFile(
              Math.round(row.fraction * 100),
              formatBytes(row.size),
            ),
          }),
        );
        const actions = el("span", { className: "fillo-file-actions" });
        actions.appendChild(
          fileActionBtn(
            "fillo-file-remove",
            `${DEFAULT_FIELD_STRINGS.uploadCancel} ${row.name}`,
            closeIcon(),
            () => internal.uploadAction?.(row.key, "cancel"),
          ),
        );
        appendChildren(li, [
          content,
          actions,
          appendChildren(
            el("span", {
              className: "fillo-progress",
              attrs: {
                role: "progressbar",
                "aria-label": `Uploading ${row.name}`,
                "aria-valuemin": "0",
                "aria-valuemax": "100",
                "aria-valuenow": String(Math.round(row.fraction * 100)),
              },
            }),
            [bar],
          ),
        ]);
      }
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  // Soft capacity/busy notices (audit P2.1/P2.8): visible text, no live role
  // — the controller already routed it through announce() when it was set.
  const notice = internal.uploadNotice;
  if (notice) wrap.appendChild(el("p", { className: "fillo-upload-notice", text: notice }));
  return shell(field, context.error, wrap, context.ids);
}

/**
 * A calculated field's read-only display row: label + the formatted value the
 * engine computed into `data` — never an input, never a tab stop. The value
 * lives in an <output> (a labelable element whose whole purpose is a
 * calculation result), so the shell-style <label for> ties the field label to
 * the value text and screen readers announce "Subtotal: $42". Formatting goes
 * through core's formatAnswer so decimals/prefix/suffix render identically to
 * the grid/CSV. Unanswered (a null calc result keeps the key out of data)
 * renders an em dash.
 */
function calculated(context: FieldRenderContext): HTMLElement {
  const field = context.field;
  const wrap = el("div", {
    className: "fillo-field fillo-field--calculated fillo-calculated",
    attrs: { "data-fillo": "calculated", "data-field": field.id, "data-kind": field.kind },
  });
  // No "(optional)" marker: this is a computed line, not a skippable question
  // (required is forced false in normalization).
  wrap.appendChild(
    el("label", {
      className: "fillo-label",
      text: field.label,
      attrs: { id: context.ids.labelId, for: context.ids.inputId, "data-fillo": "label" },
    }),
  );
  if (field.description)
    wrap.appendChild(
      el("p", {
        className: "fillo-description",
        text: field.description,
        attrs: { id: context.ids.descriptionId, "data-fillo": "fieldDescription" },
      }),
    );
  const value = context.value;
  const answered = value !== undefined && value !== null && value !== "";
  const output = el("output", {
    className: `fillo-calculated-value${answered ? "" : " fillo-calculated-value--empty"}`,
    text: answered ? formatAnswer(field, value) : "—",
    attrs: { id: context.ids.inputId },
  });
  if (field.description) output.setAttribute("aria-describedby", context.ids.descriptionId);
  wrap.appendChild(output);
  return wrap;
}

// Cache the shuffled order per field (keyed by its option ids) so the DOM
// renderer — which re-renders on every keystroke — doesn't reshuffle options
// mid-interaction. Matches the React renderer's once-per-session behavior.
const shuffleCache = new Map<string, string[]>();

function displayOptions(field: ChoiceField) {
  if (!field.shuffleOptions) return field.options;
  const cacheKey = `${field.id}|${field.options.map((o) => o.id).join(",")}`;
  let order = shuffleCache.get(cacheKey);
  if (!order) {
    order = field.options.map((o) => o.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    shuffleCache.set(cacheKey, order);
  }
  const byId = new Map(field.options.map((o) => [o.id, o]));
  const shuffled = order.flatMap((id) => byId.get(id) ?? []);
  return shuffled.length === field.options.length ? shuffled : field.options;
}

// ---------- Repeating groups (bet 08 P3, docs/decisions/repeating-groups.md
// decisions 8-9 + wave-B shared spec) ----------

/**
 * The freshest available read of a repeating group's stored instances — via
 * the threaded getValue() when present (the engine-committed value, live
 * even mid-typing under a {render:false} child edit — the same hazard the
 * grouped-number/phone blur handlers guard against), else the render-time
 * snapshot. Never the array a caller should mutate in place (see
 * materializeGroupInstances).
 */
function groupInstances(context: FieldRenderContext): GroupInstanceValue[] {
  const fresh = (context as InternalFieldRenderContext).getValue?.() ?? context.value;
  return Array.isArray(fresh) ? (fresh as GroupInstanceValue[]) : [];
}

/** Rendered instance count (wave-B spec): stored length, floored at
 *  minInstances (default 1; an explicit 0 allows zero cards, just Add). */
function groupRenderedCount(field: RepeatingGroupField, stored: GroupInstanceValue[]): number {
  return Math.max(stored.length, field.minInstances ?? 1);
}

/** The lowest rendered count Remove may leave behind. */
function groupFloor(field: RepeatingGroupField): number {
  return Math.max(field.minInstances ?? 1, 0);
}

/** Pad `stored` to `count` with empty instances — count is always >=
 *  stored.length (see groupRenderedCount), so this never truncates. Returns
 *  a new array; `stored` is never mutated. Called only from a write path —
 *  reading for display (below) never materializes the padding into data. */
function materializeGroupInstances(
  stored: GroupInstanceValue[],
  count: number,
): GroupInstanceValue[] {
  const out = [...stored];
  while (out.length < count) out.push({});
  return out;
}

function repeatingGroup(context: FieldRenderContext): HTMLElement | null {
  const field = context.field;
  if (field.kind !== "repeating_group") return null;
  const ictx = context as InternalFieldRenderContext;
  const announce = ictx.announce;
  const instanceId = ictx.instanceId ?? "";
  // "item = field.itemLabel || field.label" (wave-B spec, verbatim) — an
  // empty-string itemLabel falls back to the field label too.
  const item = field.itemLabel || field.label;
  const stored = groupInstances(context);
  // Stable for this whole render pass: only Add/Remove change the rendered
  // count, and both always trigger a full queueRender() — so every closure
  // below can trust `count` while still reading FRESH instance values via
  // groupInstances(context) at write time (mid-typing {render:false} child
  // edits change values, never the count, between renders).
  const count = groupRenderedCount(field, stored);
  const floor = groupFloor(field);

  const wrap = el("div", {
    className: "fillo-group",
    attrs: { id: context.ids.inputId, "data-fillo": "control" },
  });
  applyFieldAria(wrap, field, context.error, context.ids, { requiredSupported: false });

  for (let index = 0; index < count; index++) {
    const instanceValues = stored[index] ?? {};
    const heading = DEFAULT_FIELD_STRINGS.groupInstanceLabel(item, index + 1, count);
    const card = el("div", {
      className: "fillo-group-instance",
      attrs: { role: "group", "aria-label": heading, tabindex: "-1" },
    });
    const header = el("div", { className: "fillo-group-instance-header" });
    const removeBtn = el("button", {
      className: "fillo-group-remove",
      text: "×",
      attrs: {
        type: "button",
        "aria-label": DEFAULT_FIELD_STRINGS.groupRemoveLabel(item, index + 1),
      },
    });
    const canRemove = count > floor;
    removeBtn.toggleAttribute("disabled", !canRemove);
    if (!canRemove) {
      removeBtn.setAttribute("aria-disabled", "true");
      removeBtn.setAttribute(
        "title",
        `At least ${floor} ${floor === 1 ? "entry" : "entries"} required`,
      );
    }
    removeBtn.addEventListener("click", () => {
      if (count <= floor) return; // defensive: the control is disabled at the floor
      const next = materializeGroupInstances(groupInstances(context), count);
      next.splice(index, 1);
      context.setValue(next);
      // Contract decision 9: focus the previous card's heading, else Add —
      // never a sibling's control, never <body>.
      ictx.setGroupFocus?.({ groupId: field.id, cardIndex: index - 1, intoControl: false });
      announce?.(DEFAULT_FIELD_STRINGS.groupInstanceRemoved(item, next.length));
    });
    appendChildren(header, [
      el("p", { className: "fillo-group-instance-title", text: heading }),
      removeBtn,
    ]);
    card.appendChild(header);

    for (const child of visibleGroupChildren(field, instanceValues)) {
      // Compound DOM id key (contract decision 5, wave-B spec): dot-safe,
      // unique per group/instance/child — through the SAME fieldIds()
      // derivation top-level fields use, never the child's own bare id
      // (which two instances — or a child id that happens to match a
      // top-level field's id, contract amendment — would otherwise collide
      // on: data-field, radio `name` grouping, the "Other" active-field
      // set, and the option-shuffle cache, all keyed off field.id today).
      const compoundId = `${field.id}.${index}.${child.id}`;
      const childField = { ...child, id: compoundId } as Field;
      const childIds = fieldIds(instanceId, compoundId);
      const childSetValue = (value: FieldValue, options?: { render?: boolean }) => {
        // The Matrix whole-value idiom, one level deeper (contract decision
        // 8): read-patch-write the WHOLE rendered array through the
        // group's own setValue, never the child's id directly.
        const next = materializeGroupInstances(groupInstances(context), count);
        next[index] = { ...(next[index] ?? {}), [child.id]: value };
        context.setValue(next, options);
      };
      const childContext: InternalFieldRenderContext = {
        field: childField,
        value: instanceValues[child.id],
        error: context.api.errors[compoundId],
        ids: childIds,
        api: context.api,
        setValue: childSetValue,
        getValue: () => groupInstances(context)[index]?.[child.id],
        announce: ictx.announce,
        announceAlert: ictx.announceAlert,
        registerOverlay: ictx.registerOverlay,
        activeOtherFields: ictx.activeOtherFields,
      };
      // Through the EXISTING per-block dispatch (renderBlock's own
      // components/customComponents lookup) when threaded by the
      // controller; the module-level default is the only reachable path
      // for a bare renderChild helper injected by a test or a future
      // caller that doesn't thread it.
      const rendered = ictx.renderChildField?.(childContext) ?? defaultFieldRenderer(childContext);
      if (rendered) card.appendChild(rendered);
    }
    wrap.appendChild(card);
  }

  const atMax = count >= field.maxInstances;
  const addBtn = el("button", {
    className: "fillo-group-add",
    text: field.addLabel || DEFAULT_FIELD_STRINGS.groupAdd,
    attrs: { type: "button" },
  });
  addBtn.toggleAttribute("disabled", atMax);
  if (atMax) {
    addBtn.setAttribute("aria-disabled", "true");
    addBtn.setAttribute(
      "title",
      `Maximum ${field.maxInstances} ${field.maxInstances === 1 ? "entry" : "entries"}`,
    );
  }
  addBtn.addEventListener("click", () => {
    if (count >= field.maxInstances) return; // defensive: the control is disabled at max
    const next = materializeGroupInstances(groupInstances(context), count);
    next.push({});
    context.setValue(next);
    ictx.setGroupFocus?.({ groupId: field.id, cardIndex: next.length - 1, intoControl: true });
    announce?.(DEFAULT_FIELD_STRINGS.groupInstanceAdded(item, next.length, next.length));
  });
  wrap.appendChild(addBtn);

  return shell(field, context.error, wrap, context.ids);
}

const DEFAULT_COMPONENTS: Record<Exclude<FieldKind, "custom" | "hidden">, FieldRenderer> = {
  short_text: (ctx) => textInput("text", ctx),
  email: (ctx) => textInput("email", ctx),
  url: (ctx) => textInput("url", ctx),
  phone: phoneInput,
  number: (ctx) => textInput("number", ctx),
  date: (ctx) => textInput("date", ctx),
  long_text: longText,
  select: singleChoice,
  multi_select: multiChoice,
  dropdown,
  checkbox,
  rating,
  linear_scale: linearScale,
  ranking,
  matrix,
  signature,
  file_upload: fileUpload,
  calculated,
  repeating_group: repeatingGroup,
};

function defaultFieldRenderer(context: FieldRenderContext): HTMLElement | null {
  if (context.field.kind === "hidden") return null;
  if (context.field.kind === "custom") return null;
  const renderer = DEFAULT_COMPONENTS[context.field.kind];
  return renderer ? renderer(context) : null;
}

/** One in-flight/failed upload (audit P0.3 — mirrors react's InFlight[],
 *  keyed by a synthetic per-file key). `file`/`controller` let Retry/Cancel
 *  act on the exact attempt; `maxFiles` travels with the row so a completion
 *  can decide replace-vs-append without a schema lookup. */
interface InFlightUpload {
  fieldId: string;
  name: string;
  size: number;
  fraction: number;
  error?: string;
  /** A local size rejection cannot become valid by retrying. */
  tooLarge?: boolean;
  file: File;
  controller: AbortController;
  maxFiles: number;
}

/**
 * Cloudflare Turnstile widget support (audit P0.1 — dom shipped no widget, so
 * a challenge-gated form's token never reached the server gate). Ported from
 * @usefillo/react's turnstile.tsx — same script-loader singleton and
 * load-failure recovery, adapted from a mount/unmount effect to
 * DomFormController's imperative lifecycle (turnstile* fields/methods below).
 * The script loads lazily, only when a challenge is required, so a
 * challenge-off form loads zero third-party JS. The SERVER verifies the
 * token — this widget is UX and never gates anything on its own.
 */
interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  "error-callback"?: (code?: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  theme?: "auto" | "light" | "dark";
  appearance?: "always" | "execute" | "interaction-only";
}

// `render=explicit` so we control when/where the widget mounts (into our
// slot), instead of Cloudflare auto-scanning the whole page for `.cf-turnstile`.
const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_SCRIPT_ID = "fillo-turnstile-script";

/** How long the challenge bridge gets to say "ready" before we surface the
 *  unavailable state (frame or its Cloudflare script blocked, server down). */
const BRIDGE_READY_TIMEOUT_MS = 20_000;

/** Cloudflare cData charset (the bridge echoes the form id through siteverify
 *  for the server's binding check). A form id outside it is simply not sent —
 *  the server only compares when present. Same regex as the bridge route and
 *  @usefillo/react. */
const CHALLENGE_CDATA_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** At-most-once script load shared by every widget instance on the page. */
let turnstileScriptPromise: Promise<void> | null = null;

function turnstileGlobal(): TurnstileApi | undefined {
  return (globalThis as unknown as { turnstile?: TurnstileApi }).turnstile;
}

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Turnstile needs a browser"));
  }
  if (turnstileGlobal()) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    const onReady = () => {
      if (turnstileGlobal()) resolve();
      else reject(new Error("Turnstile loaded without its global"));
    };
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if (turnstileGlobal()) {
        resolve();
        return;
      }
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Turnstile script failed to load")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener(
      "error",
      () => {
        // Load failed. Remove the dead <script> and clear the cached promise
        // so a later attempt injects a fresh element and actually re-fetches
        // — otherwise it re-finds this corpse and hangs on listeners that
        // never fire again (fails closed, but permanently unsubmittable).
        script.remove();
        turnstileScriptPromise = null;
        reject(new Error("Turnstile script failed to load"));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

/** The container Cloudflare renders its widget iframe into — a factory so a
 *  torn-down widget gets a pristine mount point next time instead of reusing
 *  one Cloudflare already rendered into and was told to remove. */
function newTurnstileContainer(): HTMLElement {
  return el("div", { className: "fillo-turnstile", attrs: { "data-fillo": "turnstile" } });
}

class DomFormController implements FilloDomForm {
  readonly element = el("div");
  // Persistent live-region channels (audit P2.1): siblings of `element`
  // (never inside it), so the full-tree `element.replaceChildren()` every
  // render() does can never tear them down or recreate them.
  private readonly statusEl = el("span", {
    className: "fillo-sr-only",
    attrs: { role: "status", "aria-live": "polite", "data-fillo": "announce" },
  });
  private readonly alertEl = el("span", {
    className: "fillo-sr-only",
    attrs: { role: "alert", "data-fillo": "announce-alert" },
  });
  private readonly instanceId = `d${++domInstanceCounter}`;
  private schema: FormSchema | null = null;
  private theme: FormTheme | undefined;
  private formId: string | undefined;
  private closed = false;
  // null = not yet resolved from the server; absent branding means "show".
  private fetchedPoweredBy: boolean | null = null;
  private fetchedBrandLabel: string | undefined;
  private fetchedBrandHref: string | undefined;
  // The renderer owns its lifecycle phase; all field state, validation,
  // conditional logic, paging, spam signals, funnel tracking, and submission
  // live in the shared core engine.
  private phase: "loading" | "ready" | "closed" | "error" = "loading";
  private engine: FormController | null = null;
  private destroyed = false;
  private renderQueued = false;
  private hpValue = "";
  private liveSubmissionHandled = false;
  private activeOtherFields = new Set<string>();
  // Per-file upload tracking (audit P0.3), keyed by a synthetic per-file key —
  // replaces the old per-field aggregate progress number. Concurrent uploads
  // within one field are independent rows, each cancellable/retryable alone.
  private inFlight = new Map<string, InFlightUpload>();
  // Per-field soft capacity/busy notices ("N files weren't added", "N files
  // exceed the limit") — plain text; announce() carries the live semantics.
  private uploadNotices = new Map<string, string>();
  // Where to move focus on the next render: "error" after a failed submit/next,
  // "page" after navigating, a GroupFocusIntent after a repeating-group
  // Add/Remove (contract decision 9), null → restore the pre-render active
  // control.
  private focusIntent: "page" | "error" | GroupFocusIntent | null = null;
  // Teardown callbacks for open overlays (phone country popover) whose listeners
  // live on window/document and would otherwise leak past a re-render/unmount.
  private overlays = new Set<() => void>();
  // Human-verification challenge (Turnstile). Token read lazily by the
  // engine's getChallengeToken at submit time (react's ref, equivalent
  // freshest-solve contract). `turnstileContainer` is the node Cloudflare
  // renders its iframe into — created once and RE-ATTACHED (moved, never
  // recreated) into the tree every render, same hoist precedent as
  // statusEl/alertEl above, so the iframe survives replaceChildren() instead
  // of reloading on every keystroke.
  private challenge: ChallengeConfig | undefined;
  private challengeToken: string | undefined;
  private challengeError = false;
  private turnstileContainer: HTMLElement = newTurnstileContainer();
  private turnstileWidgetId: string | null = null;
  private turnstileSiteKey: string | undefined;
  private turnstileLoadInFlight = false;
  // Invalidated on teardown so a stale load/render callback can't land after
  // a later attempt replaced the container (or double-render into it).
  private turnstileAttempt = 0;
  // Bridge mode (challenge.bridgeUrl): the Fillo-hosted iframe that runs the
  // widget on Fillo's OWN hostname (so the check works on any embedding
  // domain) plus its postMessage wiring. Mutually exclusive with the direct
  // Cloudflare-script fields above; teardownTurnstileWidget() clears both.
  private challengeFrame: HTMLIFrameElement | null = null;
  private challengeFrameSrc: string | null = null;
  private challengeFrameOrigin: string | null = null;
  private challengeMessageHandler: ((event: MessageEvent) => void) | null = null;
  private challengeWatchdog: number | null = null;

  constructor(
    private readonly target: HTMLElement,
    private readonly options: InternalRenderFormOptions,
  ) {
    this.element.className = "fillo-dom-root";
    if (options.preview === true) warnPreviewInProduction();
    target.replaceChildren(this.element, this.statusEl, this.alertEl);
    void this.resolve();
  }

  // Clear-then-set (one frame apart) so an identical repeat still re-fires —
  // a same-tick ""→text write can collapse into a no-op net change for AT.
  private announce = (text: string): void => {
    this.statusEl.textContent = "";
    requestAnimationFrame(() => {
      this.statusEl.textContent = text;
    });
  };
  private announceAlert = (text: string): void => {
    this.alertEl.textContent = "";
    requestAnimationFrame(() => {
      this.alertEl.textContent = text;
    });
  };

  /** Dev chrome = every developer-facing surface below (inline schema render,
   * notices, verbose submit errors, upload pre-emption). `preview` forces it
   * on off-localhost surfaces — cosmetic only, so correctness (where
   * submissions go, whether they are accepted) never depends on it. */
  private devChrome(): boolean {
    return this.options.preview === true || isDevEnv();
  }

  get status(): FormStatus {
    if (this.phase === "ready") return this.engine?.getState().status ?? "idle";
    return this.phase; // "loading" | "error" | "closed"
  }

  get data() {
    return this.engine?.getState().data ?? this.options.initialData ?? {};
  }

  get form() {
    return this.schema;
  }

  private get mutableData(): ResponseData {
    return this.engine?.getState().data ?? this.options.initialData ?? {};
  }

  private api(): FilloDomApi {
    const form = this.schema ?? { version: 1, title: "", pages: [], settings: {} };
    const state = this.engine?.getState();
    const pageCount = state?.pageCount ?? form.pages.length;
    return {
      form,
      formId: this.formId,
      client: this.options.renderOnly ? undefined : this.options.client,
      data: state?.data ?? this.mutableData,
      errors: state?.errors ?? {},
      status: this.status,
      pageIndex: state?.pageIndex ?? 0,
      pageCount,
      page: state?.page ?? form.pages[0] ?? { id: "empty", blocks: [] },
      blocks: state?.blocks ?? [],
      isFirstPage: state?.isFirstPage ?? true,
      isLastPage: state?.isLastPage ?? pageCount <= 1,
      setValue: (fieldId, value, opts) => this.setValueInternal(fieldId, value, opts),
      next: () => this.next(),
      back: () => this.back(),
      submit: () => this.submit(),
    };
  }

  private resolveFormIdFn?: () => Promise<string>;
  /** The server refuses submissions right now — render a not-open state backed
   *  by the real form in display-only mode ("notOpen" for a draft /
   *  storage-blocked form, "closed" for an expired/capped workspace). Doubles
   *  as the display-only gate: while set, the engine is created without a
   *  client/formId/resolver and every interactive entry point no-ops. */
  private notOpenVariant: "notOpen" | "closed" | null = null;
  /** Exact integration failure retained for custom error/dev surfaces. */
  private fatalError: FilloError | null = null;
  private genericUnavailable = false;
  private syncErrorNotice: FilloError | null = null;
  private stagedNotice = false;
  /** Dev chrome: the code form is a draft — a visible banner, not console-only. */
  private draftNotice = false;
  /** Sync's owner-facing storage advisory + dashboard deep-link. It never
   *  substitutes for the explicit uploadsAvailable control state. */
  private syncWarningCode: string | undefined;
  private syncWarningUrl: string | undefined;
  /** Dashboard form overview containing the Publish action — dev chrome only. */
  private syncFormUrl: string | undefined;
  /** Server-authoritative ability to start a new file upload. */
  private uploadsAvailable: boolean | undefined;
  /** Server-authoritative per-file ceiling for the active storage lane. */
  private uploadFileSizeLimitMb: number | undefined;
  /** Code of the last submit-time resolution failure (form_not_published,
   *  form_schema_changed, …) — the connect-storage deep-link renders only with
   *  the failure it explains, never glued onto transport/challenge errors. */
  private resolutionFailureCode: string | null = null;

  private async resolve() {
    try {
      // An explicit `challenge` wins over anything the server delivers below
      // — same precedence as react's FilloForm.
      this.challenge = this.options.renderOnly ? undefined : this.options.challenge;
      const codeForm = isCodeForm(this.options.form) ? this.options.form : null;
      if (codeForm) {
        if (this.options.renderOnly) {
          this.setSchema(codeForm.schema, this.options.theme ?? codeForm.theme, undefined);
          return;
        }
        if (!this.options.client && this.options.formId) this.options.client = createClient();
        const client = this.options.client;
        // Submit-time verification bypasses caches so a newly published live
        // schema cannot receive answers from an older page unchecked.
        if (client?.key) {
          // bypassCache: a stale cached formId must not be trusted at submit time.
          this.resolveFormIdFn = async () => {
            try {
              const result = await syncCodeForm(client, codeForm, { bypassCache: true });
              // Freshest truth: update the independent upload-availability and
              // owner-warning snapshots before submission.
              this.syncWarningCode = result.warningCode;
              this.syncWarningUrl = result.warningUrl;
              this.syncFormUrl = result.manageUrl;
              this.uploadsAvailable = result.uploadsAvailable;
              this.uploadFileSizeLimitMb = result.uploadFileSizeLimitMb;
              if (result.status === "draft") {
                throw new FilloError(
                  "This form is no longer published. Submission was stopped before sending answers.",
                  403,
                  undefined,
                  "form_not_published",
                );
              }
              if (result.accepting === false) {
                throw new FilloError(
                  "This form is no longer accepting responses. Submission was stopped before sending answers.",
                  403,
                  undefined,
                  result.acceptingReason ?? "form_not_accepting",
                );
              }
              const authoritative = normalizeFormSchema(result.resolvedSchema ?? codeForm.schema);
              if (!authoritative.ok) {
                throw new FilloError(
                  `The canonical form schema was invalid: ${authoritative.error}`,
                  502,
                  undefined,
                  "invalid_sync_schema",
                );
              }
              if (this.schema && !formSchemasEqual(this.schema, authoritative.schema!)) {
                throw new FilloError(
                  "The live form changed after this page loaded. Submission stopped before incompatible answers were sent. Reload to use the published schema.",
                  409,
                  undefined,
                  "form_schema_changed",
                );
              }
              if (result.syncError) {
                this.reportSyncNotice(
                  new FilloError(result.syncError.message, 403, undefined, result.syncError.code),
                );
              }
              this.resolutionFailureCode = null;
              return result.formId;
            } catch (error: unknown) {
              const failure = toFilloError(error);
              this.resolutionFailureCode = failure.code ?? "sync_failed";
              this.reportSubmitSyncFailure(failure);
              throw failure;
            }
          };
        }
        if (!client?.key && this.options.formId) {
          this.setSchema(
            codeForm.schema,
            this.options.theme ?? codeForm.theme,
            this.options.formId,
          );
        }
        if (!client && !this.options.formId) {
          this.genericUnavailable = !this.devChrome();
          throw formTargetRequiredError();
        }
        // A configured client with neither key nor explicit target cannot
        // resolve a code-defined form.
        if (client && !client.key && !this.options.formId) {
          this.reportSyncFailure(
            new FilloError(
              'Code forms need createClient({ key: "pk_…" }) to resolve the live form. Pass a publishable key or a published formId.',
              401,
              undefined,
              "sync_key_required",
            ),
          );
          return;
        }
        if (!client?.key) return;

        // Production must not expose the local schema until the bounded sync
        // establishes what the live response endpoint accepts. Dev chrome
        // renders immediately for iteration and swaps to the canonical
        // snapshot later.
        if (this.devChrome()) {
          this.setSchema(
            codeForm.schema,
            this.options.theme ?? codeForm.theme,
            this.options.formId,
          );
        } else {
          this.theme = this.options.theme ?? codeForm.theme;
          this.render();
        }
        try {
          const result = await syncCodeForm(client, codeForm);
          if (this.destroyed) return;
          if ((result.staged || result.syncError) && !result.resolvedSchema) {
            throw new FilloError(
              "Sync did not return the live schema needed to render safely. Publish changes before deploy, and update @usefillo/* or your API.",
              409,
              undefined,
              "sync_snapshot_required",
            );
          }
          const development = this.devChrome();
          // Production not-accepting states get a display-only preview behind
          // the state: a draft (older servers report only status) or a published
          // form whose accepting verdict is false (expired/capped workspace).
          // Dev keeps the interactive form with the draft banner.
          this.notOpenVariant = development
            ? null
            : result.status === "draft"
              ? "notOpen"
              : result.accepting === false
                ? overlayVariant(result.acceptingReason)
                : null;
          this.stagedNotice = Boolean(result.staged);
          this.draftNotice = result.status === "draft";
          this.syncWarningCode = result.warningCode;
          this.syncWarningUrl = result.warningUrl;
          this.syncFormUrl = result.manageUrl;
          this.uploadsAvailable = result.uploadsAvailable;
          this.uploadFileSizeLimitMb = result.uploadFileSizeLimitMb;
          this.challenge = this.options.challenge ?? result.challenge;
          if (result.branding) {
            this.fetchedPoweredBy = result.branding.poweredBy;
            this.fetchedBrandLabel = result.branding.label;
            this.fetchedBrandHref = result.branding.href;
          }
          if (development && result.resolvedSchema) {
            // Keep local changes visible for development, but bind the target
            // and let submit-time verification block incompatible answers.
            this.formId = result.formId;
            this.engine?.setContext({ formId: result.formId });
            this.render();
          } else {
            const safeSchema = result.resolvedSchema ?? codeForm.schema;
            const safeTheme =
              this.options.theme ??
              (result.resolvedSchema ? (result.resolvedTheme ?? undefined) : codeForm.theme);
            this.applyCanonicalSchema(safeSchema, safeTheme, result.formId);
          }
          if (result.warning) console.warn(`[fillo] ${result.warning}`);
          if (result.syncError) {
            this.reportSyncNotice(
              new FilloError(result.syncError.message, 403, undefined, result.syncError.code),
            );
          }
          // Sync's blocker link (today: connect storage) rides the lifecycle
          // notices so the developer sees how to unblock publishing.
          const connectStorage = result.warningUrl
            ? ` — connect storage to publish: ${result.warningUrl}`
            : "";
          if (result.staged) {
            console.info(
              `[fillo] "${codeForm.id}" changes staged as a draft — rendering the live version until you publish them in your Fillo dashboard${connectStorage}`,
            );
          } else if (result.status === "draft") {
            console.info(
              `[fillo] "${codeForm.id}" is a draft — it renders here but won't accept responses until published${connectStorage}`,
            );
          }
        } catch (error: unknown) {
          if (this.destroyed) return;
          this.reportSyncFailure(toFilloError(error));
        }
        return;
      }

      const schema = this.options.form && !isCodeForm(this.options.form) ? this.options.form : null;
      if (schema) {
        if (this.options.renderOnly) {
          this.setSchema(schema, this.options.theme, undefined);
          return;
        }
        if (!this.options.formId) {
          this.genericUnavailable = !this.devChrome();
          throw formTargetRequiredError();
        }
        this.options.client ??= createClient();
        this.setSchema(schema, this.options.theme, this.options.formId);
        return;
      }

      if (!this.options.formId) {
        throw new FilloError("Provide either `form`, or a `formId`.", 0);
      }
      // A hosted form only needs a client pointing at the API; default one
      // (→ fillo.so) so renderForm(el, { formId }) works with nothing else.
      this.options.client ??= createClient();

      this.render();
      const published = await this.options.client.getForm(this.options.formId);
      if (this.destroyed) return;
      // The server's accepting verdict beats the coarse closed flag: render
      // the not-open state backed by the real display-only form. Absent
      // `accepting` (older server) keeps the closed-panel behavior exactly.
      if (published.accepting === false) {
        this.notOpenVariant = overlayVariant(published.acceptingReason);
      } else {
        this.closed = Boolean(published.closed);
      }
      this.uploadsAvailable = published.uploadsAvailable;
      this.uploadFileSizeLimitMb = published.uploadFileSizeLimitMb;
      this.fetchedPoweredBy = published.branding?.poweredBy ?? null;
      this.fetchedBrandLabel = published.branding?.label;
      this.fetchedBrandHref = published.branding?.href;
      this.challenge = this.options.challenge ?? published.challenge;
      if (published.accepting === false && this.options.renderError) {
        const message =
          this.notOpenVariant === "closed"
            ? "This form is no longer accepting responses."
            : "This form isn't accepting responses yet.";
        this.fatalError = new FilloError(message, 403, undefined, published.acceptingReason);
        this.phase = "error";
        this.render(this.fatalError);
        return;
      }
      this.setSchema(
        published.schema,
        this.options.theme ?? published.theme ?? undefined,
        published.id,
      );
    } catch (error) {
      if (this.destroyed) return;
      this.handleError(toFilloError(error));
    }
  }

  /** Bind the resolved schema, create the engine, and render. */
  private setSchema(schema: FormSchema, theme: FormTheme | undefined, formId: string | undefined) {
    if (this.destroyed) return;
    const normalized = normalizeFormSchema(schema);
    if (!normalized.ok)
      throw new FilloError(`This form could not be rendered: ${normalized.error}`, 422);
    const normalizedSchema = normalized.schema!;
    this.schema = normalizedSchema;
    this.theme = theme;
    const renderOnly = this.options.renderOnly === true;
    this.formId = renderOnly ? undefined : formId;
    // renderForm is a framed renderer (it draws the layout), so its surface is
    // "default" — not the gated "headless" surface that bare createFormController
    // defaults to.
    // Display-only (not-open overlay): the engine gets NO client, formId,
    // resolver, respondent, or callbacks, so by construction it has no
    // submission target (its submit path never fakes success and can never
    // reach a server), saved-progress drafts stay off (they need a client +
    // formId, so no restore calls or autosave timers), and nothing is
    // reported to the host.
    const displayOnly = this.notOpenVariant !== null;
    const transportDisabled = displayOnly || renderOnly;
    this.engine = coreCreateFormController({
      form: normalizedSchema,
      formId: transportDisabled ? undefined : formId,
      client: transportDisabled ? undefined : this.options.client,
      initialData: this.options.initialData,
      onChange: displayOnly ? undefined : this.options.onChange,
      onSubmitted: transportDisabled ? undefined : this.options.onSubmitted,
      getHoneypot: () =>
        this.element.querySelector<HTMLInputElement>('input[name="fillo_hp_field"]')?.value ??
        this.hpValue,
      surface: "default",
      resolveFormId: transportDisabled ? undefined : this.resolveFormIdFn,
      skipValidation: renderOnly,
      // Dev chrome gets the developer-grade resolution failure (message +
      // machine code) instead of the respondent-safe "unavailable" fallback.
      verboseResolutionErrors: this.devChrome(),
      respondent: transportDisabled ? undefined : this.options.respondent,
      // Challenge (Turnstile) — wired as react's useFilloController wires the
      // core controller: challengeRequired captured once here (forced off for
      // a not-open preview, which never submits regardless);
      // getChallengeToken/onChallengeFailed stay live via `this`.
      challengeRequired: transportDisabled ? false : Boolean(this.challenge),
      getChallengeToken: () => this.challengeToken,
      onChallengeFailed: () => this.resetChallengeWidget(),
    });
    // Status can change outside our own action handlers (the deferred
    // browser-limit flip, async submit transitions), and a saved-progress
    // restore lands async too (data/page move while status stays "idle").
    // Re-render on those coarse flips only — value notifies must not redraw
    // mid-type (focus/IME).
    let lastStatus = this.engine.getState().status;
    let lastResumed = this.engine.getState().resumedDraft;
    let lastEditing = this.engine.getState().editingPrevious;
    this.engine.subscribe(() => {
      const state = this.engine?.getState();
      if (!state) return;
      if (
        state.status !== lastStatus ||
        state.resumedDraft !== lastResumed ||
        state.editingPrevious !== lastEditing
      ) {
        // Announce once, on the false→true transition (audit P2.8: the old
        // role="status" banner mounts with the tree, so it likely never
        // actually announces) — not on every later re-render.
        if (state.editingPrevious && !lastEditing) this.announce(DEFAULT_STRINGS.editNotice);
        else if (state.resumedDraft && !lastResumed) this.announce(DEFAULT_STRINGS.resumeNotice);
        lastStatus = state.status;
        lastResumed = state.resumedDraft;
        lastEditing = state.editingPrevious;
        this.queueRender();
      }
    });
    // Saved-progress forms: the core engine owns autosave; the DOM layer owns
    // the tab-hide flush events (mirrors the React renderer's useDraftFlush).
    // A display-only preview holds nothing worth flushing — wire no listeners.
    if (!transportDisabled) this.configureDraftFlush(normalizedSchema);
    this.phase = this.closed ? "closed" : "ready";
    this.render();
  }

  /** Swap dev-local content for the server-authoritative live snapshot without losing answers. */
  private applyCanonicalSchema(
    schema: FormSchema,
    theme: FormTheme | undefined,
    formId: string,
  ): void {
    if (!this.engine) {
      this.setSchema(schema, theme, formId);
      return;
    }
    const normalized = normalizeFormSchema(schema);
    if (!normalized.ok) {
      throw new FilloError(`This form could not be rendered: ${normalized.error}`, 422);
    }
    const normalizedSchema = normalized.schema!;
    this.schema = normalizedSchema;
    this.theme = theme;
    this.formId = formId;
    this.engine.setContext({ form: normalizedSchema, formId });
    if (this.notOpenVariant === null) this.configureDraftFlush(normalizedSchema);
    this.phase = this.closed ? "closed" : "ready";
    this.render();
  }

  private draftFlushWired = false;
  private readonly flushDraftBound = () => this.engine?.flushDraft();
  private readonly visibilityFlushBound = () => {
    if (document.visibilityState === "hidden") this.engine?.flushDraft();
  };

  private configureDraftFlush(schema: FormSchema): void {
    this.teardownDraftFlush();
    if (schema.settings.saveProgress && typeof window !== "undefined") {
      window.addEventListener("pagehide", this.flushDraftBound);
      document.addEventListener("visibilitychange", this.visibilityFlushBound);
      this.draftFlushWired = true;
    }
  }

  private teardownDraftFlush(): void {
    if (!this.draftFlushWired || typeof window === "undefined") return;
    window.removeEventListener("pagehide", this.flushDraftBound);
    document.removeEventListener("visibilitychange", this.visibilityFlushBound);
    this.draftFlushWired = false;
  }

  flushDraft(): void {
    this.engine?.flushDraft();
  }

  resetDraft(): void {
    this.engine?.resetDraft();
    this.queueRender();
  }

  setValue(fieldId: string, value: FieldValue): void {
    this.setValueInternal(fieldId, value);
  }

  private setValueInternal(
    fieldId: string,
    value: FieldValue,
    opts: { render?: boolean } = {},
  ): void {
    // Display-only (not-open overlay): the preview accepts no writes.
    if (this.notOpenVariant) return;
    // The engine updates data, clears the field error, fires onChange, and opens
    // the funnel session. We keep control of *when* to redraw (not per keystroke).
    this.engine?.setValue(fieldId, value);
    if (opts.render !== false) this.queueRender();
  }

  next(): void {
    if (!this.engine || this.notOpenVariant) return;
    const before = this.engine.getState().pageIndex;
    this.engine.next();
    // Advanced → focus the new page; stayed put → validation failed, focus the error.
    this.focusIntent = this.engine.getState().pageIndex !== before ? "page" : "error";
    this.render();
  }

  back(): void {
    if (!this.engine || this.notOpenVariant) return;
    this.engine.back();
    this.focusIntent = "page";
    this.render();
  }

  async submit(): Promise<void> {
    // Display-only (not-open overlay): the submit path is unreachable by
    // construction — even a programmatic call is a no-op (and the engine
    // behind it has no client/formId to send with anyway).
    if (!this.engine || this.phase !== "ready" || this.notOpenVariant) return;
    // The engine advances synchronously to "submitting" (or populates errors)
    // before its first await — render that, then render the final state.
    const pending = this.engine.submit();
    if (this.hasErrors()) {
      this.focusIntent = "error";
    } else if (this.engine.getState().status === "submitting") {
      // Covers auto-submit-with-no-footer, which has no visible "Submitting…"
      // button text to fall back on — otherwise total silence during the
      // round-trip.
      this.announce(DEFAULT_FIELD_STRINGS.submittingAnnouncement);
    }
    this.render();
    try {
      await pending;
    } catch (error) {
      // Transport failure: the engine reverted to idle and set submitError.
      // Re-render the form with the inline alert — a fatal error screen here
      // would visually discard the respondent's answers.
      this.options.onError?.(toFilloError(error));
      this.focusIntent = "error";
      this.render();
      return;
    }
    if (this.hasErrors()) this.focusIntent = "error";
    this.render();
  }

  private hasErrors(): boolean {
    return Object.keys(this.engine?.getState().errors ?? {}).length > 0;
  }

  /** Re-apply a theme to the live instance — no remount, so entered data survives. */
  setTheme(theme: FormTheme | undefined): void {
    this.options.theme = theme;
    this.theme = theme;
    this.render();
  }

  /** Swap the client in place (late `client` assignment) without a remount. */
  setClient(client: FilloClient | undefined): void {
    this.options.client = client;
    this.engine?.setContext({ client });
    this.render();
  }

  /** Late-bind identify() context once the host session loads. No re-render
   *  needed — identity changes what's recorded, never what's shown. */
  setRespondent(respondent: FilloRespondent | undefined): void {
    this.options.respondent = respondent;
    this.engine?.setContext({ respondent });
  }

  /** This field's active (non-failed) in-flight count — room math and the
   *  setUploading(field, …) flip both key off it. A failed row holds no slot
   *  (it must not strand the field at permanently-full). */
  private fieldActive(fieldId: string): number {
    let n = 0;
    for (const row of this.inFlight.values())
      if (row.fieldId === fieldId && row.error === undefined) n++;
    return n;
  }

  private uploadRowsFor(fieldId: string): UploadRow[] {
    const rows: UploadRow[] = [];
    for (const [key, row] of this.inFlight) {
      if (row.fieldId === fieldId)
        rows.push({
          key,
          name: row.name,
          size: row.size,
          fraction: row.fraction,
          error: row.error,
          tooLarge: row.tooLarge,
        });
    }
    return rows;
  }

  /** Cancel/retry/dismiss one row by its per-file key (audit P0.3) — the
   *  per-file counterpart of setValueInternal, called from the rendered
   *  Cancel/Retry/Dismiss buttons via InternalFieldRenderContext. */
  private uploadAction = (key: string, action: "cancel" | "retry" | "dismiss"): void => {
    const row = this.inFlight.get(key);
    if (!row) return;
    if (action === "cancel") {
      row.controller.abort();
      this.inFlight.delete(key);
    } else if (action === "dismiss") {
      this.inFlight.delete(key);
    } else {
      if (row.tooLarge) return;
      this.inFlight.delete(key);
      void this.startUpload(row.fieldId, row.file, row.maxFiles);
    }
    if (this.fieldActive(row.fieldId) === 0) this.engine?.setUploading(row.fieldId, false);
    this.queueRender();
  };

  private async startUpload(fieldId: string, file: File, maxFiles: number): Promise<void> {
    const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const controller = new AbortController();
    this.inFlight.set(key, {
      fieldId,
      name: file.name,
      size: file.size,
      fraction: 0,
      file,
      controller,
      maxFiles,
    });
    this.engine?.setUploading(fieldId, true);
    this.queueRender();
    try {
      const value: FileValue =
        this.options.client && this.formId
          ? await this.options.client.uploadFile(this.formId, file, {
              fieldId,
              signal: controller.signal,
              onProgress: (progress) => {
                const row = this.inFlight.get(key);
                if (!row) return;
                // {render:false} discipline: mutate the row and re-render —
                // never rebuild the whole field per tick.
                row.fraction = progress.fraction;
                this.queueRender();
              },
            })
          : {
              fileId: `local:${file.name}:${file.size}`,
              name: file.name,
              size: file.size,
              mime: file.type || "application/octet-stream",
            };
      if (this.destroyed) return;
      this.inFlight.delete(key);
      // Re-read live data, not a snapshot — two concurrent completions must
      // not have the second overwrite the first. Single-file fields replace.
      const current =
        maxFiles > 1 && Array.isArray(this.mutableData[fieldId])
          ? (this.mutableData[fieldId] as FileValue[])
          : [];
      this.setValueInternal(fieldId, [...current, value]);
    } catch (error) {
      if (this.destroyed || controller.signal.aborted) return;
      const uploadError = toFilloError(error);
      // Provider/infrastructure failures are useful to the host via onError,
      // but their raw messages never belong in the respondent-facing row.
      const message =
        uploadError.status === 0 || (uploadError.status !== undefined && uploadError.status >= 500)
          ? DEFAULT_FIELD_STRINGS.uploadUnavailable
          : DEFAULT_FIELD_STRINGS.uploadFailed;
      const row = this.inFlight.get(key);
      if (row) row.error = message;
      // A genuine upload attempt failed — announce it, don't just note it
      // (audit P1.7): the visible row text carries no live role of its own.
      this.announceAlert(message);
      this.options.onError?.(uploadError);
    } finally {
      if (this.fieldActive(fieldId) === 0) this.engine?.setUploading(fieldId, false);
      this.queueRender();
    }
  }

  async uploadFiles(field: Extract<Field, { kind: "file_upload" }>, files: File[]): Promise<void> {
    // Display-only (not-open overlay): never start an upload session.
    if (!this.schema || this.notOpenVariant) return;
    const maxFiles = field.maxFiles ?? 1;
    const existingCount =
      maxFiles > 1 && Array.isArray(this.mutableData[field.id])
        ? (this.mutableData[field.id] as FileValue[]).length
        : 0;
    const room = Math.max(0, maxFiles - existingCount - this.fieldActive(field.id));
    const withinLimit = files.slice(0, room);
    const configuredMaxMb = field.maxFileSizeMb ?? 500;
    const maxFileSizeMb = this.uploadFileSizeLimitMb
      ? Math.min(configuredMaxMb, this.uploadFileSizeLimitMb)
      : configuredMaxMb;
    const maxBytes = maxFileSizeMb * 1024 * 1024;
    const selected = withinLimit.filter((file) => file.size <= maxBytes);
    const oversizedFiles = withinLimit.filter((file) => file.size > maxBytes);
    const dropped = files.length - withinLimit.length;
    const oversized = withinLimit.length - selected.length;
    if (dropped > 0 || oversized > 0) {
      const notices: string[] = [];
      if (dropped > 0) {
        notices.push(
          `You can attach up to ${maxFiles} file${maxFiles === 1 ? "" : "s"}. ${dropped} ${dropped === 1 ? "file was" : "files were"} not added.`,
        );
      }
      const text = notices.join(" ");
      if (text) this.uploadNotices.set(field.id, text);
      else this.uploadNotices.delete(field.id);
      // Soft capacity/busy notice — polite, not an alert (audit P1.7).
      if (text) this.announce(text);
    } else {
      this.uploadNotices.delete(field.id);
    }
    for (const file of oversizedFiles) {
      const message = DEFAULT_FIELD_STRINGS.fileTooLarge(maxFileSizeMb);
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.inFlight.set(key, {
        fieldId: field.id,
        name: file.name,
        size: file.size,
        fraction: 0,
        error: message,
        tooLarge: true,
        file,
        controller: new AbortController(),
        maxFiles,
      });
      this.announceAlert(message);
    }
    if (selected.length === 0) {
      this.queueRender();
      return;
    }
    await Promise.all(selected.map((file) => this.startUpload(field.id, file, maxFiles)));
  }

  destroy(): void {
    this.destroyed = true;
    this.teardownDraftFlush();
    this.closeOverlays();
    this.teardownTurnstileWidget();
    for (const row of this.inFlight.values()) row.controller.abort();
    this.inFlight.clear();
    this.engine?.destroy();
    this.engine = null;
    this.target.replaceChildren();
  }

  /** Keep an optional-upload form accepting while pre-empting only file
   * controls the current definition envelope says the server will refuse. */
  private storageBlocked(): boolean {
    return this.uploadsAvailable === false;
  }

  /** Add/return the phone popover teardown; called back on re-render or destroy. */
  private registerOverlay = (close: () => void): (() => void) => {
    this.overlays.add(close);
    return () => this.overlays.delete(close);
  };

  private closeOverlays(): void {
    if (this.overlays.size === 0) return;
    for (const close of Array.from(this.overlays)) {
      try {
        close();
      } catch {
        // Already gone — nothing to tear down.
      }
    }
    this.overlays.clear();
  }

  /** Route the challenge to bridge or direct mode per the server's config.
   *  Bridge (bridgeUrl present — every current server) works on any embedding
   *  domain; direct is the pre-bridge fallback for older self-hosted servers.
   *  Message contract mirrors @usefillo/react's turnstile module; keep both
   *  in sync with apps/web src/app/embed/challenge/route.ts. */
  private ensureChallengeWidget(challenge: ChallengeConfig): void {
    if (challenge.bridgeUrl) this.ensureChallengeBridge(challenge.bridgeUrl);
    else this.ensureTurnstileWidget(challenge.siteKey);
  }

  /** Idempotent per src: mounts the Fillo-hosted bridge iframe into the
   *  persistent container and wires its postMessage token flow. */
  private ensureChallengeBridge(bridgeUrl: string): void {
    if (typeof window === "undefined") return;
    let url: URL;
    try {
      url = new URL(bridgeUrl);
    } catch {
      this.handleChallengeError();
      return;
    }
    // The bridge must be a web origin we can bind postMessage checks to.
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      this.handleChallengeError();
      return;
    }
    url.searchParams.set("origin", window.location.origin);
    url.searchParams.set("theme", this.options.challengeTheme ?? "auto");
    if (this.formId && CHALLENGE_CDATA_RE.test(this.formId)) {
      url.searchParams.set("cdata", this.formId);
    }
    url.searchParams.set(
      "appearance",
      (this.options.challengeAppearance ?? "interaction-only") === "interaction-only"
        ? "interaction-only"
        : "always",
    );
    const src = url.toString();
    if (this.challengeFrame && this.challengeFrameSrc === src) return;
    // A different src (or a leftover direct widget) — start pristine. The
    // teardown swaps in a fresh container; this render pass already attached
    // the old one, so the new frame shows on the next queued render (same
    // rotate-mid-session edge the direct path has always had).
    this.teardownTurnstileWidget();
    const attempt = ++this.turnstileAttempt;
    const frame = el("iframe", {
      className: "fillo-turnstile-frame",
      attrs: {
        src,
        title: "Human verification",
        // Cloudflare's normal widget footprint; attributes so host CSS wins.
        width: "300",
        height: "65",
        referrerpolicy: "no-referrer",
      },
    });
    this.challengeFrame = frame;
    this.challengeFrameSrc = src;
    this.challengeFrameOrigin = url.origin;
    this.turnstileContainer.appendChild(frame);
    // interaction-only starts collapsed: most humans pass silently and never
    // see a box; the frame expands only when Cloudflare needs the visitor.
    this.setChallengeFrameVisible(
      (this.options.challengeAppearance ?? "interaction-only") !== "interaction-only",
    );
    const onMessage = (event: MessageEvent) => {
      if (attempt !== this.turnstileAttempt || this.destroyed) return;
      // Only the bridge frame we mounted may drive the token: exact origin
      // AND the event source must be our iframe's window.
      if (event.origin !== this.challengeFrameOrigin) return;
      if (!this.challengeFrame || event.source !== this.challengeFrame.contentWindow) return;
      const data = event.data as { type?: unknown; token?: unknown } | null;
      switch (data?.type) {
        case "fillo:challenge:ready":
          this.settleChallengeWatchdog();
          break;
        case "fillo:challenge:token":
          this.settleChallengeWatchdog();
          if (typeof data.token === "string" && data.token.length > 0) {
            this.handleChallengeToken(data.token);
          }
          // Solved: an interaction-only frame folds away again.
          if ((this.options.challengeAppearance ?? "interaction-only") === "interaction-only") {
            this.setChallengeFrameVisible(false);
          }
          break;
        case "fillo:challenge:interactive":
          // Cloudflare needs the visitor — give the widget its box.
          this.setChallengeFrameVisible(true);
          break;
        case "fillo:challenge:interactive-done":
          if ((this.options.challengeAppearance ?? "interaction-only") === "interaction-only") {
            this.setChallengeFrameVisible(false);
          }
          break;
        case "fillo:challenge:expired":
          // The bridge already re-armed its widget; drop the stale token so
          // submit waits for the fresh solve.
          this.handleChallengeToken(undefined);
          break;
        case "fillo:challenge:error":
          this.settleChallengeWatchdog();
          this.handleChallengeToken(undefined);
          this.handleChallengeError();
          break;
      }
    };
    this.challengeMessageHandler = onMessage;
    window.addEventListener("message", onMessage);
    // No ready/error/token within the window => the frame or its Cloudflare
    // script is blocked. Fail closed but VISIBLY (message + disabled submit).
    this.challengeWatchdog = window.setTimeout(() => {
      if (attempt !== this.turnstileAttempt || this.destroyed) return;
      this.handleChallengeToken(undefined);
      this.handleChallengeError();
    }, BRIDGE_READY_TIMEOUT_MS);
  }

  /** Collapse/expand the bridge frame (interaction-only mode). The frame stays
   *  mounted either way — height 0 keeps the invisible check running. */
  private setChallengeFrameVisible(visible: boolean): void {
    const frame = this.challengeFrame;
    if (!frame) return;
    frame.setAttribute("height", visible ? "65" : "0");
    if (visible) {
      frame.removeAttribute("aria-hidden");
      frame.removeAttribute("tabindex");
    } else {
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
    }
    this.turnstileContainer.setAttribute(
      "data-fillo-challenge-visible",
      visible ? "true" : "false",
    );
  }

  private settleChallengeWatchdog(): void {
    if (this.challengeWatchdog !== null && typeof window !== "undefined") {
      window.clearTimeout(this.challengeWatchdog);
    }
    this.challengeWatchdog = null;
  }

  /** Unwire and remove the bridge frame (listener, watchdog, iframe). Safe to
   *  call when nothing is mounted. */
  private teardownChallengeBridge(): void {
    if (this.challengeMessageHandler && typeof window !== "undefined") {
      window.removeEventListener("message", this.challengeMessageHandler);
    }
    this.challengeMessageHandler = null;
    this.settleChallengeWatchdog();
    this.challengeFrame?.remove();
    this.challengeFrame = null;
    this.challengeFrameSrc = null;
    this.challengeFrameOrigin = null;
  }

  /** Idempotent: at most one load+render per armed container (guarded by
   *  widget id / in-flight / already-failed); re-arms on a changed site key
   *  (mirrors react's effect, keyed on siteKey). */
  private ensureTurnstileWidget(siteKey: string): void {
    if (this.turnstileSiteKey !== siteKey) {
      this.teardownTurnstileWidget();
      this.turnstileSiteKey = siteKey;
    }
    if (this.turnstileWidgetId !== null || this.turnstileLoadInFlight || this.challengeError)
      return;
    this.turnstileLoadInFlight = true;
    const attempt = ++this.turnstileAttempt;
    loadTurnstileScript()
      .then(() => {
        if (this.destroyed || attempt !== this.turnstileAttempt) return;
        const api = turnstileGlobal();
        if (!api) {
          this.turnstileLoadInFlight = false;
          this.handleChallengeError();
          return;
        }
        // expired/timeout share resetChallengeWidget (re-arm for a fresh
        // solve) — without it either dead-ends the form unsubmittable.
        this.turnstileWidgetId = api.render(this.turnstileContainer, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => this.handleChallengeToken(token),
          "error-callback": () => {
            this.handleChallengeToken(undefined);
            this.handleChallengeError();
          },
          "expired-callback": () => this.resetChallengeWidget(),
          "timeout-callback": () => this.resetChallengeWidget(),
        });
        this.turnstileLoadInFlight = false;
      })
      .catch(() => {
        if (this.destroyed || attempt !== this.turnstileAttempt) return;
        this.turnstileLoadInFlight = false;
        this.handleChallengeError();
      });
  }

  private handleChallengeToken(token: string | undefined): void {
    this.challengeToken = token;
    if (token) this.challengeError = false;
    this.queueRender();
  }

  /** Surfaces via `.fillo-turnstile-error` AND the assertive channel — the
   *  paragraph mounts fresh with the tree, and a live region announces
   *  mutations, not initial content (same reasoning as the announce channels). */
  private handleChallengeError(): void {
    this.challengeError = true;
    this.announceAlert(DEFAULT_STRINGS.challengeUnavailable);
    this.queueRender();
  }

  /** Re-arm the SAME widget instance for a fresh solve (server rejection,
   *  expiry, or timeout) — not a teardown, the widget stays mounted. */
  private resetChallengeWidget(): void {
    this.challengeToken = undefined;
    if (this.challengeFrame && this.challengeFrameOrigin) {
      // Bridge mode: the widget lives in the frame — tell it to re-arm.
      this.challengeFrame.contentWindow?.postMessage(
        { type: "fillo:challenge:reset" },
        this.challengeFrameOrigin,
      );
    } else if (this.turnstileWidgetId) {
      turnstileGlobal()?.reset(this.turnstileWidgetId);
    }
    this.queueRender();
  }

  /** Fully remove any active/pending widget (mirrors react's unmount effect):
   *  the script stays cached, but the widget and its token are gone, and a
   *  fresh container replaces the old one for a pristine next mount. Safe to
   *  call when nothing is active. */
  private teardownTurnstileWidget(): void {
    if (
      this.turnstileWidgetId === null &&
      !this.turnstileLoadInFlight &&
      this.challengeFrame === null
    ) {
      return;
    }
    this.turnstileAttempt++;
    this.teardownChallengeBridge();
    const api = turnstileGlobal();
    if (this.turnstileWidgetId && api) {
      try {
        api.remove(this.turnstileWidgetId);
      } catch {
        // Widget already gone (navigated away) — nothing to clean up.
      }
    }
    this.turnstileWidgetId = null;
    this.turnstileLoadInFlight = false;
    this.challengeError = false;
    this.turnstileContainer = newTurnstileContainer();
    // A stale token belonged to the widget just removed — a returning visit
    // must re-solve, never submit on a leftover solve.
    this.challengeToken = undefined;
  }

  private captureFocus(): FocusDescriptor | null {
    if (typeof document === "undefined") return null;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !this.element.contains(active)) return null;
    const desc: FocusDescriptor = {};
    if (active.id) desc.id = active.id;
    const rankOpt = active.getAttribute("data-fillo-rank-opt");
    if (rankOpt) {
      desc.rankOpt = rankOpt;
      desc.rankDir = active.getAttribute("data-fillo-rank-dir") ?? undefined;
    }
    const fieldEl = active.closest("[data-field]");
    if (fieldEl) {
      desc.fieldId = fieldEl.getAttribute("data-field") ?? undefined;
      desc.controlIndex = Array.from(
        fieldEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).indexOf(active);
    }
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      try {
        desc.selStart = active.selectionStart;
        desc.selEnd = active.selectionEnd;
      } catch {
        // number/date/email inputs don't expose a text selection range.
      }
    }
    return desc.id || desc.rankOpt || desc.fieldId ? desc : null;
  }

  private restoreFocus(desc: FocusDescriptor): void {
    if (typeof document === "undefined") return;
    let target: HTMLElement | null = null;
    // Ranking: put focus back on the moved option's button (or its enabled
    // sibling, since the pressed direction may now be disabled at an end).
    if (desc.rankOpt) {
      const buttons = Array.from(
        this.element.querySelectorAll<HTMLButtonElement>("[data-fillo-rank-opt]"),
      ).filter((b) => b.getAttribute("data-fillo-rank-opt") === desc.rankOpt);
      target =
        buttons.find(
          (b) => b.getAttribute("data-fillo-rank-dir") === desc.rankDir && !b.disabled,
        ) ??
        buttons.find((b) => !b.disabled) ??
        null;
    }
    if (!target && desc.id) target = document.getElementById(desc.id);
    if (!target && desc.fieldId != null && desc.controlIndex != null && desc.controlIndex >= 0) {
      const fieldEl = Array.from(this.element.querySelectorAll<HTMLElement>("[data-field]")).find(
        (e) => e.getAttribute("data-field") === desc.fieldId,
      );
      if (fieldEl) {
        target =
          Array.from(fieldEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))[
            desc.controlIndex
          ] ?? null;
      }
    }
    if (!target || typeof target.focus !== "function") return;
    target.focus();
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      desc.selStart != null
    ) {
      try {
        target.setSelectionRange(desc.selStart, desc.selEnd ?? desc.selStart);
      } catch {
        // Selection unsupported for this input type — focus alone is enough.
      }
    }
  }

  private applyFocus(
    intent: "page" | "error" | GroupFocusIntent | null,
    captured: FocusDescriptor | null,
  ): void {
    if (typeof document === "undefined") return;
    if (intent === "error") {
      // Keep validation local to the form: focusing the first invalid control
      // announces its label plus aria-describedby guidance without duplicating
      // every message in an aggregate error panel.
      const invalid = this.element.querySelector<HTMLElement>('[aria-invalid="true"]');
      invalid && focusableWithin(invalid)?.focus();
      return;
    }
    if (intent === "page") {
      const heading = this.element.querySelector<HTMLElement>(".fillo-page-title, .fillo-title");
      const target = heading ?? this.element.querySelector<HTMLElement>(".fillo-blocks");
      if (target) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus?.();
      }
      return;
    }
    if (intent) {
      this.applyGroupFocus(intent);
      return;
    }
    if (captured) this.restoreFocus(captured);
  }

  /** Focus target after a repeating-group Add/Remove (contract decision 9),
   *  resolved by POSITION against the tree render() just produced — unlike
   *  ranking's restoreFocus precedent, the target card either didn't exist
   *  yet at capture time (Add) or is a different card than whatever was
   *  clicked (Remove), so a generic FocusDescriptor can't express either.
   *  Falls back to the Add button, which always exists once a group has
   *  rendered at all — never strands focus on <body>. */
  private applyGroupFocus(intent: GroupFocusIntent): void {
    const groupEl = Array.from(this.element.querySelectorAll<HTMLElement>("[data-field]")).find(
      (node) => node.getAttribute("data-field") === intent.groupId,
    );
    const cards = groupEl
      ? Array.from(groupEl.querySelectorAll<HTMLElement>(".fillo-group-instance"))
      : [];
    const card = intent.cardIndex >= 0 ? cards[intent.cardIndex] : undefined;
    if (card) {
      const target = intent.intoControl ? (firstChildControl(card) ?? card) : card;
      target.focus();
      return;
    }
    groupEl?.querySelector<HTMLElement>(".fillo-group-add")?.focus();
  }

  private handleError(error: FilloError): void {
    if (this.destroyed) return;
    this.fatalError = error;
    this.phase = "error";
    this.options.onError?.(error);
    this.render(error);
  }

  /** Bounded sync exhausted: production fails closed; dev keeps local iteration. */
  private reportSyncFailure(error: FilloError): void {
    if (this.destroyed) return;
    console.warn(
      `[fillo] form sync failed${error.code ? ` (${error.code})` : ""}: ${error.message}`,
    );
    this.syncErrorNotice = error;
    const development = this.devChrome();
    if (!development || this.options.renderError) {
      this.genericUnavailable = !development;
      this.handleError(error);
      return;
    }
    this.options.onError?.(error);
    if (development) this.render();
  }

  /** A resolved live snapshot stays available while developers get remediation. */
  private reportSyncNotice(error: FilloError): void {
    if (this.destroyed) return;
    console.warn(
      `[fillo] form sync needs attention${error.code ? ` (${error.code})` : ""}: ${error.message}`,
    );
    this.syncErrorNotice = error;
    this.options.onError?.(error);
    if (this.devChrome()) this.render();
  }

  /** Submit-time verification failed: keep the form/answers for a safe retry. */
  private reportSubmitSyncFailure(error: FilloError): void {
    if (this.destroyed) return;
    console.warn(
      `[fillo] form sync failed${error.code ? ` (${error.code})` : ""}: ${error.message}`,
    );
    this.syncErrorNotice = error;
  }

  // A macrotask, not a microtask (ledger #4, docs/decisions/input-quality.md):
  // a text field's blur fires "change" -> setValue -> this full-tree rebuild,
  // and if the respondent's next action is a pointer click elsewhere (e.g. a
  // rating star), that click is a SEPARATE, later task from the blur's — but
  // a microtask always drains before any later task runs, including that
  // click. A microtask-deferred rebuild still replaces the click's target
  // node before the click is dispatched, so Chromium/WebKit never fire it at
  // all (the click is silently swallowed — click doesn't fire when the
  // mousedown target was detached before mouseup: w3c/uievents#141).
  // setTimeout is the standard fix for exactly this "blur beats click" race:
  // scheduled during the blur's own task, it reliably runs BEHIND whatever
  // pointer/click tasks were already in flight for the same gesture, so an
  // in-flight click lands on the pre-rebuild node first.
  private queueRender(): void {
    if (this.renderQueued || this.destroyed) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, 0);
  }

  private render(error?: FilloError): void {
    if (this.destroyed) return;
    const intent = this.focusIntent;
    this.focusIntent = null;
    // Explicit intents (error/page) override plain restore; otherwise remember
    // the focused control so it survives the teardown below.
    const captured = intent ? null : this.captureFocus();
    // Any open overlay is torn out with the tree — close it so its window/
    // document listeners don't leak.
    this.closeOverlays();
    // renderForm() (which owns the turnstile slot) only runs from "ready" and
    // not once status is "submitted" — every other branch leaves no slot for
    // the widget this pass, so tear it down rather than leave it dangling
    // (mirrors react's unmount effect). No-op when nothing is active.
    const willRenderForm = this.phase === "ready" && this.engine?.getState().status !== "submitted";
    if (!willRenderForm) this.teardownTurnstileWidget();
    this.element.replaceChildren();
    if (this.phase === "loading") {
      const loading = el("div", {
        className: `fillo-form fillo-form--loading ${this.options.className ?? ""}`,
        attrs: { "aria-busy": "true", "data-fillo": "root", "data-state": "loading" },
      });
      themeStyle(loading, this.theme);
      appendChildren(loading, [
        el("div", { className: "fillo-skeleton" }),
        el("div", { className: "fillo-skeleton" }),
        el("div", { className: "fillo-skeleton fillo-skeleton--short" }),
      ]);
      this.element.appendChild(loading);
      return;
    }

    const activeError = error ?? this.fatalError;
    if (this.phase === "error" && activeError) {
      const targetMessage =
        activeError.code === "form_target_required" && this.devChrome()
          ? `${activeError.message} (${activeError.code})`
          : null;
      const errorView =
        this.options.renderError?.(activeError) ??
        el("div", {
          className: "fillo-form fillo-form--error",
          text:
            targetMessage ??
            (this.genericUnavailable
              ? "This form is unavailable."
              : loadFailureMessage(activeError)),
        });
      if (!errorView.hasAttribute("data-fillo")) errorView.setAttribute("data-fillo", "root");
      if (!errorView.hasAttribute("data-state")) errorView.setAttribute("data-state", "error");
      if (activeError.code && !errorView.hasAttribute("data-error-code")) {
        errorView.setAttribute("data-error-code", activeError.code);
      }
      if (!errorView.hasAttribute("role")) errorView.setAttribute("role", "alert");
      themeStyle(errorView, this.theme);
      this.element.appendChild(errorView);
      return;
    }

    if (this.phase === "closed") {
      const closed = el("div", {
        className: `fillo-form fillo-form--closed ${this.options.className ?? ""}`,
        attrs: { "data-fillo": "root", "data-state": "closed" },
      });
      themeStyle(closed, this.theme);
      closed.appendChild(
        el("p", { className: "fillo-closed", text: "This form is no longer accepting responses." }),
      );
      this.element.appendChild(closed);
      return;
    }

    if (this.notOpenVariant && this.schema) {
      this.element.appendChild(this.renderNotOpen(this.notOpenVariant));
      if (this.brandingVisible())
        this.element.appendChild(poweredByEl(this.fetchedBrandLabel, this.fetchedBrandHref));
      return;
    }

    if (!this.schema) return;
    if (this.engine?.getState().status === "submitted") {
      const api = this.api();
      const state = this.engine.getState();
      const success = this.options.renderSuccess?.(api) ?? defaultSuccess(this.schema);
      success.setAttribute("data-fillo", success.getAttribute("data-fillo") ?? "root");
      if (this.formId && !success.hasAttribute("data-fillo-form-id")) {
        success.setAttribute("data-fillo-form-id", this.formId);
      }
      success.setAttribute("data-state", success.getAttribute("data-state") ?? "submitted");
      // No forced role="status"/aria-live (audit P2.1/P2.8): the visible
      // success UI is unchanged, but the announcement now routes through the
      // persistent channel below instead of a live region that only exists
      // for the one render it's created on.
      if (!success.hasAttribute("tabindex")) success.setAttribute("tabindex", "-1");
      themeStyle(success, this.theme);
      this.element.appendChild(success);
      if (this.brandingVisible())
        this.element.appendChild(poweredByEl(this.fetchedBrandLabel, this.fetchedBrandHref));
      if (!state.restoredSubmission && !this.liveSubmissionHandled) {
        this.liveSubmissionHandled = true;
        const redirect = safeHttpUrl(this.schema.settings.redirectUrl);
        if (redirect && typeof window !== "undefined") window.location.assign(redirect);
        else {
          success.focus();
          this.announce(success.textContent ?? "");
        }
      }
      return;
    }

    if (this.devChrome()) {
      appendChildren(
        this.element,
        devChromeEls({
          preview: this.options.preview === true,
          devNotices: this.options.devNotices,
          syncError: this.syncErrorNotice,
          staged: this.stagedNotice,
          draft: this.draftNotice,
          warningUrl: this.syncWarningUrl,
          formUrl: this.syncFormUrl,
          noClient: !this.options.client && !this.options.renderOnly,
        }),
      );
    }
    this.element.appendChild(this.renderForm());
    if (this.brandingVisible())
      this.element.appendChild(poweredByEl(this.fetchedBrandLabel, this.fetchedBrandHref));
    this.applyFocus(intent, captured);
  }

  /** Server-driven and not client-removable; defaults on until the server says. */
  private brandingVisible(): boolean {
    return this.fetchedPoweredBy ?? true;
  }

  /** Production not-accepting chrome: a calm state backed by the real form
   * rendered display-only — honest about the state and impossible to fill.
   * The default CSS hides the preview; hosts without it still get the layered
   * safety contract. The wrapper is inert + aria-hidden +
   * pointer-events:none, the preview markup nests every control in a natively
   * disabled fieldset (see renderForm), and the engine behind it was created
   * without a client/formId/resolver — so nothing inside can focus, submit,
   * start an upload session, or touch saved-progress drafts. */
  private renderNotOpen(variant: "notOpen" | "closed"): HTMLElement {
    const root = el("div", {
      className: `fillo-form fillo-form--not-open ${this.options.className ?? ""}`,
      attrs: { "data-fillo": "root", "data-state": "closed" },
    });
    themeStyle(root, this.theme);
    const preview = el("div", {
      className: "fillo-not-open-preview",
      attrs: { "aria-hidden": "true", inert: "" },
    });
    preview.appendChild(this.renderForm());
    const card = el("div", {
      className: "fillo-not-open-card",
      attrs: { role: "status", "data-fillo": "not-open-card" },
    });
    card.appendChild(
      el("h2", {
        className: "fillo-not-open-title",
        text: variant === "closed" ? DEFAULT_STRINGS.closedTitle : DEFAULT_STRINGS.notOpenTitle,
      }),
    );
    card.appendChild(
      el("p", {
        className: "fillo-not-open-body",
        text: variant === "closed" ? DEFAULT_STRINGS.closed : DEFAULT_STRINGS.notOpenBody,
      }),
    );
    appendChildren(root, [preview, card]);
    return root;
  }

  private renderForm(): HTMLElement {
    const api = this.api();
    // Display-only (not-open overlay): a plain div root — no form element to
    // submit — with every control inside a natively disabled fieldset, so the
    // preview is unfocusable and unfillable even without the stylesheet or
    // inert support.
    const displayOnly = this.notOpenVariant !== null;
    // A required challenge appears on the submit page only, never in the
    // not-open preview (react's NotOpenOverlay omits `challenge` too).
    const challengeRequired = Boolean(this.challenge);
    const showChallenge = !displayOnly && challengeRequired && api.isLastPage;
    const form = el(displayOnly ? "div" : "form", {
      className: `fillo-form ${this.options.className ?? ""}`,
      attrs: {
        "data-fillo": displayOnly ? "preview-form" : "root",
        "data-state": displayOnly ? "preview" : api.status,
        "data-page": String(api.pageIndex + 1),
      },
    });
    if (!displayOnly && this.formId) form.setAttribute("data-fillo-form-id", this.formId);
    form.toggleAttribute("data-last-page", api.isLastPage);
    themeStyle(form, this.theme);
    const advance = () => {
      if (api.isLastPage) void this.submit();
      else this.next();
    };
    if (!displayOnly) {
      const formEl = form as HTMLFormElement;
      formEl.noValidate = true;
      formEl.addEventListener("submit", (event) => {
        event.preventDefault();
        advance();
      });
    }
    const content = displayOnly
      ? form.appendChild(
          el("fieldset", { className: "fillo-not-open-fields", attrs: { disabled: "" } }),
        )
      : form;

    const restoreState = this.engine?.getState();
    if (restoreState?.resumedDraft || restoreState?.editingPrevious) {
      // Visible banner, no live role (audit P2.8: role="status" mounting
      // with the rest of the tree likely never announces anyway) — the
      // engine.subscribe() transition above fires the one-shot announce().
      const resume = el("div", {
        className: "fillo-resume",
        attrs: { "data-fillo": "resume" },
      });
      resume.appendChild(
        el("span", {
          className: "fillo-resume-text",
          text: restoreState.editingPrevious
            ? DEFAULT_STRINGS.editNotice
            : DEFAULT_STRINGS.resumeNotice,
        }),
      );
      const clear = el("button", {
        className: "fillo-resume-clear",
        text: DEFAULT_STRINGS.resumeStartOver,
        attrs: { type: "button" },
      });
      clear.addEventListener("click", () => this.resetDraft());
      resume.appendChild(clear);
      content.appendChild(resume);
    }

    if (api.pageCount > 1 && this.schema?.settings.showProgress !== false) {
      // Progress over the REACHABLE page sequence (the same walk render/
      // validate/navigation share, audit P2.2), not raw pageIndex/pageCount:
      // a jumped-over page no longer inflates the denominator, and the bar
      // reaches 100% only on the terminal page. If the current page is
      // transiently off the sequence, clamp within the sequence length.
      const seq = reachablePageSequence(api.form, api.data);
      const total = Math.max(seq.length, 1);
      const pos = seq.indexOf(api.page.id);
      const step = pos >= 0 ? pos + 1 : Math.min(api.pageIndex + 1, total);
      const progress = el("div", {
        className: "fillo-progress-track",
        attrs: {
          role: "progressbar",
          "data-fillo": "progress",
          "aria-label": api.form.title || "Form progress",
          "aria-valuemin": "1",
          "aria-valuemax": String(total),
          "aria-valuenow": String(step),
        },
      });
      progress.appendChild(
        el("div", { className: "fillo-progress-fill", attrs: { "data-fillo": "progressFill" } }),
      );
      (progress.firstElementChild as HTMLElement | null)?.style.setProperty(
        "--fillo-progress-value",
        `${(step / total) * 100}%`,
      );
      content.appendChild(progress);
    }

    if (api.pageIndex === 0) {
      const header = el("header", { className: "fillo-header", attrs: { "data-fillo": "header" } });
      if (api.form.title) {
        header.appendChild(
          el("h1", {
            className: "fillo-title",
            text: api.form.title,
            attrs: { "data-fillo": "title" },
          }),
        );
      }
      if (api.form.description) {
        header.appendChild(
          el("p", {
            className: "fillo-form-description",
            text: api.form.description,
            attrs: { "data-fillo": "description" },
          }),
        );
      }
      content.appendChild(header);
    } else if (api.page.title) {
      content.appendChild(
        el("h2", {
          className: "fillo-page-title",
          text: api.page.title,
          attrs: { "data-fillo": "pageTitle" },
        }),
      );
    }

    const blocks = el("div", { className: "fillo-blocks", attrs: { "data-fillo": "blocks" } });
    for (const block of api.blocks) {
      const rendered = this.renderBlock(pipeBlock(block, this.mutableData, api.form), api);
      if (rendered) blocks.appendChild(rendered);
    }
    content.appendChild(blocks);

    // A display-only preview can't submit, so it carries no honeypot trap.
    if (!displayOnly) {
      const hp = el("input", {
        className: "fillo-hp",
        attrs: {
          type: "text",
          name: "fillo_hp_field",
          tabindex: "-1",
          autocomplete: "off",
          "aria-hidden": "true",
        },
      });
      // Inline via CSSOM so the trap stays invisible without the stylesheet and
      // under strict CSP. Off-screen, never display:none — bots check for that.
      hp.style.position = "absolute";
      hp.style.left = "-9999px";
      hp.style.top = "auto";
      hp.style.width = "1px";
      hp.style.height = "1px";
      hp.style.opacity = "0";
      hp.style.overflow = "hidden";
      hp.style.pointerEvents = "none";
      hp.addEventListener("input", () => {
        this.hpValue = hp.value;
      });
      content.appendChild(hp);
    }

    // Human-verification challenge — only when required and on the submit
    // page, so a challenge-off form loads zero third-party JS. Submit stays
    // disabled until solved (see the primary button below).
    if (showChallenge) {
      const slot = el("div", {
        className: "fillo-turnstile-slot",
        attrs: { "data-fillo": "turnstile-slot" },
      });
      // Re-attach (move, not recreate) — preserves Cloudflare's iframe.
      slot.appendChild(this.turnstileContainer);
      if (this.challengeError) {
        slot.appendChild(
          el("p", {
            className: "fillo-turnstile-error",
            attrs: { role: "alert" },
            text: DEFAULT_STRINGS.challengeUnavailable,
          }),
        );
      }
      content.appendChild(slot);
      this.ensureChallengeWidget(this.challenge!);
    } else if (
      this.turnstileWidgetId !== null ||
      this.turnstileLoadInFlight ||
      this.challengeFrame !== null
    ) {
      // Was showing (e.g. "Back" off the submit page) — a removed widget
      // can't arm submit, so tear it down rather than leave it orphaned.
      this.teardownTurnstileWidget();
    }

    const submitError =
      api.status === "error"
        ? "This form can't submit right now. Please try again in a moment."
        : this.engine?.getState().submitError;
    if (submitError) {
      const alert = el("p", {
        className: "fillo-submit-error",
        attrs: { role: "alert" },
        text: submitError,
      });
      // Dev-chrome deep-link rendered WITH a submit failure — but only when the
      // displayed failure is the one it explains: the submit-time resync
      // refused a draft whose standing blocker is storage. Never glued onto
      // transport/challenge errors. Scheme-guarded like every sync URL.
      const fixUrl =
        this.devChrome() &&
        this.resolutionFailureCode === "form_not_published" &&
        this.syncWarningCode === "storage_required"
          ? safeHttpUrl(this.syncWarningUrl)
          : null;
      if (fixUrl) {
        alert.append(" Connect storage: ");
        alert.appendChild(
          el("a", {
            text: fixUrl,
            attrs: { href: fixUrl, target: "_blank", rel: "noopener noreferrer" },
          }),
        );
      }
      content.appendChild(alert);
    }

    const autoSubmit = api.form.settings.submitMode === "auto";
    const showPrimaryButton =
      !autoSubmit ||
      !api.isLastPage ||
      needsExplicitSubmit(visibleFields(api.form, api.data)) ||
      // A challenge needs an explicit Submit even on an otherwise button-less
      // auto-submit form — you can't one-tap past a human check.
      showChallenge;
    const showFooter = showPrimaryButton || (api.pageCount > 1 && !api.isFirstPage);
    if (showFooter) {
      const footer = el("footer", { className: "fillo-footer", attrs: { "data-fillo": "footer" } });
      if (api.pageCount > 1 && !api.isFirstPage) {
        const back = el("button", {
          className: "fillo-button fillo-button--ghost",
          text: "Back",
          attrs: { type: "button", "data-fillo": "button" },
        });
        back.addEventListener("click", () => this.back());
        footer.appendChild(back);
      }
      if (showPrimaryButton) {
        const submit = el("button", {
          className: "fillo-button fillo-button--primary",
          text:
            api.status === "submitting"
              ? "Submitting..."
              : api.isLastPage
                ? (api.form.settings.submitLabel ?? "Submit")
                : "Next",
          attrs: { type: "submit", "data-fillo": "button" },
        });
        submit.toggleAttribute(
          "disabled",
          api.status === "submitting" ||
            this.engine?.getState().uploading === true ||
            // Wait for the human check before enabling submit (never "Next").
            // The server rejects a tokenless submit regardless — this is UX only.
            (showChallenge && !this.challengeToken),
        );
        submit.addEventListener("click", (event) => {
          event.preventDefault();
          advance();
        });
        footer.appendChild(submit);
      }
      content.appendChild(footer);
    }
    return form;
  }

  /** The per-kind renderer for a field: host `components`/`customComponents`
   *  overrides win, else the shipped default. Factored out of renderBlock so
   *  a repeating group's synthesized child contexts (renderChildField below)
   *  dispatch through the exact SAME rule instead of a parallel, override-
   *  blind copy — "the existing per-block path" contract decision 8 asks
   *  group instances to render through. */
  private fieldRenderer(field: Field): FieldRenderer | undefined {
    return field.kind === "custom"
      ? (this.options.customComponents?.[field.component] ?? this.options.components?.custom)
      : (this.options.components?.[field.kind] ?? defaultFieldRenderer);
  }

  /** Threaded to a repeating group's synthesized child contexts so they
   *  render through this SAME dispatch instead of the module-level default
   *  alone (which would silently skip host per-kind overrides). */
  private renderChildField = (context: FieldRenderContext): HTMLElement | null => {
    return this.fieldRenderer(context.field)?.(context) ?? null;
  };

  /** Threaded to a repeating group's Add/Remove buttons: records where focus
   *  belongs once the write they just made reaches the deferred
   *  queueRender() rebuild — applyFocus/applyGroupFocus consume it exactly
   *  like the "page"/"error" intents set elsewhere in this class. */
  private setGroupFocus = (intent: GroupFocusIntent): void => {
    this.focusIntent = intent;
  };
  private renderBlock(block: Block, api: FilloDomApi): HTMLElement | null {
    if (!isField(block)) return renderContent(block);
    const setValue = (value: FieldValue, options?: { render?: boolean }) => {
      this.setValueInternal(block.id, value, options);
      if (options?.render === false) return;
      const autoCtx = {
        form: api.form,
        data: api.data,
        // dom's status union adds render phases; non-"idle" is a no anyway.
        status: api.status as CoreFormStatus,
        isLastPage: api.isLastPage,
        uploading: this.engine?.getState().uploading === true,
      };
      if (shouldAutoSubmit(block, value, autoCtx)) void this.submit();
    };
    const context: InternalFieldRenderContext = {
      field: block,
      value: api.data[block.id],
      error:
        api.errors[block.id] === REQUIRED_FIELD_MESSAGE
          ? requiredFieldMessage(block, DEFAULT_FIELD_STRINGS)
          : api.errors[block.id],
      ids: fieldIds(this.instanceId, block.id),
      api,
      setValue,
      uploadFiles: (field, files) => this.uploadFiles(field, files),
      uploadRows: this.uploadRowsFor(block.id),
      uploadAction: this.uploadAction,
      activeOtherFields: this.activeOtherFields,
      getValue: () => this.engine?.getState().data[block.id],
      registerOverlay: this.registerOverlay,
      uploadNotice: this.uploadNotices.get(block.id),
      uploadDisabledReason: this.options.renderOnly
        ? "render_only"
        : this.storageBlocked()
          ? "storage_unavailable"
          : undefined,
      storageFixUrl:
        this.storageBlocked() && this.devChrome() ? safeHttpUrl(this.syncWarningUrl) : null,
      announce: this.announce,
      announceAlert: this.announceAlert,
      instanceId: this.instanceId,
      renderChildField: this.renderChildField,
      setGroupFocus: this.setGroupFocus,
    };
    return this.fieldRenderer(block)?.(context) ?? null;
  }
}

function renderContent(block: ContentBlock): HTMLElement {
  switch (block.kind) {
    case "heading":
      return el("h3", { className: "fillo-heading", text: block.text });
    case "paragraph":
      return el("p", { className: "fillo-paragraph", text: block.text });
    case "divider":
      return el("hr", { className: "fillo-divider" });
  }
  return el("div");
}

function defaultSuccess(schema: FormSchema): HTMLElement {
  const success = el("div", { className: "fillo-form fillo-form--success" });
  const inner = el("div", { className: "fillo-success" });
  appendChildren(inner, [
    el("div", { className: "fillo-success-mark", attrs: { "aria-hidden": "true" } }),
    el("h2", { className: "fillo-success-title", text: schema.settings.successTitle ?? "Thanks!" }),
    el("p", {
      className: "fillo-success-message",
      text: schema.settings.successMessage ?? "Your response has been recorded.",
    }),
  ]);
  success.appendChild(inner);
  return success;
}

function poweredByEl(label?: string, href?: string): HTMLElement {
  return el("a", {
    className: "fillo-powered",
    text: label ?? "Powered by Fillo",
    attrs: { href: badgeUrl(href), target: "_blank", rel: "noopener noreferrer" },
  });
}

/** Card flavor for a server not-accepting verdict: workspace lifecycle ends
 * (expired/capped) read as closed; draft/storage_required as not-open-yet.
 * Matches the React renderer's mapping. */
function overlayVariant(reason?: string): "notOpen" | "closed" {
  return reason === "expired" || reason === "capped" || reason === "storage_full"
    ? "closed"
    : "notOpen";
}

/** Development build OR a local hostname (localhost/loopback) — the shared
 * core check, because build-time NODE_ENV alone misses the standalone
 * script tag (no `process`) and local production builds (vite preview). */
function isDevEnv(): boolean {
  return isLikelyDevEnv();
}

/** Dev-only banner: a form with no client can't submit. Never rendered for
 * production respondents. */
function devNoClientEl(): HTMLElement {
  return el("div", {
    className: "fillo-devwarning",
    text:
      "No Fillo client connected — this form is render-only and won't save responses. " +
      "Pass a client to collect them in Fillo, or forward with webhooks. " +
      "(Shown only in development and preview.)",
    attrs: { role: "alert" },
  });
}

function devSyncErrorEl(error: FilloError): HTMLElement {
  return el("div", {
    className: "fillo-devwarning",
    text:
      `Form sync needs attention${error.code ? ` (${error.code})` : ""}: ${error.message} ` +
      "The safe form remains available for development.",
    attrs: { role: "alert" },
  });
}

function devStagedEl(formUrl?: string): HTMLElement {
  const node = el("div", { className: "fillo-devwarning", attrs: { role: "alert" } });
  node.append(
    "Code changes are staged, not live. This page shows your draft, while respondents " +
      "still get the live version. ",
  );
  const publishUrl = safeHttpUrl(formUrl);
  if (publishUrl) {
    node.appendChild(
      el("a", {
        text: "Review and publish in Fillo",
        attrs: { href: publishUrl, target: "_blank", rel: "noopener noreferrer" },
      }),
    );
    node.append(".");
  } else {
    node.append("Review and publish the changes in Fillo.");
  }
  return node;
}

/** Dev-only: the form renders locally, but production submissions would fail.
 * A storage blocker wins over the form overview because it must be resolved
 * first; otherwise the developer gets a direct path to the Publish action. */
function devDraftEl(warningUrl?: string, formUrl?: string): HTMLElement {
  const node = el("div", { className: "fillo-devwarning", attrs: { role: "alert" } });
  node.append(
    "Draft form preview — the form renders for local testing, but Fillo will reject " +
      "the submission and save no response until you publish it. ",
  );
  const storageUrl = safeHttpUrl(warningUrl);
  const publishUrl = safeHttpUrl(formUrl);
  if (storageUrl) {
    node.appendChild(
      el("a", {
        text: "Connect storage to publish",
        attrs: { href: storageUrl, target: "_blank", rel: "noopener noreferrer" },
      }),
    );
    node.append(". ");
  } else if (publishUrl) {
    node.appendChild(
      el("a", {
        text: "Open in Fillo to publish",
        attrs: { href: publishUrl, target: "_blank", rel: "noopener noreferrer" },
      }),
    );
    node.append(". ");
  }
  node.append("(Shown only in development and preview.)");
  return node;
}

/** Small, unmissable marker that this render has developer preview chrome on.
 * Rendered only for an explicit `preview` option, so it survives
 * `devNotices: false` — a forced preview surface must stay visibly one. */
function previewBadgeEl(): HTMLElement {
  return el("span", {
    className: "fillo-preview-badge",
    text: "Preview",
    attrs: { "data-fillo": "preview-badge" },
  });
}

/** One-time guard: `preview` left on in a production build is usually a
 * forgotten option. The contract stays intact either way — preview is cosmetic
 * only and never changes where submissions go or whether they are accepted —
 * but respondents shouldn't be looking at a Preview badge. */
let warnedPreviewInProduction = false;
function warnPreviewInProduction(): void {
  if (warnedPreviewInProduction || isBuildTimeDevEnv()) return;
  warnedPreviewInProduction = true;
  console.warn(
    "[fillo] `preview` is enabled in a production build. Preview is cosmetic only — it shows " +
      "developer chrome and never changes where submissions go or whether they are accepted — " +
      "but remove it before respondents see this page.",
  );
}

interface DevChromeState {
  preview: boolean;
  devNotices?: boolean;
  syncError: FilloError | null;
  staged: boolean;
  draft: boolean;
  warningUrl?: string;
  formUrl?: string;
  noClient: boolean;
}

/**
 * The one dev-chrome surface. Returns the Preview badge (explicit `preview`
 * only) plus AT MOST one notice — stacking every applicable warning buried
 * the actionable one, so the most relevant wins:
 * sync-error > staged > draft > no-client. The caller gates it behind the
 * dev-chrome check; production respondents never reach it. Matches the React
 * renderer's DevChrome precedence.
 */
function devChromeEls(state: DevChromeState): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (state.preview) nodes.push(previewBadgeEl());
  if (state.devNotices === false) return nodes;
  if (state.syncError) nodes.push(devSyncErrorEl(state.syncError));
  else if (state.staged) nodes.push(devStagedEl(state.formUrl));
  else if (state.draft) nodes.push(devDraftEl(state.warningUrl, state.formUrl));
  else if (state.noClient) nodes.push(devNoClientEl());
  return nodes;
}

/** Status-aware default for the built-in error view, so an integrating dev can
 * tell 404 from a network failure without raw server text reaching respondents
 * (parity with the React renderer's strings). renderError and onError still
 * receive the exact FilloError. */
function loadFailureMessage(error: FilloError): string {
  if (error.status === 404) return DEFAULT_STRINGS.loadFailedNotFound;
  if (error.status === 0) return DEFAULT_STRINGS.loadFailedNetwork;
  if (error.status === 422) return DEFAULT_STRINGS.renderFailed;
  return DEFAULT_STRINGS.loadFailed;
}

function formTargetRequiredError(): FilloError {
  return new FilloError(
    "This form has no Fillo target. Pass formId with the schema, use a defineForm() value with client, or set renderOnly for a non-submitting preview.",
    422,
    undefined,
    "form_target_required",
  );
}

function toFilloError(error: unknown): FilloError {
  if (isFilloError(error)) return error;
  return new FilloError(error instanceof Error ? error.message : String(error), 0);
}

export function renderForm(target: HTMLElement | string, options: RenderFormOptions): FilloDomForm {
  const element = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!element) throw new FilloError(`Fillo mount target not found: ${String(target)}`, 0);
  const internalOptions: InternalRenderFormOptions = {
    ...(options as InternalRenderFormOptions),
    initialData: options.initialData ?? {},
  };
  return new DomFormController(element, internalOptions);
}

export function createFormElement(options: RenderFormOptions): HTMLElement {
  const host = el("div");
  renderForm(host, options);
  return host;
}

// The class body is evaluated at module load, so extending a bare `HTMLElement`
// would throw `ReferenceError: HTMLElement is not defined` under SSR/Node/tests
// where DOM globals are absent. Fall back to an inert base so importing this
// module is side-effect-safe; the element only ever registers in a browser.
const HTMLElementBase =
  typeof HTMLElement !== "undefined" ? HTMLElement : (class {} as unknown as typeof HTMLElement);

export class FilloFormElement extends HTMLElementBase {
  private instance: FilloDomForm | null = null;
  private assignedForm: FormSchema | CodeForm | undefined;
  private assignedClient: FilloClient | undefined;
  private assignedTheme: FormTheme | undefined;
  private assignedInitialData: ResponseData | undefined;
  private mounted = false;
  private mountScheduled = false;

  static get observedAttributes() {
    return ["publishable-key", "form-id", "data-preview", "data-render-only"];
  }

  connectedCallback() {
    this.scheduleMount();
  }

  disconnectedCallback() {
    this.instance?.destroy();
    this.instance = null;
    this.mounted = false;
  }

  // On upgrade, attributeChangedCallback fires once per observed attribute
  // *before* connectedCallback; remounting on each would run (and tear down)
  // several getForm fetches. The first mount is owned by connectedCallback — only
  // remount here once we're already mounted, and coalesce it.
  attributeChangedCallback() {
    if (this.mounted && this.isConnected) this.scheduleMount();
  }

  set form(value: FormSchema | CodeForm | undefined) {
    this.assignedForm = value;
    if (this.mounted) this.scheduleMount();
  }

  get form() {
    return this.assignedForm;
  }

  // Client swaps in place — a late `client` assignment (common when a host sets
  // properties after appending the element) must not wipe entered data.
  set client(value: FilloClient | undefined) {
    this.assignedClient = value;
    if (this.mounted && this.instance instanceof DomFormController) this.instance.setClient(value);
  }

  // Theme is re-applied to the live instance — no remount, no data loss.
  set theme(value: FormTheme | undefined) {
    this.assignedTheme = value;
    if (this.mounted && this.instance instanceof DomFormController) this.instance.setTheme(value);
  }

  set initialData(value: ResponseData | undefined) {
    this.assignedInitialData = value;
    if (this.mounted) this.scheduleMount();
  }

  // Coalesce a burst of attribute/property changes in one tick into a single
  // mount so concurrent renders (and duplicate fetches) can't happen.
  private scheduleMount() {
    if (this.mountScheduled) return;
    this.mountScheduled = true;
    queueMicrotask(() => {
      this.mountScheduled = false;
      if (this.isConnected) this.mount();
    });
  }

  /** data-preview is on when present UNLESS its value says off ("false"/"0"):
   *  frameworks stringify booleans onto data-* attributes rather than omitting
   *  them, and a stringified `false` must never enable dev chrome for real
   *  respondents. Disable by removing the attribute or setting it to "false". */
  private previewAttrEnabled(): boolean {
    const value = this.getAttribute("data-preview");
    return value !== null && value !== "false" && value !== "0";
  }

  /** Explicit local-preview mode for custom-element integrations. */
  private renderOnlyAttrEnabled(): boolean {
    const value = this.getAttribute("data-render-only");
    return value !== null && value !== "false" && value !== "0";
  }

  private mount() {
    this.instance?.destroy();
    const key = this.getAttribute("publishable-key") ?? undefined;
    const formId = this.getAttribute("form-id") ?? undefined;
    const client = this.assignedClient ?? (formId || key ? createClient({ key }) : undefined);
    this.instance = renderForm(this, {
      form: this.assignedForm,
      client,
      formId,
      theme: this.assignedTheme,
      initialData: this.assignedInitialData,
      // Same cosmetic-only contract as renderForm's `preview` option: forces
      // the dev chrome + a visible Preview badge on off-localhost surfaces,
      // and never changes where submissions go or whether they are accepted.
      // Value-aware: frameworks stringify booleans onto data-* attributes, so
      // data-preview="false"/"0" must mean OFF, not presence-implies-on.
      preview: this.previewAttrEnabled() ? true : undefined,
      renderOnly: this.renderOnlyAttrEnabled() ? true : undefined,
      onChange: (data) => this.dispatchEvent(new CustomEvent("fillo-change", { detail: { data } })),
      onSubmitted: (responseId, data) =>
        this.dispatchEvent(new CustomEvent("fillo-submit", { detail: { responseId, data } })),
      onError: (error) => this.dispatchEvent(new CustomEvent("fillo-error", { detail: { error } })),
    } as RenderFormOptions);
    this.mounted = true;
  }
}

export function registerFilloElement(name = "fillo-form"): void {
  // No custom-element registry outside a browser — no-op so SSR/Node imports and
  // the standalone bundle's top-level call are safe.
  if (typeof customElements === "undefined") return;
  if (!customElements.get(name)) customElements.define(name, FilloFormElement);
}

/**
 * Headless form engine for non-React frameworks (Vue, Svelte, vanilla): runs
 * validation, conditional logic, paging, spam checks, and submission while you
 * render every element yourself. Free like every embed method — submissions
 * default to the "headless" surface, recorded per response for measurement.
 * Pass `surface: "default"` only from a framed renderer.
 */
export function createFormController(options: FormControllerOptions): FormController {
  return coreCreateFormController({ ...options, surface: options.surface ?? "headless" });
}

export {
  createClient,
  defineForm,
  provisionWorkspace,
  FilloClient,
  FilloError,
  type ProvisionWorkspaceResult,
  type FormController,
  type FormControllerOptions,
  type FormControllerState,
  type CodeForm,
  type Field,
  type FieldKind,
  type FieldValue,
  type FileValue,
  type FormSchema,
  type FormTheme,
  type FilloClientOptions,
  type ResponseData,
};
