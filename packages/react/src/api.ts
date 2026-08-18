import type {
  Field,
  FieldKind,
  FieldValue,
  FormPage,
  FormSchema,
  FormStatus,
  Block,
  CustomField,
  FilloClient,
  ResponseData,
} from "@usefillo/core";
import type { ComponentType } from "react";

// One status type across the SDK — re-exported from the core engine.
export type { FormStatus };

/**
 * Everything a custom renderer needs. Returned by useFillo() and provided
 * to every field component — the default ones and yours.
 */
export interface FilloApi {
  form: FormSchema;
  formId?: string;
  client?: FilloClient;

  data: ResponseData;
  errors: Record<string, string>;
  setValue: (fieldId: string, value: FieldValue) => void;

  pageIndex: number;
  pageCount: number;
  page: FormPage;
  /** Blocks on the current page after visibility logic. */
  blocks: Block[];
  isFirstPage: boolean;
  isLastPage: boolean;

  next: () => void;
  back: () => void;
  submit: () => Promise<void>;

  status: FormStatus;
  /** True while any file upload is in flight — submit is blocked. */
  uploading: boolean;
  /** Human-readable message for the last failed submit; cleared on edit/retry. */
  submitError?: string;
  /**
   * True when `status` is "submitted" because the once-per-visitor gate
   * restored a previous visit's response, not because a submit happened in
   * this mount. Skip one-time "just submitted" reactions (focus moves,
   * redirects, confetti) when it's set — remounts replay them otherwise.
   */
  restoredSubmission: boolean;
  /**
   * True when a saved-progress draft (settings.saveProgress) restored answers
   * and/or page position from a previous visit. Show a "picked up where you
   * left off" affordance with a Start over action (resetDraft) when set.
   */
  resumedDraft: boolean;
  /**
   * True when an update-in-place limit prefilled the VERIFIED respondent's own
   * previous answers — submitting updates that response in place.
   */
  editingPrevious: boolean;
  /**
   * True when the last submit was kept as an already-recorded response (a
   * verified identify() repeat on a keep-mode form) rather than a fresh one.
   * Renderers show an "already answered" note instead of implying a new save.
   */
  duplicateSubmission: boolean;
  /**
   * True when the last submit updated the person's existing response in place
   * (responseLimit onRepeat "update") rather than creating a new one.
   */
  updatedSubmission: boolean;
  /**
   * True when a resume link (#fillo-draft=…) was expired, spent, or foreign, so
   * no progress could be restored. Renderers explain the blank form instead of
   * showing it with no context.
   */
  resumeLinkFailed: boolean;
  /**
   * Persist unsaved draft progress right now (settings.saveProgress forms).
   * The built-in renderers call it on pagehide/visibility-hidden; custom
   * headless layouts inside <FilloProvider> get the same wiring for free.
   */
  flushDraft: () => void;
  /** Discard the saved draft and reset to a fresh fill ("Start over"). */
  resetDraft: () => void;
  /** Used by upload fields to gate submission. */
  setUploading: (fieldId: string, busy: boolean) => void;
}

export interface FilloFieldIds {
  inputId: string;
  labelId: string;
  descriptionId: string;
  errorId: string;
  name: string;
}

export interface FieldComponentProps<F extends Field = Field> {
  /** Narrow with the type param to skip a cast, e.g.
   *  `FieldComponentProps<CustomField>` to read `field.config` directly. */
  field: F;
  value: FieldValue;
  error: string | undefined;
  setValue: (value: FieldValue) => void;
  api: FilloApi;
  ids?: FilloFieldIds;
}

/**
 * The Field variant carrying a given kind. Some variants share a union `kind`
 * (ChoiceField is "select" | "multi_select" | "dropdown"), so `Extract` would
 * collapse to `never` — distribute over the union and keep the matching member.
 */
type FieldOfKind<K extends FieldKind> = Field extends infer V
  ? V extends Field
    ? K extends V["kind"]
      ? V
      : never
    : never
  : never;

/**
 * Per-kind component overrides — swap any built-in field for your own. Each
 * kind's `field` is narrowed to its variant, so an override reads it cast-free.
 */
export type FieldComponents = {
  [K in FieldKind]?: ComponentType<FieldComponentProps<FieldOfKind<K>>>;
};

/**
 * Renderers for your own field kinds, keyed by a custom field's `component`.
 * A block `{ kind: "custom", component: "color", config: {...} }` renders
 * `customComponents.color`. The component reads `field.config` for options.
 */
export type CustomComponents = Record<string, ComponentType<FieldComponentProps<CustomField>>>;
