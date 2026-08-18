/**
 * The Fillo form schema — the single source of truth shared by the builder,
 * the embed SDK, the API and the responses grid.
 */

// ---------- Conditions / logic ----------

export type ConditionOp =
  | "eq"
  | "neq"
  | "contains"
  | "gt"
  | "lt"
  | "answered"
  | "not_answered";

export interface Condition {
  fieldId: string;
  op: ConditionOp;
  value?: string | number | boolean;
}

/**
 * A single conditional page-flow rule (P1 logic depth). When every condition in
 * `when` matches (AND — the same evaluator as `visibleIf`), navigation leaves
 * the current page for `to`: another page's id, or the literal `"end"` to finish
 * the form early. An empty `when` is an unconditional jump. Rules are evaluated
 * top-to-bottom; the first match wins. See {@link FormPage.next}.
 */
export interface JumpRule {
  when: Condition[];
  /** Target page id, or "end" to finish the form. */
  to: string | "end";
}

// ---------- Blocks ----------

export type FieldKind =
  | "short_text"
  | "long_text"
  | "email"
  | "url"
  | "phone"
  | "number"
  | "select"
  | "multi_select"
  | "dropdown"
  | "checkbox"
  | "rating"
  | "linear_scale"
  | "ranking"
  | "matrix"
  | "signature"
  | "date"
  | "file_upload"
  | "hidden"
  | "calculated"
  | "repeating_group"
  | "custom";

export type ContentKind = "heading" | "paragraph" | "divider";

export type BlockKind = FieldKind | ContentKind;

export interface SelectOption {
  id: string;
  label: string;
  /** Optional visual hint for compact binary choices. */
  icon?: "thumbs_up" | "thumbs_down";
}

interface BaseBlock {
  /** Stable id — for fields this is the key responses are stored under. */
  id: string;
  kind: BlockKind;
  /** Show this block only when all conditions match (AND). Empty/undefined = always. */
  visibleIf?: Condition[];
}

export interface BaseField extends BaseBlock {
  kind: FieldKind;
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
}

export interface TextField extends BaseField {
  kind: "short_text" | "long_text" | "email" | "url";
  maxLength?: number;
}

export interface PhoneField extends BaseField {
  kind: "phone";
  /**
   * Country selected when the form opens (ISO-3166 alpha-2, e.g. "US"). When
   * unset the renderer falls back to the respondent's browser timezone, browser
   * locale, then the first country in the list. The respondent can always
   * change it.
   */
  defaultCountry?: string;
}

export interface NumberField extends BaseField {
  kind: "number";
  min?: number;
  max?: number;
  /** DISPLAY-ONLY rounding/padding (0–6). Deliberate divergence from
   *  calculated.decimals, which rounds the STORED value — see decision 1. */
  decimals?: number;
  prefix?: string; // display-only, via formatAnswer
  suffix?: string; // display-only, via formatAnswer
  /** Thousand separators in the SDK input. Display-only; never reaches the
   *  wire, the server, or exports. Named by the GROUP separator:
   *  - `"grouped"`: detect from the respondent's browser locale;
   *  - `"grouped-comma"`: fixed comma groups, dot decimal — `1,234.56`;
   *  - `"grouped-dot"`: fixed dot groups, comma decimal — `1.234,56`. */
  notation?: "grouped" | "grouped-comma" | "grouped-dot";
}

export interface ChoiceField extends BaseField {
  kind: "select" | "multi_select" | "dropdown";
  options: SelectOption[];
  /** Append an "Other" choice with a free-text input; the typed text is stored as the value. */
  allowOther?: boolean;
  /** Show options in a random order per respondent (the "Other" choice stays last). */
  shuffleOptions?: boolean;
}

export interface CheckboxField extends BaseField {
  kind: "checkbox";
  /** Default checkbox or a switch-style toggle. */
  appearance?: "checkbox" | "toggle";
}

export interface RatingField extends BaseField {
  kind: "rating";
  /** Number of steps, default 5. */
  max?: number;
  /** Optional analysis meaning. CSAT requires a 1–5 rating. */
  insightsMetric?: "csat";
}

export interface DateField extends BaseField {
  kind: "date";
}

export interface LinearScaleField extends BaseField {
  kind: "linear_scale";
  /** Default 1. */
  min?: number;
  /** Default 10. */
  max?: number;
  minLabel?: string;
  maxLabel?: string;
  /** Optional analysis meaning. NPS requires 0–10; CSAT requires 1–5. */
  insightsMetric?: "csat" | "nps";
}

export interface RankingField extends BaseField {
  kind: "ranking";
  options: SelectOption[];
}

export interface MatrixField extends BaseField {
  kind: "matrix";
  /** Questions (one answer per row). */
  rows: SelectOption[];
  /** Answer columns. */
  columns: SelectOption[];
}

export interface SignatureField extends BaseField {
  kind: "signature";
}

/**
 * Never rendered. Value arrives via a URL query parameter — for campaign
 * tags, user ids, A/B variants. Shown in the responses grid like any field.
 */
export interface HiddenField extends BaseField {
  kind: "hidden";
  /** Query parameter name; defaults to the field id. */
  paramName?: string;
  defaultValue?: string;
}

export interface FileUploadField extends BaseField {
  kind: "file_upload";
  /** Max files, default 1. */
  maxFiles?: number;
  /** Per-file size cap in MB. Default 500. */
  maxFileSizeMb?: number;
  /** Accepted types, e.g. ["image/*", ".pdf", "video/mp4"]. Empty = anything. */
  accept?: string[];
}

/**
 * The calculation AST (logic depth P2). A typed tree, never a formula string,
 * and the permanent expression substrate — extending it later means adding
 * ops, never replacing it. v1 is numeric-only: totals and derived values.
 *
 * `if.when` reuses the existing {@link Condition} model verbatim (AND-combined,
 * same ops) — one condition language across visibility, jumps, and calculations.
 *
 * Referenceable operand kinds (v1): `number`, `rating`, `linear_scale`, and
 * `calculated` (chaining). Nothing else coerces implicitly.
 */
export type CalcExpr =
  /** A numeric field ref. Resolves through the same visibility discipline as
   *  conditions: a logic-hidden source reads as unanswered (→ null). */
  | { op: "value"; fieldId: string }
  | { op: "const"; value: number }
  /** n-ary, length >= 1. Any null operand → null result (strict propagation). */
  | { op: "add" | "mul" | "min" | "max"; args: CalcExpr[] }
  /** Division by zero (and any non-finite result) → null. */
  | { op: "sub" | "div"; left: CalcExpr; right: CalcExpr }
  /** Half-away-from-zero at `decimals` (default 0). */
  | { op: "round"; arg: CalcExpr; decimals?: number }
  | { op: "if"; when: Condition[]; then: CalcExpr; else: CalcExpr };

/**
 * A derived numeric value computed from other answers — never an input. The
 * client recomputes it live for piping/conditions/jumps; the server recomputes
 * it authoritatively on submit, so a tampered client value is ignored by
 * construction. A null result means the field is unanswered (key absent).
 */
export interface CalculatedField extends BaseField {
  kind: "calculated";
  calc: CalcExpr;
  /** Rounds the STORED value, not just the display — one deterministic number
   *  everywhere (client preview, server recompute, grid, CSV, webhooks). */
  decimals?: number; // 0–6
  prefix?: string; // display-only, via formatAnswer
  suffix?: string; // display-only, via formatAnswer
}

/**
 * One repeated instance's answers: childId → that child's canonical value,
 * the exact same shapes a top-level field would carry (trimmed strings,
 * wire-format numerics coerced, empty answers absent — see canonical.ts). A
 * key absent from the record means that child is unanswered in this instance,
 * mirroring how a key absent from {@link ResponseData} means a top-level field
 * is unanswered.
 */
export type GroupInstanceValue = Record<string, FieldValue>;

/**
 * A repeated block of fields (logic depth P3) — "one row per guest/item",
 * respondent-controlled. Bounded by construction: `maxInstances` is required
 * (1–20); `minInstances` clamps to 0..maxInstances (default 1). The template
 * (`fields`) is capped at 12 children, drawn from a restricted v1 allowlist
 * (see schema-validation's GROUP_CHILD_ALLOWED_KINDS) — notably NOT
 * `repeating_group` itself (nesting is out of scope for v1) and NOT
 * `calculated` (no per-instance calc plumbing yet). Child ids are unique only
 * WITHIN the group (the select-option precedent, not the global block
 * namespace), so the same child id can recur across two different groups.
 *
 * Value shape (locked, roadmap decision 4):
 * `data[groupId]: GroupInstanceValue[]`, instances in respondent order. Key
 * absent ⇔ zero instances (unanswered iff `minInstances` is 0).
 *
 * Scope walls (v1, strict): a child's `visibleIf` may reference ONLY
 * same-group sibling ids, evaluated per instance over that instance's
 * canonical values (see logic.ts's `visibleGroupChildren`). Nothing outside
 * the group — top-level visibility, jumps, calc operands, piping — can
 * reference a child id; both directions are schema hard errors.
 */
export interface RepeatingGroupField extends BaseField {
  kind: "repeating_group";
  /** The repeated template. Child ids are unique WITHIN the group (the
   *  select-option precedent, not the global block namespace). */
  fields: Field[];
  /** Respondent-controlled instance count, clamped server-side. 0..maxInstances,
   *  default 1. */
  minInstances?: number;
  /** REQUIRED, 1..20 — bounded by design (also bounds the authoring-time
   *  worst-case payload-size estimate). */
  maxInstances: number;
  /** "Add another" default via strings. */
  addLabel?: string;
  /** Names one instance — "Guest" → headings "Guest 2 of 3", announcements,
   *  CSV column prefixes. Defaults to the field label. */
  itemLabel?: string;
}

/**
 * A field type Fillo doesn't ship. You define it in code and supply the
 * renderer via the SDK's `customComponents` map, keyed by `component`. The
 * value is arbitrary JSON; core only enforces `required`. Your component does
 * any richer validation and rendering — radios, sliders, address pickers,
 * anything. See the embed docs.
 */
export interface CustomField extends BaseField {
  kind: "custom";
  /** Key looked up in the SDK's `customComponents` map. */
  component: string;
  /** Arbitrary options handed to your component. */
  config?: Record<string, unknown>;
}

export type Field =
  | TextField
  | PhoneField
  | NumberField
  | ChoiceField
  | CheckboxField
  | RatingField
  | LinearScaleField
  | RankingField
  | MatrixField
  | SignatureField
  | DateField
  | FileUploadField
  | HiddenField
  | CalculatedField
  | RepeatingGroupField
  | CustomField;

export interface HeadingBlock extends BaseBlock {
  kind: "heading";
  text: string;
}

export interface ParagraphBlock extends BaseBlock {
  kind: "paragraph";
  text: string;
}

export interface DividerBlock extends BaseBlock {
  kind: "divider";
}

export type ContentBlock = HeadingBlock | ParagraphBlock | DividerBlock;

export type Block = Field | ContentBlock;

export const CONTENT_KINDS: ContentKind[] = ["heading", "paragraph", "divider"];

export function isField(block: Block): block is Field {
  return !CONTENT_KINDS.includes(block.kind as ContentKind);
}

// ---------- Form ----------

export interface FormPage {
  id: string;
  title?: string;
  blocks: Block[];
  /** Conditional page flow (P1 logic depth). Rules are evaluated top-to-bottom;
   *  the first whose conditions all match decides the next step. No rule matches
   *  → default linear next page. Absent → today's linear behavior. */
  next?: JumpRule[];
}

/**
 * Limit repeat responses. Absent = no limit (submit as often as you like).
 */
export interface ResponseLimit {
  /**
   * Who counts as the same responder:
   * - "browser": same device, anonymous — the SDK remembers this browser
   *   answered and sends a de-duplication key (ratings, polls, "was this
   *   helpful").
   * - "field": the person self-identifies by answering `field` (an email or
   *   phone field). A self-claim — unverified, soft dedup — so the hosted link
   *   and anonymous embeds can still dedupe.
   * - "identify": the identify() respondent (HMAC-verifiable). The strong
   *   path; only embedded surfaces that call identify() are recognized.
   */
  by: "browser" | "field" | "identify";
  /** The email/phone field whose answer identifies the person. `by: "field"` only. */
  field?: string;
  /**
   * Optionally sub-scope the limit by a field's answer (usually a hidden
   * article/product/order id): "one response per responder PER that value" —
   * e.g. one 👍 per visitor per article from a single shared form.
   */
  scopeField?: string;
  /**
   * A repeat from the same responder: "keep" answers with the standing
   * response (the first answer stands); "update" edits it in place (re-anchored
   * to the current schema, `response.updated` webhook, previous answers
   * prefilled for a verified respondent). "update" applies to `by: "identify"`
   * only — a self-claim/browser must not overwrite another person's response.
   */
  onRepeat: "keep" | "update";
}

/**
 * Per-form submission-trust policy. Absent = accept everything (today's
 * behavior). See docs/roadmap/07-submission-trust.md.
 */
export interface TrustPolicy {
  /** What to do with a submission whose respondent is NOT HMAC-verified.
   *  "allow" (default) accepts it normally; "quarantine" stores it withheld
   *  from every downstream consumer until an owner releases it. Declared-agent
   *  classes come in a later phase. */
  unverified?: "allow" | "quarantine";
  /** Require a human-verification challenge before accepting a submission.
   *  "off" (default) = no challenge; "turnstile" = a Cloudflare Turnstile widget
   *  that the SDK renders and the server verifies. Provider-agnostic on purpose.
   *  Independent of `unverified` — a form can require both. */
  challenge?: "off" | "turnstile";
}

export interface FormSettings {
  /**
   * Default "button": respondents submit with the footer button. "auto" hides
   * the final-page submit button in default renderers and submits after a
   * single discrete answer, e.g. a thumbs up/down article rating.
   */
  submitMode?: "button" | "auto";
  submitLabel?: string;
  successTitle?: string;
  successMessage?: string;
  redirectUrl?: string;
  showProgress?: boolean;
  /** Limit repeat responses (who counts as the same responder, and what a
   *  repeat does). Absent = no limit. See {@link ResponseLimit}. */
  responseLimit?: ResponseLimit;
  /** Per-form submission-trust policy. Absent = accept everything (today's
   *  behavior). See docs/roadmap/07-submission-trust.md. */
  trust?: TrustPolicy;
  /** Notify this address on every submission. */
  notifyEmail?: string;
  /** Send respondents a receipt (to the first answered email field). */
  sendReceipt?: boolean;
  /**
   * Save respondents' in-progress answers to Fillo (default off). The SDK
   * autosaves as they type and restores on return, so long forms survive
   * reloads and tab closes. Off by default because it stores answers before
   * the respondent chooses to submit — the form owner opts in.
   */
  saveProgress?: boolean;
  /**
   * Let workspace members read the answers a respondent has typed but not yet
   * submitted (default off; requires saveProgress). This exposes pre-submission
   * content to the owner's team, so it's a separate opt-in with its own consent
   * framing — disclose it in your privacy policy. Respondents still see the
   * "progress saved" notice. The content is visible only in the authenticated
   * dashboard; the draft token stays the only public read capability.
   */
  draftAnswersVisible?: boolean;
  /**
   * Email a respondent one "pick up where you left off" link when they leave a
   * form idle (default off; requires saveProgress). Sent at most once per
   * draft, to an address they entered or their verified account email — never
   * with any answer content. Owner opt-in.
   */
  resumeEmails?: boolean;
  /**
   * Where a resume link should land for an embedded form (http(s) only). The
   * draft reference travels in the URL fragment, which the SDK adopts on load;
   * defaults to the hosted /f page when unset.
   */
  resumeUrl?: string;
  /**
   * Email the form's notification address a daily digest of who dropped off —
   * abandoned and open draft counts, where people stalled, and verified
   * respondents by name (default off; requires notifyEmail). Never any answer
   * content or resume links.
   */
  draftDigest?: boolean;
}

export interface FormSchema {
  version: 1;
  title: string;
  description?: string;
  pages: FormPage[];
  settings: FormSettings;
}

// ---------- Theme (CSS-variable tokens applied by the SDK) ----------

export interface FormTheme {
  /** Omit to inherit the host page. Use "auto" to follow the visitor's system directly. */
  colorScheme?: "light" | "dark" | "auto";
  /** Accent for buttons, focus rings, selection. */
  primary?: string;
  background?: string;
  text?: string;
  /** Border radius scale, e.g. "8px". */
  radius?: string;
  fontFamily?: string;
}

/** Branding the server tells the SDK to render. Server-owned so the wording /
 *  link can change centrally without a new SDK release. */
export interface FormBranding {
  /** Show the "Powered by Fillo" badge. */
  poweredBy: boolean;
  /** Badge text — the SDK falls back to "Powered by Fillo" if absent. */
  label?: string;
  /** Badge link — the SDK falls back to https://fillo.so if absent. */
  href?: string;
}

// ---------- Response values ----------

/** A completed upload, referenced from response data. */
export interface FileValue {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  /** Download URL (may be storage-provider specific, e.g. a Drive link). */
  url?: string;
}

/** Any JSON — what a custom field may hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FieldValue =
  | string
  | number
  | boolean
  | string[]
  | FileValue[]
  /** Matrix answers: rowId → columnId. */
  | Record<string, string>
  /** Repeating-group answers: one record per instance, in respondent order
   *  (roadmap decision 4). A NAMED member — never smuggled through
   *  JsonValue — so the discriminated union stays exhaustiveness-checkable. */
  | GroupInstanceValue[]
  /** Custom fields hold arbitrary JSON. */
  | JsonValue
  | null
  | undefined;

export type ResponseData = Record<string, FieldValue>;

// ---------- Upload protocol (shared by client + server) ----------

export type UploadStatus = "pending" | "uploading" | "complete" | "aborted";

/**
 * How the browser should move the bytes — always straight to the workspace's own
 * storage, never through the Fillo server.
 * - "gdrive": direct to a Google Drive resumable session URL (Content-Range
 *   protocol).
 * - "s3-put": a single PUT to a presigned S3/R2 URL — straight to the bucket.
 *   Retained for sessions created by older Fillo servers.
 * - "s3-multipart": resumable S3/R2 multipart upload. The client asks Fillo
 *   for one short-lived UploadPart URL at a time; only the server can assemble
 *   the parts into an object.
 * - "box": direct to Box with a folder-scoped upload token — small files via a
 *   single multipart POST, large files via Box's chunked session (the client
 *   computes the SHA-1 digests Box requires). The server commits/verifies in the
 *   complete step.
 */
export type UploadTransport =
  | { type: "gdrive"; uploadUrl: string }
  | { type: "s3-put"; uploadUrl: string }
  | { type: "s3-multipart" }
  | { type: "box"; mode: "simple"; uploadUrl: string; token: string; folderId: string; fileName: string }
  | {
      type: "box";
      mode: "chunked";
      sessionUrl: string;
      token: string;
      folderId: string;
      fileName: string;
      size: number;
    };

export interface UploadSession {
  id: string;
  formId: string;
  fieldId: string;
  fileName: string;
  size: number;
  mime: string;
  /** Server-chosen chunk size in bytes. */
  chunkSize: number;
  /** Contiguous bytes received so far — resume from here. */
  uploadedBytes: number;
  status: UploadStatus;
  /** Defaults to the Fillo protocol when omitted. */
  transport?: UploadTransport;
  /**
   * Per-session bearer returned at creation; sent back (X-Fillo-Upload-Token)
   * on chunk/complete/status so only the creator can drive this upload.
   */
  token?: string;
  /** Set when status is "complete". */
  file?: FileValue;
}
