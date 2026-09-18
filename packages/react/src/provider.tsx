import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  FilloError,
  createClient,
  formSchemasEqual,
  isFilloError,
  normalizeFormSchema,
  respondentErrorStringsFor,
  resolveStrings,
  syncCodeForm,
  type FilloAppearance,
  type FilloRendererStrings,
  type FilloClient,
  type FormSchema,
} from "@usefillo/core";
import { FilloAppearanceContext, FilloStringsContext } from "./appearance.js";
import { warnPreviewInProduction } from "./chrome.js";
import { useIsDevEnv } from "./FilloForm.js";
import { FilloChromeContext, FilloContext, FilloInstanceIdContext } from "./context.js";
import { useDraftFlush, useFilloController, type ControllerOptions } from "./controller.js";
import { isCodeForm, useCodeFormSync, type CodeForm } from "./define.js";

interface FilloProviderBaseProps
  extends Omit<ControllerOptions, "form" | "formId" | "client" | "skipValidation"> {
  /** Slot classes for FormField-rendered fields in your composed layout. */
  appearance?: FilloAppearance;
  /** Override any visitor-facing renderer string (for localized sites). */
  strings?: Partial<FilloRendererStrings>;
  /** Observe code-form sync/configuration failures. */
  onError?: (error: FilloError) => void;
  /** Custom unavailable state; receives the full actionable integration error. */
  renderError?: (error: FilloError) => ReactNode;
  /**
   * Apply the developer-chrome behavior on a surface Fillo doesn't detect as
   * local development (a tunnel, staging, a production smoke test): the code
   * form renders and gates like development and failed submits carry the real
   * error + code. COSMETIC ONLY — it never changes where submissions go or
   * whether they are accepted. Headless stays headless: the provider still
   * injects no layout (no badge or notices); the host owns all preview UI.
   */
  preview?: boolean;
  /**
   * Render a deliberately local preview. Submission, uploads, saved progress,
   * and code-form sync are disabled.
   */
  renderOnly?: boolean;
  /** @internal Backward-compatible builder/test preview. */
  skipValidation?: boolean;
  children: ReactNode;
}

type TargetedProviderProps = FilloProviderBaseProps & {
  form: FormSchema | CodeForm;
  formId: string;
  client?: FilloClient;
  renderOnly?: false;
  skipValidation?: false;
};

type CodeBackedProviderProps = FilloProviderBaseProps & {
  form: CodeForm;
  client: FilloClient;
  formId?: undefined;
  renderOnly?: false;
  skipValidation?: false;
};

type RenderOnlyProviderProps = FilloProviderBaseProps & {
  form: FormSchema | CodeForm;
  client?: FilloClient;
  formId?: string;
  renderOnly: true;
  skipValidation?: boolean;
};

type LegacyPreviewProviderProps = FilloProviderBaseProps & {
  form: FormSchema | CodeForm;
  client?: FilloClient;
  formId?: string;
  renderOnly?: boolean;
  skipValidation: true;
};

export type FilloProviderProps =
  | TargetedProviderProps
  | CodeBackedProviderProps
  | RenderOnlyProviderProps
  | LegacyPreviewProviderProps;

/**
 * The headless escape hatch. Sets up the form engine (validation, conditional
 * logic, uploads, submit) and renders no resolved form layout — you compose it
 * with <FormField>, useField() and useFillo(). In production, a code form
 * withholds children (returns null) until its canonical schema is safe; pass
 * renderError to own unavailable/not-published UI without adding SDK layout.
 *
 *   <FilloProvider form={feedback} client={client}>
 *     <YourErrorContext />
 *     <FormField id="reason" />
 *     <p>We read every report.</p>
 *     <FormField id="email" />
 *     <MySubmitButton />            // calls useFillo().submit()
 *   </FilloProvider>
 *
 * The schema stays the source of truth — render every required field, or
 * submission will fail validation on a field the visitor can't see. With a
 * defineForm() form and a keyed client, the structure also syncs into your
 * workspace, exactly like <FilloForm>.
 */
export function FilloProvider({
  children,
  form,
  formId,
  client,
  appearance,
  strings,
  onError,
  renderError,
  preview,
  renderOnly,
  skipValidation,
  ...options
}: FilloProviderProps) {
  const localPreview = renderOnly === true || skipValidation === true;
  const activeClient = useMemo(
    () => (localPreview ? undefined : (client ?? (formId ? createClient() : undefined))),
    [client, formId, localPreview],
  );
  const activeFormId = localPreview ? undefined : formId;
  const instanceId = useId().replace(/:/g, "");
  // Hydration-safe: build-time snapshot on the server/hydration pass, full
  // hostname-aware check after hydration. Gates every dev-vs-production branch
  // in this render.
  const devEnv = useIsDevEnv();
  // Same dev-chrome gate as <FilloForm>: `preview` forces the developer
  // behavior on off-localhost surfaces, cosmetic only.
  const devChrome = preview === true || devEnv;
  if (preview === true) warnPreviewInProduction();
  const codeForm = isCodeForm(form) ? form : null;
  const targetError = useMemo(
    () =>
      !formId && !localPreview && (!codeForm || !client)
        ? new FilloError(
            "This form has no Fillo target. Pass formId with the schema, use a defineForm() value with client, or set renderOnly for a non-submitting preview.",
            422,
            undefined,
            "form_target_required",
          )
        : null,
    [client, codeForm, formId, localPreview],
  );
  useEffect(() => {
    if (targetError) onError?.(targetError);
  }, [onError, targetError]);
  const {
    formId: syncedFormId,
    status: syncedStatus,
    error: syncError,
    syncing: codeFormSyncing,
    resolvedSchema,
    accepting: syncedAccepting,
    acceptingReason: syncedAcceptingReason,
    uploadsAvailable,
    uploadFileSizeLimitMb,
    warningCode,
    warningUrl,
  } = useCodeFormSync(form, activeClient, onError, {
    allowUnsynced: Boolean(!activeClient || activeFormId || localPreview),
  });
  // Submit-time resync truth beats the mount snapshot for both independent
  // signals: upload availability and the owner-facing advisory.
  const [resyncWarning, setResyncWarning] = useState<{
    code?: string;
    url?: string;
    uploadsAvailable?: boolean;
    uploadFileSizeLimitMb?: number;
  } | null>(null);
  const rawSchema = codeForm
    ? resolvedSchema && !devChrome
      ? resolvedSchema
      : codeForm.schema
    : (form as FormSchema);
  // Re-normalize only when the schema reference changes (builders recreate the
  // object per keystroke, so identity is the content signal). Keyed on rawSchema
  // alone, mirroring FilloForm — the previous JSON.stringify "schemaKey" memo
  // was redundant with rawSchema already being in these deps (it re-ran on the
  // same references), so it just normalized the form twice per change.
  const normalized = useMemo(() => normalizeFormSchema(rawSchema), [rawSchema]);
  if (!normalized.ok) {
    throw new FilloError(`This form could not be rendered: ${normalized.error}`, 422);
  }
  const schema = normalized.schema!;
  const resolveFormId = useMemo(
    () =>
      codeForm && activeClient?.key
        ? async () => {
            try {
              const result = await syncCodeForm(activeClient, codeForm, { bypassCache: true });
              setResyncWarning({
                code: result.warningCode,
                url: result.warningUrl,
                uploadsAvailable: result.uploadsAvailable,
                uploadFileSizeLimitMb: result.uploadFileSizeLimitMb,
              });
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
              if (!formSchemasEqual(schema, authoritative.schema!)) {
                throw new FilloError(
                  "The live form changed after this page loaded. Submission stopped before incompatible answers were sent. Reload to use the published schema.",
                  409,
                  undefined,
                  "form_schema_changed",
                );
              }
              if (result.syncError) {
                const notice = new FilloError(
                  result.syncError.message,
                  403,
                  undefined,
                  result.syncError.code,
                );
                console.warn(
                  `[fillo] form sync needs attention (${notice.code}): ${notice.message}`,
                );
                onError?.(notice);
              }
              return result.formId;
            } catch (error: unknown) {
              const failure = isFilloError(error)
                ? error
                : new FilloError(error instanceof Error ? error.message : String(error), 0);
              console.warn(
                `[fillo] form sync failed${failure.code ? ` (${failure.code})` : ""}: ${failure.message}`,
              );
              onError?.(failure);
              throw failure;
            }
          }
        : undefined,
    [activeClient, codeForm, onError, schema],
  );

  const resolvedStrings = resolveStrings(strings);
  const api = useFilloController({
    ...options,
    client: activeClient,
    form: schema,
    formId: syncedFormId ?? activeFormId ?? undefined,
    skipValidation: localPreview,
    resolveFormId,
    // Dev chrome (preview or dev env) surfaces the developer-grade resolution
    // failure (message + code); an explicit option wins.
    verboseResolutionErrors: options.verboseResolutionErrors ?? devChrome,
    respondentErrorStrings: respondentErrorStringsFor(resolvedStrings),
    // Headless = your markup, no Fillo-rendered layout. Free like every embed
    // method; recorded per response so usage stays measurable.
    surface: "headless",
  });
  // Saved-progress forms flush on tab hide/close even in fully custom
  // layouts — the host reads api.resumedDraft/resetDraft to render its own
  // resume affordance.
  useDraftFlush(api, !localPreview);
  // Sync/dev-chrome state for built-in fields composed inside. File controls
  // use only uploadsAvailable; warning metadata remains owner-facing chrome.
  const freshWarningCode = resyncWarning ? resyncWarning.code : warningCode;
  const freshWarningUrl = resyncWarning ? resyncWarning.url : warningUrl;
  const freshUploadsAvailable = resyncWarning ? resyncWarning.uploadsAvailable : uploadsAvailable;
  const freshUploadFileSizeLimitMb = resyncWarning
    ? resyncWarning.uploadFileSizeLimitMb
    : uploadFileSizeLimitMb;
  const chromeValue = useMemo(
    () => ({
      devChrome,
      renderOnly: localPreview,
      uploadsAvailable: freshUploadsAvailable,
      uploadFileSizeLimitMb: freshUploadFileSizeLimitMb,
      warningCode: freshWarningCode,
      warningUrl: freshWarningUrl,
      onError,
    }),
    [
      devChrome,
      localPreview,
      freshUploadsAvailable,
      freshUploadFileSizeLimitMb,
      freshWarningCode,
      freshWarningUrl,
      onError,
    ],
  );
  if (targetError) {
    if (renderError) return <>{renderError(targetError)}</>;
    throw targetError;
  }
  const canonicalSyncError = syncError && !localPreview ? syncError : null;
  if (canonicalSyncError && renderError) return <>{renderError(canonicalSyncError)}</>;
  if (canonicalSyncError && !devChrome) return null;
  if (codeFormSyncing && !localPreview && !devChrome) return null;
  const notPublished = Boolean(codeForm) && syncedStatus === "draft" && !localPreview;
  const notAccepting =
    Boolean(codeForm) && syncedStatus === "published" && syncedAccepting === false && !localPreview;
  if ((notPublished || notAccepting) && !devChrome) {
    const error = notPublished
      ? new FilloError("This form isn't published yet.", 403, undefined, "form_not_published")
      : new FilloError(
          "This form is no longer accepting responses.",
          403,
          undefined,
          syncedAcceptingReason ?? "form_not_accepting",
        );
    return renderError ? <>{renderError(error)}</> : null;
  }
  return (
    <FilloContext.Provider value={api}>
      <FilloChromeContext.Provider value={chromeValue}>
        <FilloStringsContext.Provider value={resolvedStrings}>
          <FilloAppearanceContext.Provider value={appearance}>
            <FilloInstanceIdContext.Provider value={instanceId}>
              {children}
            </FilloInstanceIdContext.Provider>
          </FilloAppearanceContext.Provider>
        </FilloStringsContext.Provider>
      </FilloChromeContext.Provider>
    </FilloContext.Provider>
  );
}
