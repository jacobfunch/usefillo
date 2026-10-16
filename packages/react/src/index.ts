export { FilloForm, type FilloFormProps } from "./FilloForm.js";
export { Fillo, type FilloJsxFormProps } from "./jsx.js";
export { useFilloAppearance } from "./appearance.js";

// Two copies of this package in one bundle break context identity (blank
// forms, "useFillo must be used inside…" from a component that IS inside).
// Detect it loudly in dev — the fix is deduping the dependency, not debugging.
declare const process: { env?: Record<string, string | undefined> } | undefined;
if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
  const key = Symbol.for("usefillo.react.instance");
  const g = globalThis as Record<symbol, unknown>;
  if (g[key]) {
    console.error(
      "[fillo] Two copies of @usefillo/react are loaded — React context does not " +
        "cross package copies, so forms will misbehave. Dedupe the dependency " +
        "(npm dedupe / pnpm why @usefillo/react).",
    );
  }
  g[key] = true;
}
export { FilloProvider, type FilloProviderProps } from "./provider.js";
export { defineForm, type CodeForm } from "./define.js";
export { useFillo, useField, type FieldHandle } from "./context.js";
export { useFilloController, type ControllerOptions } from "./controller.js";
export { BlockRenderer, FormField } from "./fields.js";
// Exported under a Fillo-prefixed name so it doesn't clash with the core
// `FileUploadField` *type* when both packages are imported together.
export { FileUploadField as FilloFileUpload } from "./upload.js";
export type {
  FilloApi,
  FilloFieldIds,
  FieldComponentProps,
  FieldComponents,
  CustomComponents,
  FormStatus,
} from "./api.js";

// Re-export the core surface people need for embedding, so one import works.
export {
  createClient,
  provisionWorkspace,
  when,
  FilloJsxError,
  FilloClient,
  FilloError,
  type FormSchema,
  type FormTheme,
  type Field,
  type FieldValue,
  type FileValue,
  type ResponseData,
  type PublishedForm,
  type ProvisionWorkspaceResult,
  type FilloAppearance,
  type FilloSlot,
  type FilloStrings,
  type FilloRendererStrings,
  type SlotState,
} from "@usefillo/core";
