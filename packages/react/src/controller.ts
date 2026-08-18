import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  createFormController,
  type FilloClient,
  type FilloRespondent,
  type FormController,
  type FormSchema,
  type RespondentErrorStrings,
  type ResponseData,
} from "@usefillo/core";
import type { FilloApi } from "./api.js";

export interface ControllerOptions {
  form: FormSchema;
  formId?: string;
  client?: FilloClient;
  initialData?: ResponseData;
  onChange?: (data: ResponseData) => void;
  onSubmitted?: (responseId: string | undefined, data: ResponseData) => void;
  /** Anti-spam signals provided by the renderer (honeypot value). */
  getHoneypot?: () => string;
  /** @internal Preview-only page navigation escape hatch. Submission still validates. */
  skipValidation?: boolean;
  /**
   * Embedding surface, recorded per response for measurement. Defaults to
   * "headless" (your own markup), matching @usefillo/core — the framed
   * renderers pass "default" explicitly.
   */
  surface?: "default" | "headless";
  /** Resolve/verify the canonical submission target immediately before submit. */
  resolveFormId?: () => Promise<string>;
  /**
   * Surface the real resolveFormId failure (message + machine code) in
   * `submitError` instead of the respondent-safe fallback. The built-in
   * renderers set it from their dev-chrome gate (preview prop / dev
   * environment) so integration details never reach production visitors.
   */
  verboseResolutionErrors?: boolean;
  /** Resolved renderer fallbacks for localized respondent-safe failures. */
  respondentErrorStrings?: Partial<RespondentErrorStrings>;
  /**
   * Host-app account context (identify()): who is filling this form, by your
   * own user id. Recorded with the response as an unverified claim so the
   * dashboard, webhooks, and integrations can say who answered.
   */
  respondent?: FilloRespondent;
  /** True when the form requires a human-verification challenge (Turnstile). */
  challengeRequired?: boolean;
  /** Read the current challenge token from the rendered widget (lazy). */
  getChallengeToken?: () => string | undefined;
  /** The server rejected the challenge — reset the widget for a fresh token. */
  onChallengeFailed?: () => void;
}

/**
 * React binding for the framework-agnostic engine in @usefillo/core
 * (createFormController). The engine owns all state and logic — validation,
 * conditional visibility, paging, spam signals, submission, funnel tracking.
 * This wraps it with useSyncExternalStore and keeps the latest callbacks and
 * submit context wired in, so React, the DOM renderer, and the headless API all
 * share one implementation.
 */
export function useFilloController(options: ControllerOptions): FilloApi {
  // Always-current options so the engine's callbacks invoke the latest versions
  // rather than the ones captured at mount.
  const optsRef = useRef(options);
  optsRef.current = options;
  const errorCopy = options.respondentErrorStrings;
  const respondentErrorStrings = useMemo(
    () => ({ ...errorCopy }),
    [
      errorCopy?.submitFailed,
      errorCopy?.loadFailedNotFound,
      errorCopy?.loadFailedNetwork,
      errorCopy?.formUnavailable,
      errorCopy?.formClosed,
      errorCopy?.submitRateLimited,
      errorCopy?.respondentUnrecognized,
      errorCopy?.fileUnavailable,
      errorCopy?.scopeMissing,
      errorCopy?.challengeIncomplete,
      errorCopy?.challengeRetry,
      errorCopy?.reviewAnswers,
    ],
  );

  // Create the engine exactly once per mount.
  const storeRef = useRef<FormController | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createFormController({
      form: options.form,
      formId: options.formId,
      client: options.client,
      initialData: options.initialData,
      onChange: (d) => optsRef.current.onChange?.(d),
      onSubmitted: (id, d) => optsRef.current.onSubmitted?.(id, d),
      getHoneypot: () => optsRef.current.getHoneypot?.() ?? "",
      skipValidation: options.skipValidation,
      surface: options.surface ?? "headless",
      // Wrapped so the engine (created once) always calls the latest resolver.
      resolveFormId: options.resolveFormId ? () => optsRef.current.resolveFormId!() : undefined,
      // A getter, not a captured boolean: the dev-chrome gate upgrades right
      // after hydration (build-time snapshot → hostname-aware check), but the
      // engine is created once at mount and reads this at submit time.
      get verboseResolutionErrors() {
        return optsRef.current.verboseResolutionErrors;
      },
      respondentErrorStrings,
      respondent: options.respondent,
      // Challenge wiring read through optsRef so the engine (created once) sees
      // the latest token/reset each submit — the widget solves after mount.
      challengeRequired: options.challengeRequired,
      getChallengeToken: () => optsRef.current.getChallengeToken?.(),
      onChallengeFailed: () => optsRef.current.onChallengeFailed?.(),
    });
  }
  const store = storeRef.current;

  // Keep the engine's inputs current: the schema can change in place (builder
  // live preview), the submit target (formId/client) can resolve async, and
  // identify() context often lands after the host session loads.
  useEffect(() => {
    store.setContext({
      form: options.form,
      formId: options.formId,
      client: options.client,
      respondent: options.respondent,
      respondentErrorStrings,
    });
  }, [
    store,
    options.form,
    options.formId,
    options.client,
    options.respondent,
    respondentErrorStrings,
  ]);

  // Drop listeners on unmount.
  useEffect(() => () => store.destroy(), [store]);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  // Memoize the public api so every useFillo()/useField() consumer only
  // re-renders when something it can observe actually changes. The engine
  // returns a fresh `state` object whenever any state changes (uSES already
  // bails out otherwise), and the store methods (setValue/next/back/submit/…)
  // are stable for the store's lifetime — so the api object only needs to be
  // rebuilt when `state` or the form/formId/client inputs change. Fresh
  // data/errors/status arrive through `state`, so nothing goes stale.
  return useMemo<FilloApi>(
    () => ({
      form: options.form,
      formId: options.formId,
      client: options.client,
      ...state,
      setValue: store.setValue,
      setUploading: store.setUploading,
      next: store.next,
      back: store.back,
      submit: store.submit,
      flushDraft: store.flushDraft,
      resetDraft: store.resetDraft,
    }),
    [store, state, options.form, options.formId, options.client],
  );
}

/**
 * Flush unsaved saved-progress answers when the tab hides or unloads
 * (settings.saveProgress forms). The DOM event wiring lives in this React
 * layer so the core engine stays framework- and event-free. Used by both the
 * framed <FilloForm> and the headless <FilloProvider>. Pass `enabled: false`
 * for display-only mounts (the not-open overlay preview) so they never wire
 * page-lifecycle listeners.
 */
export function useDraftFlush(api: FilloApi, enabled = true): void {
  const active = enabled && Boolean(api.form.settings.saveProgress);
  const flush = api.flushDraft;
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const onPageHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, flush]);
}
