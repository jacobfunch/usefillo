// Explicit public barrel. Every symbol @usefillo/core publishes is named here
// on purpose — do NOT switch back to `export *`, which silently leaked
// builder-only and app-internal symbols into the SDK surface. Adding a new
// public export means adding it to this list; anything not listed stays
// package-private even if a module exports it.

// ---- Schema types + field-kind discriminants ----
export { CONTENT_KINDS, isField } from "./types.js";
export type {
  ConditionOp,
  Condition,
  FieldKind,
  ContentKind,
  BlockKind,
  SelectOption,
  BaseField,
  TextField,
  PhoneField,
  NumberField,
  ChoiceField,
  CheckboxField,
  RatingField,
  DateField,
  LinearScaleField,
  RankingField,
  MatrixField,
  SignatureField,
  HiddenField,
  CalcExpr,
  CalculatedField,
  RepeatingGroupField,
  GroupInstanceValue,
  FileUploadField,
  CustomField,
  Field,
  HeadingBlock,
  ParagraphBlock,
  DividerBlock,
  ContentBlock,
  Block,
  FormPage,
  JumpRule,
  ResponseLimit,
  TrustPolicy,
  FormSettings,
  FormSchema,
  FormTheme,
  FormBranding,
  FileValue,
  JsonValue,
  FieldValue,
  ResponseData,
  UploadStatus,
  UploadTransport,
  UploadSession,
} from "./types.js";

// ---- Conditional visibility + response scoping ----
export {
  isBlockVisible,
  visibleBlocks,
  visiblePageBlocks,
  allFields,
  responseScopeValue,
  visibleFields,
  // Repeating groups (logic depth P3): THE scoped per-instance child
  // visibility helper both renderers and validateResponse share.
  visibleGroupChildren,
  // Page flow (jumps + early end): the shared engine client render, server
  // validate, and the funnel all agree through.
  conditionsMet,
  resolveNextPage,
  reachablePageSequence,
  reachablePageIds,
  reachableFieldIds,
  reachableFields,
  isTerminalPage,
} from "./logic.js";
export type { NextPage } from "./logic.js";

// ---- Response validation ----
export { validateField, validateResponse } from "./validation.js";
export type { ValidationResult } from "./validation.js";

// ---- Calculated fields (logic depth P2) ----
export { evaluateCalc, computeCalculated } from "./calc.js";

// ---- Schema normalization + version constants ----
export {
  FILLO_SCHEMA_VERSION,
  FILLO_SDK_VERSION,
  FILLO_MIN_SDK_VERSION,
  FILLO_CHALLENGE_MIN_SDK_VERSION,
  FILLO_CALC_MIN_SDK_VERSION,
  FILLO_GROUP_MIN_SDK_VERSION,
  normalizeSettings,
  normalizeFormSchema,
  validateFormSchema,
  normalizeFormTheme,
} from "./schema-validation.js";
export type { SchemaValidationResult } from "./schema-validation.js";

// ---- Answer formatting ----
export { formatAnswer } from "./format.js";

// ---- Grouped-number display + parsing (Number field notation styles) ----
export {
  formatGroupedNumber,
  parseGroupedNumber,
  isValidPartialNumberText,
  localeForNotation,
} from "./number-format.js";

// ---- Phone metadata + helpers ----
export {
  PHONE_COUNTRIES,
  PHONE_PICKER_COUNTRIES,
  flagEmoji,
  countryByIso,
  countryByTimeZone,
  countryByDialCode,
  digitsOnly,
  formatNational,
  toE164,
  parsePhone,
  isPossiblePhone,
  positionPhonePopover,
  PHONE_POPOVER_VIEWPORT_GAP,
} from "./phone.js";
export type {
  PhoneCountry,
  ParsedPhone,
  ParsePhoneOptions,
  PhonePopoverPlacement,
} from "./phone.js";

// ---- Block palette metadata + factories (shared by builder + renderers) ----
export { BLOCK_KIND_META, createBlock, createEmptyForm } from "./fields.js";

// ---- Declarative form-draft assembly ----
export { DRAFT_KINDS, assembleForm } from "./draft.js";
export type { FieldSpec, FormDraftSpec } from "./draft.js";

// ---- HTTP client + upload protocol ----
export {
  FilloError,
  isFilloError,
  FilloClient,
  createClient,
  provisionWorkspace,
} from "./client.js";
export type {
  FilloClientOptions,
  PublishedForm,
  ChallengeConfig,
  ChallengeTheme,
  SubmitResult,
  SubmitMeta,
  FilloRespondent,
  ResponseDraft,
  CreatedDraft,
  UploadProgress,
  UploadFileOptions,
  SyncFormResult,
  ProvisionWorkspaceResult,
} from "./client.js";

// ---- Framework-agnostic form engine ----
export { createFormController } from "./controller.js";
export type {
  FormStatus,
  FormControllerOptions,
  FormControllerState,
  FormController,
} from "./controller.js";

// ---- Auto-submit heuristics ----
export { isAutoSubmitBlock, needsExplicitSubmit, shouldAutoSubmit } from "./auto-submit.js";
export type { AutoSubmitContext } from "./auto-submit.js";

// ---- Composite-widget keyboard nav (radiogroups: choice, rating, scale, matrix) ----
export { radioGroupStep } from "./radio-nav.js";

// ---- Appearance / slot contract ----
export {
  FILLO_SLOTS,
  FILLO_DATA_ATTRS,
  slotClass,
  resolveSlotClass,
  FILLO_THEME_VARS,
  resolveThemeAppearance,
} from "./appearance.js";
export type { FilloSlot, SlotState, SlotClass, FilloAppearance } from "./appearance.js";

// ---- Renderer strings ----
export {
  DEFAULT_STRINGS,
  DEFAULT_RESPONDENT_ERROR_STRINGS,
  DEFAULT_FIELD_STRINGS,
  REQUIRED_FIELD_MESSAGE,
  requiredFieldMessage,
  resolveStrings,
  respondentErrorStringsFor,
} from "./strings.js";
export type {
  FilloStrings,
  FilloFieldStrings,
  FilloRendererStrings,
  RespondentErrorStrings,
  RespondentErrorOverrides,
} from "./strings.js";

// ---- JSX-authored schema compilation ----
export {
  FilloJsxError,
  JSX_BLOCK_SPECS,
  JSX_BLOCK_COMPONENTS,
  schemaFromJsx,
  codeFormFromJsx,
} from "./jsx.js";
export type { JsxFormMeta } from "./jsx.js";

// ---- Condition builder ----
export { when } from "./when.js";
export type { WhenBuilder } from "./when.js";

// ---- Code-defined forms ----
export { defineForm, isCodeForm, contentHash, formSchemasEqual, syncCodeForm } from "./define.js";
export type { SyncedForm, CodeForm } from "./define.js";

// ---- Environment detection (shared by the renderers' dev-notice gating) ----
// isBuildTimeDevEnv is the SSR/hydration snapshot; isLikelyDevEnv the full check.
export { isBuildTimeDevEnv, isLikelyDevEnv } from "./dev-env.js";

// ---- URL prefill + answer piping ----
export { prefillFromParams } from "./prefill.js";
export { resolveText, pipeBlock } from "./piping.js";

// ---- Low-level utilities ----
export { createId } from "./ids.js";
export { Sha1, sha1Base64 } from "./sha1.js";
