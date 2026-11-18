import { isBuildTimeDevEnv, type FilloError } from "@usefillo/core";

/**
 * Only http(s) URLs may become clickable hrefs. Sync payloads and form
 * settings are server-supplied but still never linkified blindly — a
 * javascript: URL must not end up in an <a href> (or a redirect), even in a
 * dev-only notice. Shared by the form chrome, the badge URL, the redirect
 * effect, and the upload dropzone's storage deep-link.
 */
export function safeHttpUrl(href: string | undefined): string | null {
  try {
    if (!href) return null;
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** One-time guard: `preview` left on in a production build is usually a
 * forgotten prop. The contract stays intact either way — preview is cosmetic
 * only and never changes where submissions go or whether they are accepted —
 * but respondents shouldn't be looking at a Preview badge. */
let warnedPreviewInProduction = false;
export function warnPreviewInProduction(): void {
  if (warnedPreviewInProduction || isBuildTimeDevEnv()) return;
  warnedPreviewInProduction = true;
  console.warn(
    "[fillo] `preview` is enabled in a production build. Preview is cosmetic only — it shows " +
      "developer chrome and never changes where submissions go or whether they are accepted — " +
      "but remove it before respondents see this page.",
  );
}

/** Small, unmissable marker that this render has developer preview chrome on.
 * Rendered only for an explicit `preview` prop, so it survives
 * `devNotices={false}` — a forced preview surface must stay visibly one. */
function PreviewBadge() {
  return (
    <span className="fillo-preview-badge" data-fillo="preview-badge">
      Preview
    </span>
  );
}

/** Dev-only banner: a form with no client can't submit. Never rendered in production. */
function DevNoClientNotice() {
  return (
    <div className="fillo-devwarning" role="alert">
      <strong>No Fillo client connected.</strong> This form is render-only and won&rsquo;t save
      responses. Pass a <code>client</code> to collect them in Fillo, or forward them with webhooks.
      (This notice only appears in development and preview.)
    </div>
  );
}

/** Dev-only: the form renders locally, but production submissions would fail.
 * A storage blocker wins over the form overview because it must be resolved
 * first; otherwise the developer gets a direct path to the Publish action. */
function DevDraftNotice({ warningUrl, formUrl }: { warningUrl?: string; formUrl?: string }) {
  const storageUrl = safeHttpUrl(warningUrl);
  const publishUrl = safeHttpUrl(formUrl);
  return (
    <div className="fillo-devwarning" role="alert">
      <strong>Draft form preview.</strong> The form renders for local testing, but Fillo will reject
      the submission and save no response until you publish it.{" "}
      {storageUrl ? (
        <>
          <a href={storageUrl} target="_blank" rel="noopener noreferrer">
            Connect storage to publish
          </a>
          .{" "}
        </>
      ) : publishUrl ? (
        <>
          <a href={publishUrl} target="_blank" rel="noopener noreferrer">
            Open in Fillo to publish
          </a>
          .{" "}
        </>
      ) : null}
      (This notice only appears in development and preview.)
    </div>
  );
}

function DevStagedNotice({ formUrl }: { formUrl?: string }) {
  const publishUrl = safeHttpUrl(formUrl);
  return (
    <div className="fillo-devwarning" role="alert">
      <strong>Code changes are staged, not live.</strong> This page shows your draft, while
      respondents still get the live version.{" "}
      {publishUrl ? (
        <>
          <a href={publishUrl} target="_blank" rel="noopener noreferrer">
            Review and publish in Fillo
          </a>
          .
        </>
      ) : (
        <>Review and publish the changes in Fillo.</>
      )}
    </div>
  );
}

/** Dev-only: preserve local iteration while making failed setup impossible to miss. */
function DevSyncErrorNotice({ error }: { error: FilloError }) {
  return (
    <div className="fillo-devwarning" role="alert">
      <strong>Form sync needs attention{error.code ? ` (${error.code})` : ""}.</strong>{" "}
      {error.message} The safe form remains available for development.
    </div>
  );
}

export interface DevChromeProps {
  /** The `preview` prop was explicitly set — render the badge. */
  preview?: boolean;
  /** Set false to opt out of the notices (the explicit Preview badge stays). */
  devNotices?: boolean;
  syncError?: FilloError;
  staged?: boolean;
  draft?: boolean;
  /** Dashboard URL that unblocks publishing (connect storage), when known. */
  warningUrl?: string;
  /** Dashboard form overview containing the Publish action. */
  formUrl?: string;
  noClient?: boolean;
}

/**
 * The one dev-chrome surface. Renders the Preview badge (explicit `preview`
 * only) plus AT MOST one notice — stacking every applicable warning buried
 * the actionable one, so the most relevant wins:
 * sync-error > staged > draft > no-client. Callers gate it behind their
 * dev-chrome check; production respondents never reach it.
 */
export function DevChrome(props: DevChromeProps) {
  const notice =
    props.devNotices === false ? null : props.syncError ? (
      <DevSyncErrorNotice error={props.syncError} />
    ) : props.staged ? (
      <DevStagedNotice formUrl={props.formUrl} />
    ) : props.draft ? (
      <DevDraftNotice warningUrl={props.warningUrl} formUrl={props.formUrl} />
    ) : props.noClient ? (
      <DevNoClientNotice />
    ) : null;
  if (!props.preview && !notice) return null;
  return (
    <>
      {props.preview && <PreviewBadge />}
      {notice}
    </>
  );
}
