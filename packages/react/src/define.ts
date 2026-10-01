import {
  contentHash,
  FilloError,
  isCodeForm,
  isFilloError,
  syncCodeForm,
  type ChallengeConfig,
  type CodeForm,
  type FormBranding,
  type FormSchema,
  type FormTheme,
  type FilloClient,
} from "@usefillo/core";
import { useEffect, useRef, useState } from "react";

export { defineForm, isCodeForm, syncCodeForm, type CodeForm } from "@usefillo/core";

/**
 * Sync a code-defined form into the workspace once and return the canonical
 * form id submissions should target. Shared by <FilloForm> and
 * <FilloProvider>. Effect deps are stable primitives (not the form object),
 * so an inline `defineForm({...})` literal doesn't re-fire it every render.
 */
/** Lifecycle notices are per (handle, kind) — remounts must not spam the console. */
const noticedSync = new Set<string>();
function noticeSync(handle: string, kind: string, message: string) {
  const key = `${handle}:${kind}`;
  if (noticedSync.has(key)) return;
  noticedSync.add(key);
  console.info(message);
}

export function useCodeFormSync(
  form: FormSchema | CodeForm | undefined,
  client: FilloClient | undefined,
  onError?: (error: FilloError) => void,
  options?: { allowUnsynced?: boolean },
): {
  formId: string | null;
  status: "draft" | "published" | null;
  /** Server-owned dashboard URL for reviewing and publishing this form. */
  manageUrl?: string;
  branding?: FormBranding;
  challenge?: ChallengeConfig;
  error: FilloError | null;
  noticeError: FilloError | null;
  syncing: boolean;
  staged: boolean;
  /** Server verdict: a submission would be refused right now (absent on older servers). */
  accepting?: boolean;
  acceptingReason?: "draft" | "expired" | "capped" | "storage_required" | "storage_full";
  /** Whether new file uploads can start; independent from response acceptance. */
  uploadsAvailable?: boolean;
  /** Server-owned per-file ceiling for the active storage lane. */
  uploadFileSizeLimitMb?: number;
  resolvedSchema?: FormSchema;
  resolvedTheme?: FormTheme | null;
  /** Heads-up from sync: the content can't go live as-is (see warningCode). */
  warning?: string;
  warningCode?: string;
  /** Dashboard URL that unblocks publishing (today: connect storage). */
  warningUrl?: string;
} {
  const codeForm = isCodeForm(form) ? form : null;
  const [synced, setSynced] = useState<{
    key: string | null;
    client: FilloClient | undefined;
    settled: boolean;
    formId: string | null;
    status: "draft" | "published" | null;
    manageUrl?: string;
    branding?: FormBranding;
    challenge?: ChallengeConfig;
    error: FilloError | null;
    noticeError: FilloError | null;
    staged: boolean;
    accepting?: boolean;
    acceptingReason?: "draft" | "expired" | "capped" | "storage_required" | "storage_full";
    uploadsAvailable?: boolean;
    uploadFileSizeLimitMb?: number;
    resolvedSchema?: FormSchema;
    resolvedTheme?: FormTheme | null;
    warning?: string;
    warningCode?: string;
    warningUrl?: string;
  }>({
    key: null,
    client: undefined,
    settled: false,
    formId: null,
    status: null,
    error: null,
    noticeError: null,
    staged: false,
  });
  const hasKey = Boolean(client?.key);
  const allowUnsynced = Boolean(options?.allowUnsynced);
  const handle = codeForm?.id;
  const contentKey = codeForm
    ? contentHash(JSON.stringify(codeForm.schema) + JSON.stringify(codeForm.theme ?? null))
    : null;
  const syncKey = codeForm
    ? client?.key
      ? `${client.baseUrl}|${client.key}|${codeForm.id}|${contentKey}`
      : allowUnsynced
        ? null
        : `${client?.baseUrl ?? ""}|<missing-key>|${codeForm.id}|${contentKey}`
    : null;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!codeForm || !syncKey) return;
    let cancelled = false;
    // A changed client/content key must never inherit a previous fatal error.
    setSynced((previous) =>
      previous.key === syncKey && previous.client === client
        ? {
            ...previous,
            settled: false,
            formId: null,
            status: null,
            manageUrl: undefined,
            error: null,
            noticeError: null,
            staged: false,
            accepting: undefined,
            acceptingReason: undefined,
            uploadsAvailable: undefined,
            uploadFileSizeLimitMb: undefined,
            resolvedSchema: undefined,
            resolvedTheme: undefined,
            warning: undefined,
            warningCode: undefined,
            warningUrl: undefined,
          }
        : {
            key: syncKey,
            client,
            settled: false,
            formId: null,
            status: null,
            error: null,
            noticeError: null,
            staged: false,
          },
    );
    if (!client?.key) {
      const error = new FilloError(
        "Code forms need createClient({ key: \"pk_…\" }) to resolve the live form. Pass a publishable key or a published formId.",
        401,
        undefined,
        "sync_key_required",
      );
      console.warn(`[fillo] form sync failed (${error.code}): ${error.message}`);
      setSynced({
        key: syncKey,
        client,
        settled: true,
        formId: null,
        status: null,
        error,
        noticeError: null,
        staged: false,
      });
      onErrorRef.current?.(error);
      return;
    }
    syncCodeForm(client, codeForm)
      .then((r) => {
        if (cancelled) return;
        if ((r.staged || r.syncError) && !r.resolvedSchema) {
          throw new FilloError(
            "Sync did not return the live schema needed to render safely. Publish changes before deploy, and update @usefillo/* or your API.",
            409,
            undefined,
            "sync_snapshot_required",
          );
        }
        const noticeError = r.syncError
          ? new FilloError(r.syncError.message, 403, undefined, r.syncError.code)
          : null;
        setSynced({
          key: syncKey,
          client,
          settled: true,
          formId: r.formId,
          status: r.status ?? null,
          manageUrl: r.manageUrl,
          branding: r.branding,
          challenge: r.challenge,
          error: null,
          noticeError,
          staged: Boolean(r.staged),
          accepting: r.accepting,
          acceptingReason: r.acceptingReason,
          uploadsAvailable: r.uploadsAvailable,
          uploadFileSizeLimitMb: r.uploadFileSizeLimitMb,
          resolvedSchema: r.resolvedSchema,
          resolvedTheme: r.resolvedTheme,
          warning: r.warning,
          warningCode: r.warningCode,
          warningUrl: r.warningUrl,
        });
        const dashboardUrl = r.manageUrl;
        if (r.warning) {
          console.warn(
            `[fillo] ${r.warning}${r.warningUrl ? ` Connect storage to publish: ${r.warningUrl}` : ""}`,
          );
        }
        if (noticeError) {
          console.warn(
            `[fillo] form sync needs attention (${noticeError.code}): ${noticeError.message}`,
          );
          onErrorRef.current?.(noticeError);
        }
        if (r.staged) {
          noticeSync(
            codeForm.id,
            "staged",
            `[fillo] "${codeForm.id}": changes staged as a draft — the live version remains rendered until you publish them${dashboardUrl ? ` at ${dashboardUrl}` : " in Fillo"}`,
          );
        } else if (r.status === "draft") {
          noticeSync(
            codeForm.id,
            "draft",
            `[fillo] "${codeForm.id}" is a draft — it renders here but won't accept responses until published${dashboardUrl ? `: ${dashboardUrl}` : " in Fillo"}`,
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error =
          isFilloError(err) ? err : new FilloError(String(err), 0);
        // Sync failures are otherwise invisible — log AND surface via onError so
        // a wrong key / unlisted origin doesn't fail silently.
        console.warn(
          `[fillo] form sync failed${error.code ? ` (${error.code})` : ""}: ${error.message}`,
        );
        setSynced({
          key: syncKey,
          client,
          settled: true,
          formId: null,
          status: null,
          error,
          noticeError: null,
          staged: false,
        });
        onErrorRef.current?.(error);
      });
    return () => {
      cancelled = true;
    };
    // Depend on stable primitives, not the form object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, handle, contentKey, client, syncKey, allowUnsynced]);

  return synced.key === syncKey && synced.client === client
    ? {
        formId: synced.formId,
        status: synced.status,
        manageUrl: synced.manageUrl,
        branding: synced.branding,
        challenge: synced.challenge,
        error: synced.error,
        noticeError: synced.noticeError,
        syncing: Boolean(syncKey) && !synced.settled,
        staged: synced.staged,
        accepting: synced.accepting,
        acceptingReason: synced.acceptingReason,
        uploadsAvailable: synced.uploadsAvailable,
        uploadFileSizeLimitMb: synced.uploadFileSizeLimitMb,
        resolvedSchema: synced.resolvedSchema,
        resolvedTheme: synced.resolvedTheme,
        warning: synced.warning,
        warningCode: synced.warningCode,
        warningUrl: synced.warningUrl,
      }
    : {
        formId: null,
        status: null,
        error: null,
        noticeError: null,
        syncing: Boolean(syncKey),
        staged: false,
      };
}
