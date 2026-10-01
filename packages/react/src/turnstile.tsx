import type { ChallengeTheme } from "@usefillo/core";
import { useEffect, useRef, useState } from "react";

/**
 * Headless Cloudflare Turnstile widget for the SDK, in one of two modes:
 *
 * BRIDGE (bridgeUrl present — every current Fillo server): render a small
 * Fillo-hosted iframe (`/embed/challenge`) that runs the widget on Fillo's OWN
 * hostname and posts the solved token back. This is what makes the human
 * check work on ANY embedding domain: Cloudflare validates the hostname of
 * the page the widget runs on, and that page is Fillo's. The host page needs
 * no Cloudflare CSP entries in this mode — only the Fillo origin it already
 * talks to. Message contract (keep in sync with apps/web
 * src/app/embed/challenge/route.ts):
 *   in:  fillo:challenge:ready | token {token} | error {code} | expired
 *        | interactive | interactive-done (visibility transitions)
 *   out: fillo:challenge:reset
 *
 * DIRECT (no bridgeUrl — older self-hosted servers): inject Cloudflare's
 * script into the host page and render in place. Only works on hostnames the
 * Turnstile widget allowlists, which is why the bridge replaced it.
 *
 * Either way the token is handed to the controller, which attaches it to the
 * submit. The SERVER verifies the token — this widget is UX; it never gates
 * anything on its own.
 *
 * Loading rules (roadmap 07 P2, locked decision 5):
 *  - Third-party JS (or the bridge iframe) loads ONLY when a challenge is
 *    required. A form with the challenge off never renders this component, so
 *    it loads ZERO extra resources.
 *  - SSR-safe: no `window` access during render; all browser work is in
 *    effects.
 *  - Degrades: if the script/bridge fails to load, we surface an error to the
 *    parent (which shows a message and keeps submit disabled) rather than
 *    crashing or silently allowing a bypass — the server is the real gate.
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

// `render=explicit` so we control when/where the widget mounts (into our slot),
// instead of Cloudflare auto-scanning the whole page for `.cf-turnstile` nodes.
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_ID = "fillo-turnstile-script";

/** How long the bridge gets to say "ready" before we surface the unavailable
 *  state (script blocked inside the frame, frame blocked, server down). */
const BRIDGE_READY_TIMEOUT_MS = 20_000;

/** Cloudflare cData charset (the bridge echoes the form id through siteverify
 *  for the server's binding check). A form id outside it is simply not sent —
 *  the server only compares when present. Same regex as the bridge route. */
const CDATA_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** At-most-once script load shared by every widget instance on the page. */
let scriptPromise: Promise<void> | null = null;

function turnstileGlobal(): TurnstileApi | undefined {
  return (globalThis as unknown as { turnstile?: TurnstileApi }).turnstile;
}

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Turnstile needs a browser"));
  }
  if (turnstileGlobal()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const onReady = () => {
      if (turnstileGlobal()) resolve();
      else reject(new Error("Turnstile loaded without its global"));
    };
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
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
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener(
      "error",
      () => {
        // Load failed. REMOVE the dead <script> AND clear the cached promise so a
        // later mount injects a FRESH element and actually re-fetches. Leaving the
        // node in <head> would make the next mount re-find it via getElementById
        // and attach one-shot load/error listeners that never fire again — the
        // promise would hang forever, permanently bricking the challenge for the
        // page session (fails closed, but unsubmittable).
        script.remove();
        scriptPromise = null;
        reject(new Error("Turnstile script failed to load"));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  /** Fillo-hosted bridge page URL. Present on every current server; absent
   *  only against older self-hosted deploys (then: direct mode). */
  bridgeUrl?: string;
  /** Form id the bridge passes as cData so the server can compare the token's
   *  label against the form actually being submitted. */
  formId?: string;
  /** Widget theme; "auto" (default) follows the visitor's OS preference. */
  theme?: ChallengeTheme;
  /**
   * Bridge-mode visibility. "interaction-only" (default) keeps the check
   * INVISIBLE — most humans pass silently and never see a box; the frame
   * expands only when Cloudflare needs the visitor to act. "always" shows
   * the classic widget box the whole time. Ignored in direct mode.
   */
  appearance?: "always" | "interaction-only";
  /** The solved token, or undefined when it is cleared/expired/failed. */
  onToken: (token: string | undefined) => void;
  /** Surface a load/widget failure so the renderer can show a message. */
  onError?: () => void;
  /** Receive a reset() the renderer calls after a server-side rejection. */
  registerReset?: (reset: () => void) => void;
  /** Class for the container (appended after the built-in fillo-turnstile). */
  className?: string;
}

export function TurnstileWidget(props: TurnstileWidgetProps) {
  // One mode per mount: the config comes from a single server payload, so a
  // form never flips between bridge and direct within a session.
  return props.bridgeUrl ? (
    <BridgeChallenge {...props} bridgeUrl={props.bridgeUrl} />
  ) : (
    <DirectChallenge {...props} />
  );
}

/** Bridge mode: Fillo-hosted iframe + postMessage. */
function BridgeChallenge({
  bridgeUrl,
  formId,
  theme,
  appearance,
  onToken,
  onError,
  registerReset,
  className,
}: TurnstileWidgetProps & { bridgeUrl: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const interactionOnly = (appearance ?? "interaction-only") === "interaction-only";
  // src/origin are computed in an effect (they need window.location.origin),
  // so SSR and the first client render agree on "no iframe yet".
  const [frame, setFrame] = useState<{ src: string; origin: string } | null>(null);
  // interaction-only: the frame stays collapsed (0 height) until Cloudflare
  // says it needs the visitor — the form looks fully native to everyone else.
  const [expanded, setExpanded] = useState(!interactionOnly);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const registerResetRef = useRef(registerReset);
  registerResetRef.current = registerReset;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let url: URL;
    try {
      url = new URL(bridgeUrl);
    } catch {
      onErrorRef.current?.();
      return;
    }
    // The bridge must be a web origin we can bind postMessage checks to.
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      onErrorRef.current?.();
      return;
    }
    url.searchParams.set("origin", window.location.origin);
    url.searchParams.set("theme", theme ?? "auto");
    url.searchParams.set("appearance", interactionOnly ? "interaction-only" : "always");
    if (formId && CDATA_RE.test(formId)) url.searchParams.set("cdata", formId);
    setFrame({ src: url.toString(), origin: url.origin });
  }, [bridgeUrl, formId, theme, interactionOnly]);

  useEffect(() => {
    if (!frame || typeof window === "undefined") return;
    let settled = false;
    // No ready/error/token within the window ⇒ the frame or its Cloudflare
    // script is blocked. Fail closed but VISIBLY (message + disabled submit).
    const watchdog = window.setTimeout(() => {
      if (!settled) {
        onTokenRef.current(undefined);
        onErrorRef.current?.();
      }
    }, BRIDGE_READY_TIMEOUT_MS);
    const settle = () => {
      settled = true;
      window.clearTimeout(watchdog);
    };

    const onMessage = (event: MessageEvent) => {
      // Only the bridge frame we mounted may drive the token: exact origin
      // AND the event source must be our iframe's window.
      if (event.origin !== frame.origin) return;
      const target = iframeRef.current;
      if (!target || event.source !== target.contentWindow) return;
      const data = event.data as { type?: unknown; token?: unknown } | null;
      switch (data?.type) {
        case "fillo:challenge:ready":
          settle();
          break;
        case "fillo:challenge:token":
          settle();
          if (typeof data.token === "string" && data.token.length > 0) {
            onTokenRef.current(data.token);
          }
          // Solved: an interaction-only frame folds away again.
          if (interactionOnly) setExpanded(false);
          break;
        case "fillo:challenge:interactive":
          // Cloudflare needs the visitor — give the widget its box.
          if (interactionOnly) setExpanded(true);
          break;
        case "fillo:challenge:interactive-done":
          if (interactionOnly) setExpanded(false);
          break;
        case "fillo:challenge:expired":
          // The bridge already re-armed its widget; drop the stale token so
          // submit waits for the fresh solve.
          onTokenRef.current(undefined);
          break;
        case "fillo:challenge:error":
          settle();
          onTokenRef.current(undefined);
          onErrorRef.current?.();
          break;
      }
    };
    window.addEventListener("message", onMessage);

    // The parent calls this after a server-side rejection: clear our copy and
    // tell the bridge to re-arm for a fresh solve.
    registerResetRef.current?.(() => {
      onTokenRef.current(undefined);
      iframeRef.current?.contentWindow?.postMessage(
        { type: "fillo:challenge:reset" },
        frame.origin,
      );
    });

    return () => {
      window.clearTimeout(watchdog);
      window.removeEventListener("message", onMessage);
      // Any reported token belonged to the frame instance just unmounted —
      // clear it so a stale solve can't keep Submit armed (multi-page forms
      // unmount the widget on back-nav; a remount must re-solve).
      onTokenRef.current(undefined);
    };
  }, [frame, interactionOnly]);

  return (
    <div
      className={className}
      data-fillo="turnstile"
      data-fillo-challenge-visible={expanded ? "true" : "false"}
    >
      {frame && (
        <iframe
          ref={iframeRef}
          src={frame.src}
          title="Human verification"
          // Cloudflare's normal widget footprint, collapsed to nothing while
          // the check runs invisibly. Attributes (not inline styles) so host
          // CSS can still override; the optional default CSS adds the
          // border-free look via .fillo-turnstile-frame.
          width={300}
          height={expanded ? 65 : 0}
          className="fillo-turnstile-frame"
          referrerPolicy="no-referrer"
          aria-hidden={expanded ? undefined : true}
          tabIndex={expanded ? undefined : -1}
        />
      )}
    </div>
  );
}

/** Direct mode: Cloudflare's script in the host page (pre-bridge servers). */
function DirectChallenge({
  siteKey,
  theme,
  onToken,
  onError,
  registerReset,
  className,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Keep callbacks current without tearing down and re-rendering the widget.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const registerResetRef = useRef(registerReset);
  registerResetRef.current = registerReset;

  useEffect(() => {
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const api = turnstileGlobal();
        if (!api) {
          onErrorRef.current?.();
          return;
        }
        // Drop the token and re-arm the widget so the NEXT submit can carry a
        // fresh solve. Shared by the expired path (token aged out before submit)
        // and the timeout path (interactive challenge timed out unsolved) —
        // without the reset() either one dead-ends with no way to get a token and
        // the form becomes unsubmittable.
        const clearAndReset = () => {
          onTokenRef.current(undefined);
          if (widgetIdRef.current) api.reset(widgetIdRef.current);
        };
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          theme: theme ?? "auto",
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => {
            onTokenRef.current(undefined);
            onErrorRef.current?.();
          },
          "expired-callback": clearAndReset,
          "timeout-callback": clearAndReset,
        });
        // The parent calls this after a server-side rejection; the widget is
        // still mounted, so the same clear+reset applies.
        registerResetRef.current?.(clearAndReset);
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current?.();
      });
    return () => {
      cancelled = true;
      const api = turnstileGlobal();
      if (widgetIdRef.current && api) {
        try {
          api.remove(widgetIdRef.current);
        } catch {
          // Widget already gone (navigated away) — nothing to clean up.
        }
      }
      widgetIdRef.current = null;
      // Any reported token belonged to the widget instance just removed — clear
      // it so a stale solve can't keep Submit armed after the widget is gone
      // (a multi-page form unmounts it on back-nav). A remount must re-solve.
      // (StrictMode's mount→cleanup→remount replay clears then re-renders —
      // consistent, so no special-casing.)
      onTokenRef.current(undefined);
    };
    // Re-render the widget only when its identity inputs change; callbacks ride refs.
  }, [siteKey, theme]);

  return <div ref={containerRef} className={className} data-fillo="turnstile" />;
}
