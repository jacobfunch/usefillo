import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  FilloError,
  createClient,
  formSchemasEqual,
  isBuildTimeDevEnv,
  isField,
  isFilloError,
  isLikelyDevEnv,
  needsExplicitSubmit,
  normalizeFormSchema,
  normalizeFormTheme,
  reachableFields,
  reachablePageSequence,
  respondentErrorStringsFor,
  resolveThemeAppearance,
} from "@usefillo/core";
import { resolveStrings, slotClass } from "@usefillo/core";
import type {
  FilloAppearance,
  FilloRespondent,
  FilloRendererStrings,
  ChallengeConfig,
  ChallengeTheme,
  FormSchema,
  FormTheme,
  FilloClient,
  FormBranding,
  ResponseData,
} from "@usefillo/core";
import { FilloAppearanceContext, FilloStringsContext } from "./appearance.js";
import type { CSSProperties, ReactNode } from "react";
import type { CustomComponents, FieldComponents } from "./api.js";
import { DevChrome, safeHttpUrl, warnPreviewInProduction } from "./chrome.js";
import {
  FilloAnnounceContext,
  FilloChromeContext,
  FilloContext,
  FilloInstanceIdContext,
  createFilloFieldIds,
} from "./context.js";
import { useDraftFlush, useFilloController } from "./controller.js";
import { isCodeForm, syncCodeForm, useCodeFormSync, type CodeForm } from "./define.js";
import { BlockRenderer } from "./fields.js";
import { TurnstileWidget } from "./turnstile.js";

interface FilloFormBaseProps {
  theme?: FormTheme;
  /**
   * The styling contract: theme tokens plus per-slot class strings (Tailwind
   * or your own), appended after the built-in fillo-* classes so they win by
   * cascade order. `appearance.theme` outranks every other theme source.
   */
  appearance?: FilloAppearance;
  /** Override any visitor-facing renderer string (for localized sites). */
  strings?: Partial<FilloRendererStrings>;
  /** Swap any built-in field kind for your own component. */
  components?: FieldComponents;
  /** Renderers for your own `custom` field kinds, keyed by `component`. */
  customComponents?: CustomComponents;
  initialData?: ResponseData;
  /**
   * identify(): your app's account context for the person filling the form
   * ({ id, email?, name?, traits? } — id is your own user id). Recorded with
   * the response as an unverified claim so responses, webhooks, and
   * integrations can say who answered. Safe to pass late (after your session
   * loads).
   */
  respondent?: FilloRespondent;
  /**
   * Human-verification challenge config (public site key + provider). Normally
   * the SDK reads this from the form fetch automatically; pass it explicitly
   * only when you render an inline `form` schema and still want the widget (the
   * hosted page does this). The SECRET key stays server-side — never passed here.
   */
  challenge?: ChallengeConfig;
  /**
   * Theme for the human-verification widget. Defaults to "auto" (the
   * visitor's OS preference); apps with their own theme switch should pass
   * "light"/"dark" so the widget matches the surrounding form.
   */
  challengeTheme?: ChallengeTheme;
  /**
   * Bridge-mode visibility for the human check. "interaction-only" (default)
   * keeps it invisible unless Cloudflare needs the visitor to act; "always"
   * shows the classic widget box the whole time.
   */
  challengeAppearance?: "always" | "interaction-only";
  /**
   * Server-owned per-file ceiling when an inline schema skips the normal form
   * fetch. Fillo's hosted page uses this to preserve its server-rendered fast
   * path; fetched and code-defined forms receive the value automatically.
   */
  uploadFileSizeLimitMb?: number;

  onChange?: (data: ResponseData) => void;
  onSubmitted?: (responseId: string | undefined, data: ResponseData) => void;
  /** Observe load and code-form sync failures (otherwise only logged). */
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

  /**
   * Render the form's own title/description header (default true). Set false
   * when the embedding page already provides a heading, to avoid a second
   * page-level `<h1>`.
   */
  showTitle?: boolean;
  /** Custom success screen. */
  renderSuccess?: () => ReactNode;
  /** Custom error screen — receives the failure (e.g. 404 vs network). */
  renderError?: (error: FilloError) => ReactNode;
  /**
   * Render a deliberately local, non-submitting preview. Transport, uploads,
   * saved progress, and code-form sync are disabled. Use this only for UI
   * previews; real embeds need either `formId` or `defineForm()` + `client`.
   */
  renderOnly?: boolean;
  /**
   * @internal Builder/test preview: let "Next" move between pages without
   * client-side validation. Submission and branding are still authoritative.
   */
  skipValidation?: boolean;
  className?: string;
}

type HostedFormProps = FilloFormBaseProps & {
  /** Fetch a published form by id/slug. A default Fillo client is created if omitted. */
  formId: string;
  form?: undefined;
  client?: FilloClient;
  renderOnly?: false;
  skipValidation?: false;
};

type InlineTargetedFormProps = FilloFormBaseProps & {
  /** Render a schema directly against an explicit published Fillo form. */
  form: FormSchema | CodeForm;
  formId: string;
  client?: FilloClient;
  renderOnly?: false;
  skipValidation?: false;
};

type CodeBackedFormProps = FilloFormBaseProps & {
  /** A defineForm() value can resolve its Fillo target through the keyed client. */
  form: CodeForm;
  client: FilloClient;
  formId?: undefined;
  renderOnly?: false;
  skipValidation?: false;
};

type RenderOnlyFormProps = FilloFormBaseProps & {
  /** Explicit local preview: it can render, but cannot submit or upload. */
  form: FormSchema | CodeForm;
  client?: FilloClient;
  formId?: string;
  renderOnly: true;
  skipValidation?: boolean;
};

type LegacyPreviewFormProps = FilloFormBaseProps & {
  /** @internal Backward-compatible builder/test preview. */
  form: FormSchema | CodeForm;
  client?: FilloClient;
  formId?: string;
  renderOnly?: boolean;
  skipValidation: true;
};

export type FilloFormProps =
  | HostedFormProps
  | InlineTargetedFormProps
  | CodeBackedFormProps
  | RenderOnlyFormProps
  | LegacyPreviewFormProps;

interface ThemeDomProps {
  style?: CSSProperties;
  "data-fillo-color-scheme"?: "light" | "dark" | "auto";
  "data-fillo-has-color-theme"?: "";
}

function themeProps(theme?: FormTheme): ThemeDomProps {
  // Dark is a first-class path (contract, 2026-07-19 second batch): infer
  // colorScheme from a fixed background when the scheme is absent or auto,
  // before anything below reads .colorScheme.
  const safeTheme = resolveThemeAppearance(normalizeFormTheme(theme));
  if (!safeTheme) return {};
  const style: Record<string, string> = {};
  if (safeTheme.primary) style["--fillo-primary"] = safeTheme.primary;
  if (safeTheme.background) style["--fillo-bg"] = safeTheme.background;
  if (safeTheme.text) style["--fillo-text"] = safeTheme.text;
  if (safeTheme.radius) style["--fillo-radius"] = safeTheme.radius;
  if (safeTheme.fontFamily) style["--fillo-font"] = safeTheme.fontFamily;
  const hasColorTheme = Boolean(safeTheme.primary || safeTheme.background || safeTheme.text);
  return {
    ...(Object.keys(style).length ? { style: style as CSSProperties } : {}),
    ...(safeTheme.colorScheme ? { "data-fillo-color-scheme": safeTheme.colorScheme } : {}),
    ...(hasColorTheme ? { "data-fillo-has-color-theme": "" } : {}),
  };
}

function badgeUrl(href: string | undefined): string {
  const url = new URL(safeHttpUrl(href) ?? "https://fillo.so");
  url.searchParams.set("utm_source", "form_badge");
  return url.toString();
}

/** A composite widget (rating, matrix, …) carries its field id on a
 * non-focusable group `<div>` — fall back to its first focusable descendant. */
const FOCUSABLE_SELECTOR =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function resolveFocusable(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.matches(FOCUSABLE_SELECTOR) ? el : el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

/** rAF, falling back to a macrotask where it's absent (non-browser tests). */
function nextFrame(run: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/** Move focus to the first invalid control after a failed submit/next. Errors
 * land synchronously, so defer a frame until React has rendered them and the
 * focused control can announce its linked inline guidance. */
function focusFirstInvalid(formEl: HTMLFormElement | null) {
  if (!formEl || typeof window === "undefined") return;
  nextFrame(() => {
    const invalid = formEl.querySelector<HTMLElement>('[aria-invalid="true"]');
    resolveFocusable(invalid)?.focus();
  });
}

/** Off-screen (not display:none — bots check) so the trap is invisible even
 * without the optional stylesheet. */
const HP_STYLE: CSSProperties = {
  position: "absolute",
  left: "-9999px",
  top: "auto",
  width: "1px",
  height: "1px",
  opacity: 0,
  overflow: "hidden",
  pointerEvents: "none",
};

/** Re-assert via CSSOM: strict CSP (style-src without 'unsafe-inline') strips
 * SSR'd style attributes, and a visible honeypot flags real humans as spam. */
function assertHpHidden(el: HTMLInputElement | null) {
  if (!el) return;
  for (const [prop, value] of Object.entries(HP_STYLE)) {
    (el.style as unknown as Record<string, string>)[prop] = String(value);
  }
}

export function FilloForm(props: FilloFormProps) {
  const { form, formId } = props;
  const renderOnly = props.renderOnly === true || props.skipValidation === true;
  // A hosted form only needs a client pointing at the API to read + submit, so
  // default one (→ fillo.so) when the caller passes just a formId. That makes
  // `<FilloForm formId="…" />` work with nothing else. Pass `client` explicitly
  // to proxy through your own domain or to sync a code-defined form.
  const client = useMemo(
    () => (renderOnly ? undefined : (props.client ?? (formId ? createClient() : undefined))),
    [renderOnly, props.client, formId],
  );
  const [loaded, setLoaded] = useState<{
    formId: string;
    schema: FormSchema;
    theme: FormTheme | null;
    closed: boolean;
    /** Server verdict: submissions refused right now (absent on older servers). */
    accepting?: boolean;
    acceptingReason?: "draft" | "expired" | "capped" | "storage_required" | "storage_full";
    uploadsAvailable?: boolean;
    uploadFileSizeLimitMb?: number;
    branding: FormBranding | null;
    challenge: ChallengeConfig | null;
  } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ formId: string; error: FilloError } | null>(
    null,
  );
  // Hydration-safe: build-time snapshot on the server/hydration pass, full
  // hostname-aware check after hydration. Gates every dev-vs-production branch
  // in this render.
  const devEnv = useIsDevEnv();
  // Dev chrome = every developer-facing surface below (inline schema render,
  // notices, verbose submit errors). `preview` forces it on off-localhost
  // surfaces — cosmetic only, so correctness (where submissions go, whether
  // they are accepted) never depends on it.
  const devChrome = props.preview === true || devEnv;
  if (props.preview === true) warnPreviewInProduction();

  const codeForm = isCodeForm(form) ? form : null;
  const onError = props.onError;
  const {
    formId: syncedFormId,
    status: syncedStatus,
    branding: syncedBranding,
    challenge: syncedChallenge,
    error: syncError,
    noticeError: syncNoticeError,
    syncing: codeFormSyncing,
    staged: codeChangesStaged,
    accepting: syncedAccepting,
    acceptingReason: syncedAcceptingReason,
    uploadsAvailable: syncedUploadsAvailable,
    uploadFileSizeLimitMb: syncedUploadFileSizeLimitMb,
    resolvedSchema,
    resolvedTheme,
    warningCode: syncedWarningCode,
    warningUrl: syncedWarningUrl,
    manageUrl: syncedManageUrl,
  } = useCodeFormSync(form, client, onError, {
    // An absent client is intentional render-only use. Builder previews and an
    // explicit canonical id also do not need publishable-key resolution.
    allowUnsynced: Boolean(!client || props.skipValidation || formId),
  });
  const renderResolvedSnapshot = Boolean(resolvedSchema && !devChrome);
  const inlineSchema = codeForm
    ? renderResolvedSnapshot
      ? resolvedSchema!
      : codeForm.schema
    : (form as FormSchema | undefined);

  // Read the latest onError through a ref so an inline callback prop can't churn
  // the load effect's deps and refetch/remount the form (wiping typed input).
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  const targetError = useMemo(
    () =>
      form && !formId && !renderOnly && (!isCodeForm(form) || !props.client)
        ? new FilloError(
            "This form has no Fillo target. Pass formId with the schema, use a defineForm() value with client, or set renderOnly for a non-submitting preview.",
            422,
            undefined,
            "form_target_required",
          )
        : null,
    [form, formId, props.client, renderOnly],
  );
  useEffect(() => {
    if (targetError) onErrorRef.current?.(targetError);
  }, [targetError]);

  const needsFetch = !inlineSchema && Boolean(client && formId);

  useEffect(() => {
    if (!needsFetch || !client || !formId) {
      setLoaded(null);
      setLoadFailure(null);
      return;
    }
    let cancelled = false;
    setLoaded(null);
    setLoadFailure(null);
    client
      .getForm(formId)
      .then((published) => {
        if (cancelled) return;
        setLoaded({
          formId,
          schema: published.schema,
          theme: published.theme,
          closed: Boolean(published.closed),
          accepting: published.accepting,
          acceptingReason: published.acceptingReason,
          uploadsAvailable: published.uploadsAvailable,
          uploadFileSizeLimitMb: published.uploadFileSizeLimitMb,
          branding: published.branding ?? null,
          challenge: published.challenge ?? null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error =
          err instanceof FilloError ? err : new FilloError("This form could not be loaded.", 0);
        setLoadFailure({ formId, error });
        onErrorRef.current?.(error);
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, client, formId]);

  const strings = resolveStrings(props.strings);
  const currentLoaded = needsFetch && loaded?.formId === formId ? loaded : null;
  const loadError =
    needsFetch && loadFailure && loadFailure.formId === formId ? loadFailure.error : null;
  const rawSchema = inlineSchema ?? currentLoaded?.schema ?? null;
  const normalized = useMemo(
    () => (rawSchema ? normalizeFormSchema(rawSchema) : null),
    [rawSchema],
  );
  const schema = normalized?.ok ? normalized.schema! : null;
  const resolvedCodeTheme = renderResolvedSnapshot ? (resolvedTheme ?? undefined) : codeForm?.theme;
  const theme =
    props.appearance?.theme ??
    props.theme ??
    resolvedCodeTheme ??
    currentLoaded?.theme ??
    undefined;

  if (targetError) {
    if (props.renderError) return <>{props.renderError(targetError)}</>;
    return (
      <div
        className={`fillo-form fillo-form--error ${props.className ?? ""}`}
        role="alert"
        data-fillo="root"
        data-state="error"
        data-error-code="form_target_required"
        {...themeProps(theme)}
      >
        {devChrome ? `${targetError.message} (${targetError.code})` : strings.loadFailed}
      </div>
    );
  }

  if (normalized && !normalized.ok) {
    const error = new FilloError(`This form could not be rendered: ${normalized.error}`, 422);
    if (props.renderError) return <>{props.renderError(error)}</>;
    return (
      <div className={`fillo-form fillo-form--error ${props.className ?? ""}`}>
        {strings.renderFailed}
      </div>
    );
  }

  if (loadError) {
    if (props.renderError) {
      return <>{props.renderError(loadError)}</>;
    }
    // Status-aware default so an integrating dev can tell 404 from a network error.
    const message =
      loadError.status === 404
        ? strings.loadFailedNotFound
        : loadError.status === 0
          ? strings.loadFailedNetwork
          : strings.loadFailed;
    return <div className={`fillo-form fillo-form--error ${props.className ?? ""}`}>{message}</div>;
  }
  // A fetched form the server says can't accept submissions right now renders
  // honestly as a not-open state backed by a never-fillable preview. An absent
  // `accepting` (older server) keeps the closed-panel behavior below exactly.
  if (currentLoaded?.accepting === false && schema) {
    const variant = overlayVariant(currentLoaded.acceptingReason);
    if (props.renderError) {
      const error =
        variant === "closed"
          ? new FilloError(
              "This form is no longer accepting responses.",
              403,
              undefined,
              currentLoaded.acceptingReason,
            )
          : new FilloError(
              "This form isn't accepting responses yet.",
              403,
              undefined,
              currentLoaded.acceptingReason,
            );
      return <>{props.renderError(error)}</>;
    }
    return (
      <NotOpenOverlay
        {...props}
        variant={variant}
        schema={schema}
        theme={theme}
        branding={currentLoaded.branding}
      />
    );
  }
  if (currentLoaded?.closed) {
    return (
      <div
        className={`fillo-form fillo-form--closed ${props.className ?? ""}`}
        {...themeProps(theme)}
      >
        <p className="fillo-closed">{strings.closed}</p>
      </div>
    );
  }
  const canonicalSyncError = codeForm && syncError && !props.skipValidation ? syncError : null;
  // renderError is an integrator surface, so it receives the exact actionable
  // error. The built-in production state deliberately does not expose setup
  // details (keys, origins, or deployment commands) to respondents.
  if (canonicalSyncError && props.renderError) {
    return <>{props.renderError(canonicalSyncError)}</>;
  }
  if (canonicalSyncError && !devChrome) {
    return (
      <div
        className={`fillo-form fillo-form--error ${props.className ?? ""}`}
        role="alert"
        data-fillo="root"
        data-state="error"
        {...themeProps(theme)}
      >
        {strings.loadFailed}
      </div>
    );
  }
  // A draft code form renders from its local schema, but the server refuses
  // anonymous submissions — showing a fillable form here silently ate every
  // answer. In production be honest: show a not-open state backed by a
  // display-only preview. In dev keep the form interactive with a banner.
  const notPublished = Boolean(codeForm) && syncedStatus === "draft" && !props.skipValidation;
  // The accepting verdict for a PUBLISHED code form (expired/capped workspace).
  // Absent on older servers — then only the draft status above gates.
  const syncNotAccepting =
    Boolean(codeForm) &&
    !props.skipValidation &&
    syncedStatus === "published" &&
    syncedAccepting === false;
  if ((notPublished || syncNotAccepting) && !devChrome) {
    const variant = notPublished ? "notOpen" : overlayVariant(syncedAcceptingReason);
    const error =
      variant === "closed"
        ? new FilloError(
            "This form is no longer accepting responses.",
            403,
            undefined,
            syncedAcceptingReason,
          )
        : new FilloError("This form isn't published yet.", 403);
    if (props.renderError) return <>{props.renderError(error)}</>;
    if (schema) {
      return (
        <NotOpenOverlay
          {...props}
          variant={variant}
          schema={schema}
          theme={theme}
          branding={syncedBranding}
        />
      );
    }
    // Defensive only — a code form always carries a schema. Keep the honest
    // panel rather than a blank if that invariant ever breaks.
    return (
      <div
        className={`fillo-form fillo-form--closed ${props.className ?? ""}`}
        {...themeProps(theme)}
      >
        <p className="fillo-closed">{variant === "closed" ? strings.closed : strings.notLive}</p>
      </div>
    );
  }
  // Production is interactive only after bounded sync resolves a canonical
  // schema. Dev and explicit preview/render-only paths remain immediate.
  const awaitingCanonical = Boolean(codeForm && codeFormSyncing && !props.skipValidation);
  if ((!devChrome && awaitingCanonical) || !schema) {
    return (
      <div
        className={`fillo-form fillo-form--loading ${props.className ?? ""}`}
        aria-busy="true"
        {...themeProps(theme)}
      >
        <div className="fillo-skeleton" />
        <div className="fillo-skeleton" />
        <div className="fillo-skeleton fillo-skeleton--short" />
      </div>
    );
  }
  // The "Powered by Fillo" badge is server-driven and NOT client-removable.
  // `skipValidation` is only a preview/navigation escape hatch; it must not
  // change branding.
  const branding = codeForm ? syncedBranding : currentLoaded?.branding;
  const poweredBy = branding?.poweredBy ?? true;
  // Challenge config comes from the fetched form payload (hosted embeds), the
  // sync result (code forms), or an explicit prop (the hosted /f page renders
  // an inline schema and passes it). Absent = no challenge, so the widget never
  // mounts and no third-party JS loads.
  const challenge =
    props.challenge ?? (codeForm ? syncedChallenge : currentLoaded?.challenge) ?? undefined;

  return (
    <ResolvedForm
      {...props}
      client={renderOnly ? undefined : client}
      schema={schema}
      theme={theme}
      formId={renderOnly ? undefined : (syncedFormId ?? formId)}
      renderOnly={renderOnly}
      skipValidation={renderOnly ? true : props.skipValidation}
      poweredBy={poweredBy}
      brandLabel={branding?.label}
      brandHref={branding?.href}
      draftNotice={notPublished}
      stagedNotice={codeChangesStaged}
      syncErrorNotice={syncError ?? syncNoticeError ?? undefined}
      syncFormUrl={syncedManageUrl}
      uploadsAvailable={codeForm ? syncedUploadsAvailable : currentLoaded?.uploadsAvailable}
      uploadFileSizeLimitMb={
        codeForm
          ? syncedUploadFileSizeLimitMb
          : (currentLoaded?.uploadFileSizeLimitMb ?? props.uploadFileSizeLimitMb)
      }
      syncWarningCode={codeForm ? syncedWarningCode : undefined}
      syncWarningUrl={syncedWarningUrl}
      challenge={challenge}
    />
  );
}

function PoweredBy({ label, href }: { label?: string; href?: string }) {
  return (
    <a className="fillo-powered" href={badgeUrl(href)} target="_blank" rel="noopener noreferrer">
      {label ?? "Powered by Fillo"}
    </a>
  );
}

/** Card flavor for a server not-accepting verdict: workspace lifecycle ends
 * (expired/capped) read as closed; draft/storage_required as not-open-yet. */
function overlayVariant(reason?: string): "notOpen" | "closed" {
  return reason === "expired" || reason === "capped" || reason === "storage_full"
    ? "closed"
    : "notOpen";
}

/**
 * Production not-accepting chrome: a calm state backed by the real form rendered
 * display-only — honest about the state and impossible to fill. The default CSS
 * hides the preview; hosts without it still get the layered safety contract.
 * The preview mounts ResolvedForm with NO
 * client, formId, resolver, respondent, challenge, or callbacks, so by
 * construction the engine has no submission target (its submit path never
 * fakes success and can never reach a server), saved-progress drafts stay off
 * (they need a client + formId, so no restore calls or flush listeners),
 * uploads can't start a session (the dropzone requires a client), and no
 * third-party widget mounts. The wrapper adds inert + aria-hidden +
 * pointer-events:none on top of the disabled-fieldset ancestry inside, so
 * nothing in the preview is focusable or clickable.
 */
function NotOpenOverlay(
  props: FilloFormBaseProps & {
    variant: "notOpen" | "closed";
    schema: FormSchema;
    theme?: FormTheme;
    /** Server-owned branding — absent means show the badge (default). */
    branding?: FormBranding | null;
  },
) {
  const strings = resolveStrings(props.strings);
  const closedFlavor = props.variant === "closed";
  return (
    <div
      className={`fillo-form fillo-form--not-open ${props.className ?? ""}`}
      data-fillo="root"
      data-state="closed"
      {...themeProps(props.theme)}
    >
      <div
        className="fillo-not-open-preview"
        aria-hidden="true"
        // Raw attribute so React 18 and 19 peers both render it.
        ref={(node) => node?.setAttribute("inert", "")}
      >
        <ResolvedForm
          schema={props.schema}
          theme={props.theme}
          appearance={props.appearance}
          strings={props.strings}
          components={props.components}
          customComponents={props.customComponents}
          initialData={props.initialData}
          showTitle={props.showTitle}
          displayOnly
        />
      </div>
      <div className="fillo-not-open-card" data-fillo="not-open-card" role="status">
        <h2 className="fillo-not-open-title">
          {closedFlavor ? strings.closedTitle : strings.notOpenTitle}
        </h2>
        <p className="fillo-not-open-body">{closedFlavor ? strings.closed : strings.notOpenBody}</p>
      </div>
      {(props.branding?.poweredBy ?? true) && (
        <PoweredBy label={props.branding?.label} href={props.branding?.href} />
      )}
    </div>
  );
}

/** The environment never changes while the page lives — nothing to subscribe to. */
const noopSubscribe = () => () => {};

/**
 * Hydration-safe dev-environment check for render output. The server (and the
 * hydration pass) sees only the build-time NODE_ENV snapshot — the server
 * can't inspect the page hostname, so both passes always agree and `next
 * start` on localhost hydrates without a mismatch. The first post-hydration
 * render upgrades to the full core check (dev build OR localhost/loopback
 * hostname), so local production builds still get the dev surfaces.
 * Console-only call sites may use isLikelyDevEnv() directly; anything that
 * changes the rendered tree must go through this hook.
 */
export function useIsDevEnv(): boolean {
  return useSyncExternalStore(noopSubscribe, isLikelyDevEnv, isBuildTimeDevEnv);
}

function ResolvedForm(
  props: FilloFormBaseProps & {
    form?: FormSchema | CodeForm;
    formId?: string;
    client?: FilloClient;
    schema: FormSchema;
    theme?: FormTheme;
    poweredBy?: boolean;
    brandLabel?: string;
    brandHref?: string;
    draftNotice?: boolean;
    stagedNotice?: boolean;
    syncErrorNotice?: FilloError;
    /** Dashboard form overview containing the Publish action — dev chrome only. */
    syncFormUrl?: string;
    /** Server-authoritative ability to start a new upload. */
    uploadsAvailable?: boolean;
    /** Server-authoritative per-file ceiling for the active storage lane. */
    uploadFileSizeLimitMb?: number;
    /** Owner-facing sync advisory; never used to gate upload controls. */
    syncWarningCode?: string;
    /** Dashboard URL that unblocks publishing (connect storage) — dev chrome only. */
    syncWarningUrl?: string;
    /** Explicit local preview: transport and uploads are disabled. */
    renderOnly?: boolean;
    /**
     * Not-open overlay preview: render the layout inside a disabled fieldset
     * on a plain div (no form element, no submit wiring, no honeypot) so the
     * display-only preview can never collect or send anything.
     */
    displayOnly?: boolean;
  },
) {
  const { schema, theme } = props;
  const displayOnly = props.displayOnly === true;
  const renderOnly = props.renderOnly === true;
  const instanceId = useId().replace(/:/g, "");
  // Same hydration-safe two-pass check as FilloForm — the dev-chrome gates
  // below are render output. A display-only preview is respondent chrome, so
  // it never grows dev surfaces.
  const devEnv = useIsDevEnv();
  const devChrome = !displayOnly && (props.preview === true || devEnv);
  // Honeypot: invisible to humans, irresistible to naive bots.
  const hpRef = useRef<HTMLInputElement | null>(null);
  const codeForm = isCodeForm(props.form) ? props.form : null;
  const client = props.client;

  // Human-verification challenge (Turnstile). The token flows through a ref so
  // the controller reads the freshest value at submit time (no re-render race);
  // the mirrored state drives the disabled submit button. The server is the real
  // gate — the widget is UX and can never let a submit through on its own.
  const challenge = renderOnly ? undefined : props.challenge;
  const challengeRequired = Boolean(challenge);
  const challengeTokenRef = useRef<string | undefined>(undefined);
  // Submit-time resync truth: the freshest upload-availability and owner-warning
  // snapshot, plus the code of the last resolution failure. The warning can
  // clear mid-session and never substitutes for the explicit availability bit.
  const [resyncWarning, setResyncWarning] = useState<{
    code?: string;
    url?: string;
    uploadsAvailable?: boolean;
    uploadFileSizeLimitMb?: number;
  } | null>(null);
  const [resolutionFailureCode, setResolutionFailureCode] = useState<string | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | undefined>(undefined);
  const [challengeError, setChallengeError] = useState(false);
  const resetChallengeRef = useRef<(() => void) | undefined>(undefined);
  const handleChallengeToken = useCallback((token: string | undefined) => {
    challengeTokenRef.current = token;
    setChallengeToken(token);
    if (token) setChallengeError(false);
  }, []);
  const registerChallengeReset = useCallback((reset: () => void) => {
    resetChallengeRef.current = reset;
  }, []);
  // Submit-time verification bypasses caches so a newly published live schema
  // cannot receive answers from an older page without a compatibility check.
  const resolveFormId = useMemo(
    () =>
      codeForm && client?.key
        ? // bypassCache: a stale cached formId must not be trusted at submit time.
          async () => {
            try {
              const result = await syncCodeForm(client, codeForm, { bypassCache: true });
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
                props.onError?.(notice);
              }
              setResolutionFailureCode(null);
              return result.formId;
            } catch (error: unknown) {
              const failure = isFilloError(error)
                ? error
                : new FilloError(error instanceof Error ? error.message : String(error), 0);
              setResolutionFailureCode(failure.code ?? "sync_failed");
              console.warn(
                `[fillo] form sync failed${failure.code ? ` (${failure.code})` : ""}: ${failure.message}`,
              );
              props.onError?.(failure);
              throw failure;
            }
          }
        : undefined,
    [codeForm, client, props.onError, schema],
  );
  const strings = resolveStrings(props.strings);
  const api = useFilloController({
    form: schema,
    formId: props.formId,
    client: props.client,
    initialData: props.initialData,
    onChange: props.onChange,
    onSubmitted: props.onSubmitted,
    skipValidation: props.skipValidation,
    getHoneypot: () => hpRef.current?.value ?? "",
    // Framed renderer: Fillo draws the layout (and badge), so the surface is
    // "default", never the bare-engine "headless".
    surface: "default",
    resolveFormId,
    // Dev chrome gets the developer-grade resolution failure (message + code)
    // instead of the respondent-safe "unavailable" fallback.
    verboseResolutionErrors: devChrome,
    respondentErrorStrings: respondentErrorStringsFor(strings),
    respondent: props.respondent,
    challengeRequired,
    getChallengeToken: () => challengeTokenRef.current,
    onChallengeFailed: () => {
      // Server rejected the token (stale/replayed): clear it and reset the
      // widget so the human solves a fresh one before resubmitting.
      handleChallengeToken(undefined);
      resetChallengeRef.current?.();
    },
  });
  // Last-keystroke safety net for saved-progress forms (tab close/hide).
  // Off for display-only previews — they hold nothing worth flushing.
  useDraftFlush(api, !displayOnly && !renderOnly);

  // Persistent polite announcement channel (contract §Announcements): an
  // always-mounted sr-only node (in formBody) whose textContent this callback
  // mutates. A live region announces DOM MUTATIONS, not its initial paint —
  // mounting one whose content is already true (the old resume-banner bug,
  // audit chrome #6) silently never fires. One shared channel serializes
  // every announcement below.
  const announceRef = useRef<HTMLSpanElement | null>(null);
  const announce = useCallback((text: string) => {
    const el = announceRef.current;
    if (!el) return;
    if (el.textContent === text) {
      // A repeat is still a distinct announcement — clear first so the next
      // paint's mutation is an observable change, not a no-op.
      el.textContent = "";
      nextFrame(() => {
        if (announceRef.current) announceRef.current.textContent = text;
      });
      return;
    }
    el.textContent = text;
  }, []);

  // Auto-submit forms can render no footer/button at all, so "Submitting…"
  // otherwise never appears anywhere (audit chrome #11 / P2.8).
  useEffect(() => {
    if (api.status === "submitting") announce(strings.submittingAnnouncement);
  }, [api.status, announce, strings.submittingAnnouncement]);

  // The resume/edit banner used to mount with role="status" already true —
  // a live region announces mutations, not initial content, so it silently
  // never fired (audit chrome #6). Push the same text through the channel;
  // the visible banner keeps its text but drops role="status" below.
  const resuming = api.resumedDraft || api.editingPrevious;
  const resumeAnnouncement = api.editingPrevious ? strings.editNotice : strings.resumeNotice;
  useEffect(() => {
    if (resuming) announce(resumeAnnouncement);
  }, [resuming, resumeAnnouncement, announce]);

  const themed = useMemo(() => themeProps(theme), [theme]);
  // Sync/dev-chrome state for field components (outside the engine): the
  // upload dropzone reads it to pre-empt attempts the server is known to
  // refuse while storage is unconnected.
  // The submit-time resync (when it has run) beats the mount snapshot — it can
  // clear a warning that was fixed mid-session, or surface one that appeared.
  const warningCode = resyncWarning ? resyncWarning.code : props.syncWarningCode;
  const warningUrl = resyncWarning ? resyncWarning.url : props.syncWarningUrl;
  const uploadsAvailable = resyncWarning ? resyncWarning.uploadsAvailable : props.uploadsAvailable;
  const uploadFileSizeLimitMb = resyncWarning
    ? resyncWarning.uploadFileSizeLimitMb
    : props.uploadFileSizeLimitMb;
  const chromeValue = useMemo(
    () => ({
      devChrome,
      renderOnly,
      uploadsAvailable,
      uploadFileSizeLimitMb,
      warningCode,
      warningUrl,
      onError: props.onError,
    }),
    [
      devChrome,
      renderOnly,
      uploadsAvailable,
      uploadFileSizeLimitMb,
      warningCode,
      warningUrl,
      props.onError,
    ],
  );
  const settings = schema.settings;

  // Owner-configured redirect takes precedence over the success screen. Run it
  // as an effect (never during render) and only for http(s) — a javascript:
  // URL would otherwise execute on the embedding site's origin. Both this and
  // the focus move below react only to a submit that happened in this mount:
  // a once-per-visitor form restoring "submitted" from a previous visit must
  // not redirect the host page or yank focus/scroll on every remount (in an
  // SPA that's every route change).
  const submitted = api.status === "submitted";
  const liveSubmit = submitted && !api.restoredSubmission;
  useEffect(() => {
    if (!liveSubmit || !settings.redirectUrl || typeof window === "undefined") return;
    const url = safeHttpUrl(settings.redirectUrl);
    if (url) window.location.assign(url);
  }, [liveSubmit, settings.redirectUrl]);

  // Move focus onto the success screen when it replaces the form, so SR/keyboard
  // users land on it rather than nowhere (its live region also announces it).
  const successRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (liveSubmit) successRef.current?.focus();
  }, [liveSubmit]);

  // On a real page change (validated next/back), move focus to the new page so
  // the change is announced. A failed next leaves pageIndex put —
  // focusFirstInvalid still handles that case.
  const blocksRef = useRef<HTMLDivElement>(null);
  const prevPageIndex = useRef(api.pageIndex);
  useEffect(() => {
    if (prevPageIndex.current === api.pageIndex) return;
    prevPageIndex.current = api.pageIndex;
    // Prefer the new page's heading (audit P0.5 — dom already does this):
    // .fillo-blocks has no accessible name, so landing focus there announces
    // nothing useful. The heading (.fillo-page-title on page 2+, .fillo-title
    // on page 1) is a sibling of the blocks div within the same form/fieldset
    // container, so that parent is exactly the right query scope.
    const container = blocksRef.current?.parentElement;
    const heading = container?.querySelector<HTMLElement>(".fillo-page-title, .fillo-title");
    const target = heading ?? blocksRef.current;
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus();
  }, [api.pageIndex]);

  const appearance = props.appearance;
  if (api.status === "submitted") {
    return (
      <div
        ref={successRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={slotClass(
          `fillo-form fillo-form--success ${props.className ?? ""}`,
          appearance,
          { slot: "root", status: "submitted" },
        )}
        data-fillo="root"
        data-fillo-form-id={props.formId}
        data-state="submitted"
        {...themed}
      >
        {props.renderSuccess ? (
          props.renderSuccess()
        ) : (
          <div
            className={slotClass("fillo-success", appearance, {
              slot: "success",
              status: "submitted",
            })}
            data-fillo="success"
          >
            <div className="fillo-success-mark" aria-hidden="true" />
            <h2 className="fillo-success-title">{settings.successTitle ?? strings.successTitle}</h2>
            <p className="fillo-success-message">
              {api.duplicateSubmission
                ? strings.alreadyAnswered
                : (settings.successMessage ?? strings.successMessage)}
            </p>
          </div>
        )}
        {props.poweredBy && <PoweredBy label={props.brandLabel} href={props.brandHref} />}
      </div>
    );
  }

  const multiPage = api.pageCount > 1;
  const autoSubmit = settings.submitMode === "auto";
  // A required challenge appears on the SUBMIT page only (never gating "Next").
  const showChallenge = challengeRequired && api.isLastPage;
  const showPrimaryButton =
    !autoSubmit ||
    !api.isLastPage ||
    needsExplicitSubmit(reachableFields(api.form, api.data)) ||
    // A challenge needs an explicit Submit even on an otherwise button-less
    // auto-submit form — you can't one-tap past a human check.
    showChallenge;
  const showFooter = showPrimaryButton || (multiPage && !api.isFirstPage);

  // Progress over the REACHABLE page sequence (the same walk render/validate/
  // navigation share), not raw pageIndex/pageCount: a jumped-over page no longer
  // inflates the denominator, and an early-end path reports honestly. The bar
  // reaches 100% only on the terminal page — never announcing "done" while more
  // reachable pages remain ahead. If the current page is transiently off the
  // sequence, clamp within the sequence length.
  const progressSeq = reachablePageSequence(api.form, api.data);
  const progressTotal = Math.max(progressSeq.length, 1);
  const progressPos = progressSeq.indexOf(api.page.id);
  const progressStep =
    progressPos >= 0 ? progressPos + 1 : Math.min(api.pageIndex + 1, progressTotal);

  // Dev-chrome deep-link rendered WITH a submit failure — but only when the
  // displayed failure is the one it explains: the submit-time resync refused a
  // draft (form_not_published) whose standing blocker is storage. Gluing the
  // link onto transport/challenge errors sent developers down the wrong path.
  const submitFixUrl =
    devChrome &&
    resolutionFailureCode === "form_not_published" &&
    warningCode === "storage_required"
      ? safeHttpUrl(warningUrl)
      : null;

  const rootClass = slotClass(`fillo-form ${props.className ?? ""}`, appearance, {
    slot: "root",
    status: api.status,
  });
  const formBody = (
    <>
      {/* Persistent announcement channel — always mounted, empty by
              default; `announce` above mutates its textContent. */}
      <span
        ref={announceRef}
        className="fillo-sr-only"
        role="status"
        aria-live="polite"
        data-fillo="announce"
      />

      {devChrome && (
        <DevChrome
          preview={props.preview}
          devNotices={props.devNotices}
          syncError={props.syncErrorNotice}
          staged={props.stagedNotice}
          draft={props.draftNotice}
          warningUrl={props.syncWarningUrl}
          formUrl={props.syncFormUrl}
          noClient={!props.client && !props.skipValidation && !renderOnly}
        />
      )}

      {resuming && (
        <div
          className={slotClass("fillo-resume", appearance, { slot: "resume" })}
          data-fillo="resume"
        >
          <span className="fillo-resume-text">
            {api.editingPrevious ? strings.editNotice : strings.resumeNotice}
          </span>
          <button type="button" className="fillo-resume-clear" onClick={api.resetDraft}>
            {strings.resumeStartOver}
          </button>
        </div>
      )}

      {/* A spent/expired resume link restored nothing — explain the blank
              form rather than dropping the visitor onto it silently. Suppressed
              when a local draft or upsert prefill did populate the fill. */}
      {api.resumeLinkFailed && !api.resumedDraft && !api.editingPrevious && (
        <div
          className={slotClass("fillo-resume fillo-resume--expired", appearance, {
            slot: "resume",
          })}
          data-fillo="resume"
          role="status"
        >
          <span className="fillo-resume-text">{strings.resumeLinkExpired}</span>
        </div>
      )}

      {/* Progress tracks position in the REACHABLE page sequence, so a jump
              or early-end reports honestly and the bar only reads complete on
              the terminal page (never before submit). See progressStep above. */}
      {multiPage && settings.showProgress !== false && (
        <div
          className={slotClass("fillo-progress-track", appearance, { slot: "progress" })}
          data-fillo="progress"
          role="progressbar"
          aria-label={schema.title || "Form progress"}
          aria-valuemin={1}
          aria-valuemax={progressTotal}
          aria-valuenow={progressStep}
        >
          <div
            className={slotClass("fillo-progress-fill", appearance, { slot: "progressFill" })}
            data-fillo="progressFill"
            style={
              {
                "--fillo-progress-value": `${(progressStep / progressTotal) * 100}%`,
              } as CSSProperties
            }
          />
        </div>
      )}

      {api.pageIndex === 0 && props.showTitle !== false && (
        <header
          className={slotClass("fillo-header", appearance, { slot: "header" })}
          data-fillo="header"
        >
          {schema.title && (
            <h1
              className={slotClass("fillo-title", appearance, { slot: "title" })}
              data-fillo="title"
            >
              {schema.title}
            </h1>
          )}
          {schema.description && (
            <p
              className={slotClass("fillo-form-description", appearance, { slot: "description" })}
              data-fillo="description"
            >
              {schema.description}
            </p>
          )}
        </header>
      )}
      {multiPage && api.page.title && api.pageIndex > 0 && (
        <h2
          className={slotClass("fillo-page-title", appearance, { slot: "pageTitle" })}
          data-fillo="pageTitle"
        >
          {api.page.title}
        </h2>
      )}

      <div
        className={slotClass("fillo-blocks", appearance, { slot: "blocks" })}
        data-fillo="blocks"
        ref={blocksRef}
        tabIndex={-1}
      >
        {api.blocks.map((block) => (
          <BlockRenderer
            key={block.id}
            block={block}
            api={api}
            components={props.components}
            customComponents={props.customComponents}
          />
        ))}
      </div>

      {/* Honeypot — a non-semantic name so password managers / browser
              autofill leave it alone (autofill on a real-looking name would
              drop genuine submissions). Hidden inline (works without the
              stylesheet) AND re-asserted via CSSOM after mount (strict CSP
              strips SSR'd style attributes; setProperty is exempt). Off-screen,
              never display:none — bots check for that. A display-only preview
              can't submit, so it carries no trap. */}
      {!displayOnly && (
        <input
          type="text"
          name="fillo_hp_field"
          className="fillo-hp"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          defaultValue=""
          style={HP_STYLE}
          ref={(element) => {
            hpRef.current = element;
            assertHpHidden(element);
          }}
        />
      )}

      {/* Human-verification challenge. Rendered ONLY when the form requires
              one AND on the submit page, so a challenge-off form loads zero
              third-party JS and "Next" is never gated. Headless in the host's
              DOM (no Tailwind); the token flows to submit and the server verifies
              it. Submit stays disabled until it's solved. */}
      {challenge && showChallenge && (
        <div className="fillo-turnstile-slot" data-fillo="turnstile-slot">
          <TurnstileWidget
            siteKey={challenge.siteKey}
            bridgeUrl={challenge.bridgeUrl}
            formId={props.formId}
            theme={props.challengeTheme}
            appearance={props.challengeAppearance}
            className={slotClass("fillo-turnstile", appearance, { slot: "turnstile" })}
            onToken={handleChallengeToken}
            onError={() => setChallengeError(true)}
            registerReset={registerChallengeReset}
          />
          {challengeError && (
            <p className="fillo-turnstile-error" role="alert">
              {strings.challengeUnavailable}
            </p>
          )}
        </div>
      )}

      {(api.status === "error" || api.submitError) && (
        <p className="fillo-submit-error" role="alert">
          {api.submitError ?? strings.submitFailed}
          {submitFixUrl && (
            <>
              {" "}
              Connect storage:{" "}
              <a href={submitFixUrl} target="_blank" rel="noopener noreferrer">
                {submitFixUrl}
              </a>
            </>
          )}
        </p>
      )}

      {showFooter && (
        <footer
          className={slotClass("fillo-footer", appearance, { slot: "footer" })}
          data-fillo="footer"
        >
          {multiPage && !api.isFirstPage && (
            <button
              type="button"
              className={slotClass("fillo-button fillo-button--ghost", appearance, {
                slot: "button",
                variant: "ghost",
              })}
              data-fillo="button"
              onClick={api.back}
            >
              {strings.back}
            </button>
          )}
          {showPrimaryButton && (
            <button
              type="submit"
              className={slotClass("fillo-button fillo-button--primary", appearance, {
                slot: "button",
                variant: "primary",
              })}
              data-fillo="button"
              disabled={
                api.status === "submitting" ||
                api.uploading ||
                // Wait for the human check before enabling submit (never
                // "Next"). The server rejects a tokenless submit regardless —
                // this is UX only.
                (showChallenge && !challengeToken)
              }
            >
              {api.uploading
                ? strings.uploading
                : api.status === "submitting"
                  ? strings.submitting
                  : api.isLastPage
                    ? (settings.submitLabel ?? strings.submit)
                    : strings.next}
            </button>
          )}
        </footer>
      )}
      {props.poweredBy && <PoweredBy label={props.brandLabel} href={props.brandHref} />}
    </>
  );

  return (
    <FilloContext.Provider value={api}>
      <FilloChromeContext.Provider value={chromeValue}>
        <FilloAnnounceContext.Provider value={announce}>
          <FilloStringsContext.Provider value={strings}>
            <FilloAppearanceContext.Provider value={appearance}>
              <FilloInstanceIdContext.Provider value={instanceId}>
                {displayOnly ? (
                  // Display-only preview: a plain div (no form element to submit) with
                  // every control inside a natively disabled fieldset — unfocusable
                  // and unfillable even without the stylesheet or inert support.
                  <div
                    className={rootClass}
                    data-fillo="preview-form"
                    data-state="preview"
                    {...themed}
                  >
                    <fieldset disabled className="fillo-not-open-fields">
                      {formBody}
                    </fieldset>
                  </div>
                ) : (
                  <form
                    className={rootClass}
                    data-fillo="root"
                    data-fillo-form-id={props.formId}
                    data-state={api.status}
                    data-page={api.pageIndex + 1}
                    data-last-page={api.isLastPage ? "" : undefined}
                    {...themed}
                    noValidate
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formEl = e.currentTarget;
                      if (api.isLastPage) {
                        // Rejection is already surfaced as state.submitError (rendered
                        // below with answers intact) — catch so it can't become an
                        // unhandled rejection.
                        void api
                          .submit()
                          .then(() => focusFirstInvalid(formEl))
                          .catch(() => {});
                      } else {
                        api.next();
                        focusFirstInvalid(formEl);
                      }
                    }}
                  >
                    {formBody}
                  </form>
                )}
              </FilloInstanceIdContext.Provider>
            </FilloAppearanceContext.Provider>
          </FilloStringsContext.Provider>
        </FilloAnnounceContext.Provider>
      </FilloChromeContext.Provider>
    </FilloContext.Provider>
  );
}
