import type { Field } from "./types.js";

/**
 * The default English validation message for a required field left empty.
 * `validateField` returns this exact sentinel (core has no strings context),
 * and renderer layers swap it for field-aware/localized copy. Keep it
 * identical to `DEFAULT_FIELD_STRINGS.required`.
 */
export const REQUIRED_FIELD_MESSAGE = "This field is required";

/**
 * The form-chrome strings the default renderers emit, overridable as a unit so
 * a localized site never shows stray English at the submit moment.
 * Schema-authored text (labels, descriptions, success copy set in settings)
 * always wins over these defaults.
 *
 * Field-level and validation copy (required message, upload field, duplicate/
 * resume notices) lives in {@link FilloFieldStrings} — split out so this
 * documented, all-`string` surface stays stable while parametrized field
 * strings can be functions. The renderers resolve both together
 * ({@link FilloRendererStrings}); the `strings` prop overrides either.
 */
export interface FilloStrings {
  back: string;
  next: string;
  submit: string;
  submitting: string;
  uploading: string;
  /** Suffix on non-required field labels. */
  optional: string;
  /** The "Other" free-text choice. */
  other: string;
  otherPrompt: string;
  otherPlaceholder: string;
  /** Dropdown placeholder when the field sets none. */
  choosePlaceholder: string;
  /** Success screen defaults — settings.successTitle/successMessage win. */
  successTitle: string;
  successMessage: string;
  closed: string;
  notLive: string;
  /** Title of the not-open state for a draft/storage-blocked form in production. */
  notOpenTitle: string;
  /** Body of the not-open state. */
  notOpenBody: string;
  /** Title of the closed-flavor state (expired/capped workspace);
   *  the body reuses `closed`. */
  closedTitle: string;
  /** Fallback when a submit fails without a server message. */
  submitFailed: string;
  loadFailedNotFound: string;
  loadFailedNetwork: string;
  loadFailed: string;
  renderFailed: string;
  /** Saved-progress notice when a draft restored earlier answers. */
  resumeNotice: string;
  /** Upsert-mode notice when the person's previous response was prefilled. */
  editNotice: string;
  /** The discard action next to the resume notice. */
  resumeStartOver: string;
  /** Shown when the human-verification widget can't load (script blocked). */
  challengeUnavailable: string;
}

export interface RespondentErrorStrings {
  submitFailed: string;
  loadFailedNotFound: string;
  loadFailedNetwork: string;
  formUnavailable: string;
  formClosed: string;
  submitRateLimited: string;
  respondentUnrecognized: string;
  fileUnavailable: string;
  scopeMissing: string;
  challengeIncomplete: string;
  challengeRetry: string;
  reviewAnswers: string;
}

export type RespondentErrorOverrides = Omit<
  RespondentErrorStrings,
  "submitFailed" | "loadFailedNotFound" | "loadFailedNetwork" | "formClosed"
>;

export const DEFAULT_STRINGS: FilloStrings = {
  back: "Back",
  next: "Next",
  submit: "Submit",
  submitting: "Submitting…",
  uploading: "Uploading…",
  optional: " (optional)",
  other: "Other",
  otherPrompt: "Other — please specify",
  otherPlaceholder: "Your answer",
  choosePlaceholder: "Choose…",
  successTitle: "Thanks!",
  successMessage: "Your response has been recorded.",
  closed: "This form is no longer accepting responses.",
  notLive: "This form isn't live yet.",
  notOpenTitle: "This form isn't open yet",
  notOpenBody: "The form owner is still setting things up. Please check back soon.",
  closedTitle: "Responses are closed",
  submitFailed: "This form can't submit right now. Please try again in a moment.",
  loadFailedNotFound: "Form not found. Check the link or ask the form owner for help.",
  loadFailedNetwork: "Couldn't reach the server — check your connection and try again.",
  loadFailed: "This form could not be loaded.",
  renderFailed: "This form could not be rendered.",
  resumeNotice: "Picked up where you left off.",
  editNotice: "You're updating your earlier response.",
  resumeStartOver: "Start over",
  challengeUnavailable: "The verification check couldn't load. Refresh the page and try again.",
};

export const DEFAULT_RESPONDENT_ERROR_STRINGS: RespondentErrorStrings = {
  submitFailed: DEFAULT_STRINGS.submitFailed,
  loadFailedNotFound: DEFAULT_STRINGS.loadFailedNotFound,
  loadFailedNetwork: DEFAULT_STRINGS.loadFailedNetwork,
  formUnavailable: "This form is unavailable.",
  formClosed: DEFAULT_STRINGS.closed,
  submitRateLimited:
    "Too many responses are being submitted right now. Wait a moment, then try again.",
  respondentUnrecognized:
    "This form couldn't verify who is responding. Ask the form owner for help.",
  fileUnavailable:
    "One of the uploaded files is no longer available. Remove it and upload it again.",
  scopeMissing:
    "We couldn't tell which entry this response belongs to. Answer the required field and try again.",
  challengeIncomplete: "Please complete the verification check, then submit.",
  challengeRetry:
    "That verification didn't go through. Please complete the check again and resubmit.",
  reviewAnswers: "We couldn't submit — please review your answers.",
};

/** Translate the renderer's existing top-level fallbacks plus its optional
 * respondent-only overrides into the controller's complete error contract. */
export function respondentErrorStringsFor(
  strings: Pick<
    FilloStrings,
    "submitFailed" | "loadFailedNotFound" | "loadFailedNetwork" | "closed"
  > &
    Pick<FilloFieldStrings, "respondentErrors">,
): RespondentErrorStrings {
  return {
    ...DEFAULT_RESPONDENT_ERROR_STRINGS,
    ...strings.respondentErrors,
    submitFailed: strings.submitFailed,
    loadFailedNotFound: strings.loadFailedNotFound,
    loadFailedNetwork: strings.loadFailedNetwork,
    formClosed: strings.closed,
  };
}

/**
 * Field-level and validation strings the default renderers emit. Kept apart
 * from {@link FilloStrings} so parametrized entries can be functions (a
 * translation places the value where its grammar needs it) without widening
 * the documented all-`string` chrome surface. Also the growth point for new
 * strings in general — unlike `FilloStrings`, nothing depends on this being
 * an exhaustively-enumerated, closed set.
 */
export interface FilloFieldStrings {
  /** Optional, backward-compatible overrides for respondent error states that
   * do not already have a top-level renderer string. */
  respondentErrors?: Partial<RespondentErrorOverrides>;
  /** Generic/legacy validation copy for a required field left empty. Mirrors
   *  REQUIRED_FIELD_MESSAGE and remains the fallback for custom/hidden fields. */
  required: string;
  /** Optional field-aware required copy. Existing `required` overrides keep
   *  their legacy generic behavior unless this function is also supplied. */
  requiredForField?: (field: Field) => string;
  /** Notice when a spent/expired resume link couldn't restore progress. */
  resumeLinkExpired: string;
  /** Success-screen message when a verified identity re-submits and the form
   *  keeps the first answer (a visible duplicate, not a fresh response). */
  alreadyAnswered: string;
  /** Retry control on a failed upload row. */
  uploadRetry: string;
  /** Accessible action names for upload rows. The filename is appended by the renderer. */
  uploadCancel: string;
  uploadRemove: string;
  uploadDismiss: string;
  /** Visible secondary status for an upload in progress. */
  uploadingFile: (percent: number, size: string) => string;
  /** Visible secondary status for a completed upload. */
  uploadedFile: (size: string) => string;
  /** Dropzone copy when uploads can't run because the form isn't connected. */
  uploadsDisabled: string;
  /** Dropzone copy for an explicit render-only preview, which never has transport. */
  uploadsRenderOnly: string;
  /** Dropzone copy when the server temporarily refuses new file sessions. */
  uploadsUnavailable: string;
  /** An upload request reached the server, but storage could not accept it. */
  uploadUnavailable: string;
  /** An upload attempt failed with no actionable server message. */
  uploadFailed: string;
  /** Dropzone call to action; `multiple` is true when several files are allowed. */
  dropzoneTitle: (multiple: boolean) => string;
  /** Dropzone hint stating the per-file size limit in MB. */
  dropzoneHint: (maxMb: number) => string;
  /** A file exceeded the per-file MB limit before upload started. */
  fileTooLarge: (maxMb: number) => string;
  /** Screen-reader status: N uploads in progress. */
  filesUploading: (count: number) => string;
  /** Screen-reader status: N uploads failed. */
  uploadsFailed: (count: number) => string;
  /** Screen-reader status: N uploads completed. */
  filesUploaded: (count: number) => string;
  /** Live-region announcement while a submit is in flight — for auto-submit
   *  forms, which have no footer/button to show `submitting` on. */
  submittingAnnouncement: string;
  /** @deprecated Retained for localization compatibility. Default renderers
   *  now focus the first invalid control and show field-aware inline guidance. */
  errorSummaryTitle: string;
  /** Live-region announcement after a ranking move: "«label», position n of m". */
  rankingPosition: (label: string, position: number, count: number) => string;
  /** Repeating group: the Add button's default label. */
  groupAdd: string;
  /** Repeating group instance heading — "«item» n of m". */
  groupInstanceLabel: (item: string, position: number, count: number) => string;
  /** Repeating group per-instance Remove button accessible label. */
  groupRemoveLabel: (item: string, position: number) => string;
  /** Live-region announcement after adding an instance. */
  groupInstanceAdded: (item: string, position: number, count: number) => string;
  /** Live-region announcement after removing an instance. */
  groupInstanceRemoved: (item: string, count: number) => string;
  /** Live-region announcement once a phone country-picker selection commits
   *  (focus moves straight to the national input, so nothing else announces it). */
  phoneCountrySelected: (name: string) => string;
  /** Live-region announcement of the phone country-picker's filtered result
   *  count as the respondent types in the search box. */
  phoneResultsCount: (count: number) => string;
  /** Accessible name/state for an empty signature canvas. */
  signatureEmpty: string;
  /** Accessible name/state for a signed signature canvas. */
  signatureSigned: string;
}

const REQUIRED_BY_KIND: Partial<Record<Field["kind"], string>> = {
  short_text: "Enter your answer",
  long_text: "Enter your answer",
  email: "Enter an email address",
  url: "Enter a URL",
  phone: "Enter a phone number",
  number: "Enter a number",
  select: "Choose an option",
  dropdown: "Choose an option",
  multi_select: "Select at least one option",
  checkbox: "Select this checkbox",
  rating: "Choose a rating",
  linear_scale: "Choose a value",
  ranking: "Rank every option",
  matrix: "Answer every row",
  signature: "Add your signature",
  date: "Enter a date",
  file_upload: "Add a file",
};

function defaultRequiredForField(field: Field): string {
  return REQUIRED_BY_KIND[field.kind] ?? REQUIRED_FIELD_MESSAGE;
}

export const DEFAULT_FIELD_STRINGS: FilloFieldStrings = {
  required: REQUIRED_FIELD_MESSAGE,
  requiredForField: defaultRequiredForField,
  resumeLinkExpired: "That saved-progress link expired or was already used — start again below.",
  alreadyAnswered: "You've already answered this form.",
  uploadRetry: "Retry",
  uploadCancel: "Cancel",
  uploadRemove: "Remove",
  uploadDismiss: "Dismiss",
  uploadingFile: (percent, size) => `Uploading · ${percent}% · ${size}`,
  uploadedFile: (size) => `Uploaded · ${size}`,
  uploadsDisabled: "Connect this form to Fillo to enable uploads",
  uploadsRenderOnly: "Uploads are unavailable in this render-only preview",
  uploadsUnavailable: "Uploads are temporarily unavailable",
  uploadUnavailable: "We couldn't upload this file right now. Try again in a moment.",
  uploadFailed: "Upload failed — try again",
  dropzoneTitle: (multiple) => `Drop ${multiple ? "files" : "a file"} here or click to browse`,
  dropzoneHint: (maxMb) => `Up to ${maxMb} MB per file`,
  fileTooLarge: (maxMb) => `Larger than ${maxMb} MB limit`,
  filesUploading: (count) => `Uploading ${count} ${count === 1 ? "file" : "files"}, please wait…`,
  uploadsFailed: (count) => `${count} ${count === 1 ? "upload" : "uploads"} failed.`,
  filesUploaded: (count) => `${count} ${count === 1 ? "file" : "files"} uploaded.`,
  submittingAnnouncement: "Submitting your response…",
  errorSummaryTitle: "Check these fields",
  rankingPosition: (label, position, count) => `${label}, position ${position} of ${count}`,
  groupAdd: "Add another",
  groupInstanceLabel: (item, position, count) => `${item} ${position} of ${count}`,
  groupRemoveLabel: (item, position) => `Remove ${item} ${position}`,
  groupInstanceAdded: (item, position, count) =>
    `${item} ${position} added, ${position} of ${count}`,
  groupInstanceRemoved: (item, count) =>
    count === 0 ? `${item} removed, none left` : `${item} removed, ${count} remaining`,
  phoneCountrySelected: (name) => `${name} selected`,
  phoneResultsCount: (count) => `${count} ${count === 1 ? "result" : "results"}`,
  signatureEmpty: "No signature yet",
  signatureSigned: "Signature saved",
};

/** Everything the default renderers can localize — chrome + field/validation. */
export type FilloRendererStrings = FilloStrings & FilloFieldStrings;

/** Resolve the renderer copy for core's stable required-field sentinel. */
export function requiredFieldMessage(
  field: Field,
  strings: Pick<FilloFieldStrings, "required" | "requiredForField">,
): string {
  return strings.requiredForField?.(field) ?? strings.required;
}

/** Merge overrides over the built-in chrome + field defaults. Accepts a partial
 *  of the full renderer surface so the `strings` prop can override either set.
 *  A legacy generic `required` override disables the new field-aware default
 *  unless the caller explicitly supplies `requiredForField` too. */
export function resolveStrings(overrides?: Partial<FilloRendererStrings>): FilloRendererStrings {
  const resolved = overrides
    ? { ...DEFAULT_STRINGS, ...DEFAULT_FIELD_STRINGS, ...overrides }
    : { ...DEFAULT_STRINGS, ...DEFAULT_FIELD_STRINGS };
  if (
    overrides &&
    Object.prototype.hasOwnProperty.call(overrides, "required") &&
    !Object.prototype.hasOwnProperty.call(overrides, "requiredForField")
  ) {
    delete resolved.requiredForField;
  }
  return resolved;
}
