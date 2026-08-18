# @usefillo/core

## 0.19.0

### Patch Changes

- 1e6940a: Make code-form draft and staged previews state that responses are not live, link developers directly to the required Fillo publish step, and make server-confirmed publication a required agent completion check.
- 1e6940a: Make unthemed embeds inherit the host page's CSS color scheme and font, while retaining explicit light, dark, and system-driven modes. Fixed hex backgrounds still select a readable light or dark control palette.

## 0.18.0

### Patch Changes

- 87926fb: Add project lifecycle commands to the CLI and local MCP server. Ordinary human-approved logins can list, create, and select isolated projects inside their billed workspace, while handoffs and remote grants remain pinned to their approved project.

  Clarify the core client contract so browser-safe publishable keys are described as project keys.

- bb9c5fc: Keep respondent-facing form failures concise and actionable. Network, unavailable-form, and verification errors no longer expose CORS, Content Security Policy, provider domains, form identifiers, or other developer troubleshooting details; host applications still receive the original diagnostics through the SDK error surfaces.

## 0.17.0

### Minor Changes

- a443d13: The human check (Turnstile) now works on any embedding domain. Renderers load the check inside a small Fillo-hosted challenge frame (`/embed/challenge`) instead of injecting Cloudflare's script into the host page, so the widget always runs on the Fillo deployment's own hostname — the only one Cloudflare needs to allowlist — and host pages no longer need any Cloudflare CSP entries (`frame-src` for your Fillo origin replaces them). Servers advertise the frame via the new `challenge.bridgeUrl` field; against older servers that don't send it, renderers keep the previous direct-render behavior. Both renderers also gain `challengeTheme` (`"auto" | "light" | "dark"`) so apps that manage their own theme can match the widget to it.

## 0.16.1

### Patch Changes

- 96d5a78: Broaden npm keywords so the packages surface in registry search; repository
  metadata ships with this release. The linked release group carries the metadata
  out on the next publish — no code or public API changes.

## 0.14.0

### Patch Changes

- 3f1aaef: Capture browser page attribution metadata with submissions so connected CRM destinations can preserve native form activity and traffic context.

## 0.13.0

### Minor Changes

- 4676887: Repeating groups: a new `repeating_group` field kind renders a small
  template of fields as a card and lets respondents add or remove bounded
  instances of it — guest lists, order line items, any "one row per thing"
  question. `maxInstances` is required (1–20); `minInstances` (default 1)
  governs completeness instead of the generic `required` flag, which the
  container forces off. The stored value is a locked array of objects, one
  per instance, each keyed by child field id — the same canonical shape a
  top-level field of that kind would store, never a flattened string.
  Template fields are drawn from a restricted v1 allowlist (short/long
  text, email, url, phone, number, select, multi_select, dropdown,
  checkbox, date, rating, linear_scale); a child's `visibleIf` may only
  reference a sibling in the same group instance, and nothing outside a
  group can reference a child or vice versa — both directions are schema
  errors, not silent no-ops. The server validates the instance count in
  both directions (a real 422, unlike a calculated field's ignore rule)
  and every child per instance through the same per-kind rules a
  top-level field uses, with child errors keyed
  `${groupId}.${index}.${childId}`; an unknown key inside a submitted
  instance is dropped silently, matching the existing tamper convention.
  Both renderers give each instance an "«item» n of m" card, a labelled
  Add (disabled at the max) and Remove (disabled at the floor) per
  instance, and move focus to the previous card (or Add, for the first)
  on remove — never `<body>` — with polite add/remove announcements. The
  responses grid shows a one-line summary ("3 × Guest: Ada, Grace,
  Alan"); CSV export writes wide, schema-`maxInstances`-capped columns so
  the header never shifts between rows; webhooks, the API, and Zapier
  carry the raw instance array alongside that same summary text, and
  Sheets/Notion carry the summary text only in this release — a child
  record per instance is a deliberate later step. Forms containing a
  repeating group serve a raised minimum SDK version (0.13.0): unlike a
  calculated field, an older SDK doesn't just miss a display row — its
  schema normalizer drops the whole section silently — so it fails fast
  with an update message instead; group-free forms are served
  byte-identically.

## 0.12.1

### Patch Changes

- d4e3b24: Show actionable, field-aware required messages in the default renderers, clear stale file-required validation as soon as a valid upload starts, and revalidate upload-form storage readiness on each visit so a disconnected destination never remains enabled from cache.

## 0.12.0

### Minor Changes

- 36dfa8b: Number fields' `notation` gains two author-fixed styles alongside the
  browser-detected `"grouped"`: `"grouped-comma"` always renders `1,234.56`
  (comma groups, dot decimal) and `"grouped-dot"` always renders `1.234,56`
  (dot groups, comma decimal), regardless of the respondent's locale — for
  forms whose copy already commits to one convention. The new core helper
  `localeForNotation` maps a notation value to the locale both renderers pin
  the separators with. The grouped parser is also hardened symmetrically:
  where the group separator is a comma, a separator run that isn't exact
  3-digit grouping now reads as a decimal mark — `"12,5"` parses to `12.5`
  instead of silently stripping to `125` — mirroring the structural rule
  dot-grouping locales already had. In both families a zero-led head is
  never grouping (grouped output can't produce one), so `"0,123"` — and
  de-DE's `"0.123"`, previously misread as `123` — now parses as the decimal
  `0.123`. Stored values stay canonical dot-decimal
  text/numbers everywhere; older embeds still degrade to a plain, working
  number input without raising the form's minimum SDK version.

### Patch Changes

- 54c7315: Keep upload progress, retry, and remove controls aligned across active, failed,
  and completed file rows. Require every active embed to resolve a real Fillo
  target, add explicit transportless `renderOnly` previews, expose the resolved
  form id for browser verification, and distinguish preview-disabled uploads
  from storage or connection failures.
- b1cb3a4: Input quality: five items carried forward from the audit ledger
  (docs/decisions/input-quality.md) are fixed. `aria-required` no longer lands
  on `role="group"`/`role="button"` hosts (multi_select, ranking, and matrix's
  wrappers; the file_upload dropzone) — only real inputs and `role="radiogroup"`
  support it, and axe flagged the old blanket behavior as critical in both
  renderers. Matrix's empty corner cell renders as `<td>` instead of an empty
  `<th>`. `@usefillo/dom`'s file_upload gains the same activatable dropzone
  `@usefillo/react` already had — a labelled `role="button"` target with
  Enter/Space activation and drag & drop, forwarding to a now visually-and-
  accessibility hidden native input — closing the last renderer-parity gap in
  the file upload control. `@usefillo/dom` also no longer swallows the first
  pointer click after editing a text field: a blur-triggered rebuild now
  defers past the same click gesture instead of replacing the click's target
  node out from under it. The phone country-picker popover positions itself
  correctly in `dir="rtl"` forms instead of nudging (or failing to nudge) in
  the wrong direction.

## 0.11.0

### Minor Changes

- 024f361: Calculated fields: a new `calculated` field kind computes a number from other
  numeric answers with a typed expression (sum, difference, product, quotient,
  min, max, rounding, conditionals) — no formula strings. The value recomputes
  live as respondents type, feeds piping, conditions, and page jumps, and is
  always recomputed on the server at submit, so a tampered client value is
  ignored by construction. Both renderers show it as a read-only display row
  (label + formatted value with decimals/prefix/suffix, em dash while
  unanswered) under the new `calculated` appearance slot. Forms containing a
  calculated field serve a raised minimum SDK version (0.11.0) so older embeds
  fail fast with an update message instead of rendering the form without the
  row and mis-running logic that reads it; calc-free forms are served
  byte-identically.
- 05bf67e: Input quality: every field kind audited against an interaction contract
  (APG/React Aria/GOV.UK) and brought up to it. Phone now covers every ITU
  dialing code (~247 countries, names localized via Intl.DisplayNames) and
  typing `+` to start an international number works instead of corrupting
  the value; the country picker gains the full closed-state keyboard map,
  Tab-away closing, and screen-reader announcements. Failed submits render
  one GOV.UK-style error summary (focused, links to each field) instead of
  N competing per-field alerts. Rating/scale keyboard follows APG (clamped
  arrows, Home/End, RTL-aware; keyboard can no longer silently clear a
  checked value; labels are click-wired). Ranking announces positions and
  never strands focus; the signature canvas exposes signed/empty state;
  matrix rows are proper labelled radiogroups with ≥24px targets and a
  stacked mobile layout. The dom renderer's file upload gains react's full
  per-file UI (individual progress, cancel, retry, remove — concurrent
  uploads replace the one-per-field limit) and honest progress on forms
  with page jumps. Focus rings, pointer targets, forced-colors, RTL, and
  placeholder contrast are standardized in both stylesheets. Email/URL
  inputs set autocomplete. Formatted number inputs filter impossible
  keystrokes (letters, second decimal marks) instead of silently accepting
  them, locale-aware. Dark: `theme={{background, text}}` now infers
  `colorScheme` from the background's luminance, so near-invisible text
  combinations are unreachable. Breaking note for custom dom renderers:
  `FieldRenderContext.uploadProgress` (aggregate per-field fraction) was
  replaced by internal per-file upload state.
- 25fd16c: Number fields gain optional display formatting: `decimals`, `prefix`, and
  `suffix` format the rendered value (responses grid, CSV, notification
  emails, Zapier's `formatted` map) the same way calculated fields already do,
  and `notation: "grouped"` shows browser-locale thousand separators in the
  SDK input while it's unfocused. Everything is display-only — the stored
  value, `answers` payloads, piping, and Google Sheets numeric cells all keep
  the exact number the respondent typed — and a formatted number field does
  not raise the form's minimum SDK version; older embeds simply render a
  plain, unformatted number input instead of the grouped/adorned one. Also
  fixes calculated fields' `prefix`/`suffix` to keep edge spacing, so a suffix
  of `" kg"` renders "3 kg" as documented instead of silently trimming to
  "3kg".

### Patch Changes

- da2b3ed: Keep upload hints truthful by honoring the server-owned per-file limit for temporary storage, render a consistent success mark that does not depend on the host font, and replace the blurred not-open overlay with a calmer inline state.
- 7517be7: Show concise retry copy for temporary-storage service failures and correctly recognize Cloudflare R2 as non-versioned during upload safety checks.

## 0.10.0

### Minor Changes

- 9246bce: Agent-onboarding DX fixes. Core: `SyncFormResult` gains optional `warningCode`
  and `warningUrl` (dashboard deep-link when a form stays draft for missing
  storage) and exports `isLikelyDevEnv()` / `isBuildTimeDevEnv()` — the dev
  check now also treats local hostnames (localhost, `*.localhost`, loopback
  addresses) as development so standalone-script and local production builds
  behave like dev; mDNS `*.local` names stay production, since Bonjour makes
  them a real serving surface. React/DOM: a code-defined draft form now renders
  locally (with the dev notice, including a connect-storage link when the sync
  reports one) instead of showing "This form isn't live yet."; production hosts
  keep the fail-closed placeholder. The React dev check is SSR-safe: the server
  and hydration passes use the build-time signal only, then the first
  post-hydration render upgrades to the hostname-aware check without a
  hydration mismatch. CLI: new read-only `fillo status <formId|handle>` command
  (lifecycle status, live URL, storage warning + deep-link), `fillo list`
  prints each form's URL, `agent event --status` is validated locally, and sync
  output prints the storage settings link.
- f8d4a8d: Expose server-authoritative response and upload availability independently so React and DOM renderers disable unavailable file controls without blocking ordinary answers or completed-file submissions.
- fa773f5: Ship the first-render experience as one coordinated SDK release. Core adds
  developer-grade resolution errors plus optional server-truth
  `accepting`/`acceptingReason` fields. React and DOM gain cosmetic preview chrome,
  structured storage guidance, and a display-only blurred form beneath honest
  not-open/closed cards. The CLI adds guarded `fillo publish` for staged changes
  and `fillo test-response` for credentialed staged-schema validation whose
  short-lived preview rows never enter normal response, delivery, limit, or
  analytics paths.

### Patch Changes

- 6ba0eb8: README cleanup: content stranded after the license line is folded back into
  place (the dom styling notes) or replaced with a pointer to the API reference
  (the core export list), so the npm pages read whole and stop duplicating the
  docs' API surface.
- e3f143f: READMEs now open like a product SDK: a shared fillo.so banner, a centered
  Docs / Guides / Examples / Changelog link row, and npm version + license
  badges ahead of the pitch. No install or API changes.

## 0.9.0

### Minor Changes

- cef2cad: Page jumps and early exit (logic depth P1). A form page can now carry a `next`
  array of `JumpRule`s (`{ when, to }`) that branch the flow: when a rule's
  conditions match (the same `when()`/`visibleIf` model, AND-combined), navigation
  goes to another page's id or `"end"` to finish the form early. Rules evaluate
  top-to-bottom, first match wins; a page with no matching rule continues linearly,
  and a form with no `next` behaves exactly as before (fully backward-compatible —
  no schema-version bump).

  The client renderer, the server validator, and the funnel agree on which pages
  are reachable through one shared engine (`resolveNextPage` / `reachablePageIds` /
  `reachableFieldIds`, exported from `@usefillo/core`): a legitimately jumped-over
  or early-ended submission no longer 422s on a skipped page's required field, and
  those answers are dropped like logic-hidden ones. `@usefillo/react` inherits
  terminal-aware `isLastPage` (the footer reads Submit and one-tap early-end
  auto-submits), and `back()` follows the visited path across a jump.

- e2d4b10: Add an opt-in "require a human check" control (Cloudflare Turnstile). A form can
  now require a human-verification challenge before a submission is accepted: the
  SDK renders a headless Turnstile widget in the host's DOM (no Tailwind, no Next,
  SSR-safe, and zero third-party JavaScript until a form actually needs it), and
  Fillo verifies the token server-side — a missing or forged token is rejected,
  regardless of what the client rendered. Fillo hosts the keys, so customers just
  toggle it on.
  - `@usefillo/core`: `TrustPolicy.challenge?: "off" | "turnstile"` on
    `FormSettings.trust`, a public `ChallengeConfig` (`{ provider, siteKey }`)
    carried on `PublishedForm` and `SyncFormResult`, `SubmitMeta.challengeToken`,
    and controller wiring that attaches the token, holds submit until the check is
    solved, and resets the widget on a server rejection. Built behind a provider
    seam so a second provider is a small future add.
  - `@usefillo/react`: `<FilloForm>` renders the widget (new `turnstile` slot) when
    the form requires one, keeps submit disabled until it's solved, refreshes an
    expired token, and degrades with a clear message if the script can't load.
  - Code-defined forms receive the challenge config through the sync lane: a
    synced schema with `settings.trust.challenge = "turnstile"` gets the public
    site key on the sync response, derived from the live schema (staged changes
    don't gate until published), so the widget renders wherever the server
    enforces the check.
  - Challenge-enabled forms serve a raised `minSdkVersion` (0.9.0, the release
    that ships the widget): older SDKs fail fast with the clear "update
    @usefillo/\*" error instead of rendering a form whose every submit is
    rejected.

  Backward-compatible: a form with no challenge configured behaves exactly as
  before and loads no Turnstile script.

## 0.8.0

### Minor Changes

- 79ef430: Add optional `insightsMetric` semantics for CSAT and NPS score fields so analytics can use the correct formula without guessing from the numeric range.
- c8dd79a: Renderer correctness, submission UX, and SDK hardening from the July 2026 review.
  - Cross-page conditional logic: a field controlled by an answer on another page
    now renders and validates exactly when the server keeps it, so a field is never
    shown-then-silently-dropped on submit (or hidden while still required).
  - A server-side validation error for a field on another page now jumps to that
    page (or shows a submit error) instead of leaving a silent, dead submit button.
  - Repeat submissions on a person-limited form expose `duplicateSubmission` /
    `updatedSubmission` state, and the default renderer shows an "already answered"
    notice instead of a false success screen (only for a verified `identify()`
    repeat — unverified claims are indistinguishable from a first submit).
  - `fetchOwnResponse` sends the active scope value so prefill-for-edit on a scoped
    form returns the entry for this scope, not the newest across all scopes.
  - New `FILLO_MIN_SDK_VERSION` export: the server now advertises a deliberate
    minimum-SDK floor rather than its own build version, so a server release no
    longer forces every embed onto the latest pinned version.
  - Field, validation, and upload strings are now overridable via
    `FilloFieldStrings` / `FilloRendererStrings` for full localization; failed
    uploads offer Retry and no longer count against the file limit; the matrix
    field's row semantics and accessibility are corrected. Shared helpers moved
    into core; the public core surface is an explicit barrel.

### Patch Changes

- 025ce57: Add a project-scoped installer for the provider-neutral Build with Fillo Agent
  Skill, with explicit Codex, Cursor, GitHub Copilot, Gemini CLI, and Claude Code
  targets, an explicit global option, and safe automatic updates for CLI-managed
  copies. Agent handoffs can also attach an existing logged-in workspace with
  `fillo agent connect --account`. New preview workspaces require
  `fillo init --email` and send their private workspace link directly to that
  inbox.
- 35a487f: Clarify the publishable-key example used when syncing code-defined forms.
- c8dd79a: Expose stable API error codes on `FilloError` and make code-defined forms render only a server-confirmed schema in production. React and DOM now show a loading state during bounded sync retries, render the authoritative live snapshot while code changes await trusted sync/review, keep resolved integration warnings in developer error surfaces, show respondents a generic unavailable state after unresolved failures, preserve intentional render-only and local-development use, avoid unsafe cross-page caching of staged fallbacks, and re-verify the live schema before submit so stale pages stop safely without dropping entered answers.
- be2abfa: Harden schema validation, conditional logic, resumed uploads, server-finalized resumable S3 multipart uploads, renderer lifecycle and accessibility, concurrent file handling, and CLI argument/config safety.

## 0.7.0

### Minor Changes

- a803417: Add abandonment recovery for saveProgress forms: `settings.resumeEmails` sends
  a respondent one "pick up where you left off" link when they leave a form idle
  (at most once per draft, never with any answer content), and `settings.resumeUrl`
  sets where that link lands for embedded forms. The SDK adopts a resume link's
  `#fillo-draft=<id>.<token>` fragment on load and strips it from the URL. Forms
  also emit a `draft.abandoned` webhook event (opt-in per webhook) carrying the
  verified respondent id where known — a signal, not content.
- aa44a83: Add `settings.draftAnswersVisible` — when a form owner turns it on (requires
  `saveProgress`), workspace members can read the answers a respondent has typed
  but not yet submitted, in an "In progress" tab in the dashboard. It's a
  separate opt-in from save-and-resume with its own consent framing; the draft
  token stays the only public read capability.
- 9c64665: Add `settings.draftDigest` — a daily owner email summarizing drop-off on a
  saveProgress form (abandoned-yesterday and in-progress counts, where people
  stalled, and verified respondents by name). Requires a notification email;
  never includes answer content or resume links.
- 2c2ba36: identify(): pass your app's account context for the person filling the form —
  `respondent: { id, email?, name?, traits? }` on `<FilloForm>`,
  `<FilloProvider>`, `renderForm`, and `createFormController` (`id` is your own
  user id). Late-bindable after your session loads (`setContext`; the DOM
  renderer adds `setRespondent`). Fillo records it with the response as an
  unverified claim, keeps a living per-workspace profile (latest fields,
  shallow-merged traits), and includes a `respondent` block in webhook and
  Zapier payloads — so responses, exports, and handoffs can say who answered.
  Identity enriches; it never gates.
- 0140045: Person-keyed responses, identity verification, and cross-device resume.
  - `respondent.hash` (identity verification): compute HMAC-SHA256 of the user
    id with your workspace identity secret ON YOUR SERVER and pass it alongside
    `respondent`. Once the workspace holds a secret, Fillo records identity only
    with a valid hash; payloads and the dashboard mark those respondents
    verified. Verified identities also pick up their saved-progress draft on
    any device (the draft token is rotated to the newest device).
  - `settings.submissionLimit: "once_per_person"`: one response per identify()
    external id — repeat submits answer with the standing response
    (`duplicate: true`); anonymous submits are rejected.
  - `settings.responseMode: "upsert"`: one LIVING response per person — repeat
    submits update it in place (`SubmitResult.updated`), webhooks fire
    `response.updated` (X-Fillo-Event + body.event), and verified respondents
    get their previous answers prefilled for editing (`editingPrevious` state,
    `editNotice` string, notice in both framed renderers).
  - New client methods: `fetchOwnResponse`; `CreatedDraft.existing` marks a
    cross-device draft pickup.

- 6f995a6: Save & resume: forms with `settings.saveProgress` autosave in-progress answers
  to Fillo and restore them when the respondent returns.
  - Core: the controller debounce-saves after each change, checkpoints on page
    transitions, restores after hydration (initialData and URL prefill win), and
    hands the draft to submit so the server deletes it with the response commit.
    New `FilloClient` methods `createDraft`/`getDraft`/`saveDraft`/`deleteDraft`
    (per-draft `X-Fillo-Draft-Token` bearer); new `FormController` methods
    `flushDraft()`/`resetDraft()` and state flag `resumedDraft`. Persistence is
    best-effort and silent — it never blocks typing, navigation, or submit.
  - React: `FilloApi` exposes `resumedDraft`/`flushDraft`/`resetDraft`;
    `<FilloForm>` shows a themeable resume notice (new `resume` appearance slot,
    `resumeNotice`/`resumeStartOver` strings) with a Start over action, and both
    `<FilloForm>` and `<FilloProvider>` flush pending saves on
    pagehide/visibility-hidden.
  - DOM: same notice, flush wiring, and new `flushDraft()`/`resetDraft()` on
    `FilloDomForm`.
  - Core bundle budget deliberately raised 26 → 28KB gz for the draft protocol.

  Unsubmitted drafts live server-side for 7 days (sliding) and are deleted on
  submit or "Start over".

- 5b1de34: Unified response limits. `settings.submissionLimit`, `settings.responseMode`,
  `settings.personIdentityField`, and `settings.responseScopeField` are replaced
  by a single `settings.responseLimit` object:

  ```ts
  responseLimit?: {
    by: "browser" | "field" | "identify";  // who counts as the same responder
    field?: string;        // the email/phone field id (by: "field")
    scopeField?: string;   // optional sub-scope, e.g. one response per person PER article
    onRepeat: "keep" | "update";  // "update" (edit in place) applies to by: "identify" only
  };
  ```

  Absent = no limit. `by: "field"` lets the hosted link and anonymous embeds
  dedupe by a self-entered email/phone (a self-claim — unverified); `by: "identify"`
  keys on the identify() respondent; `by: "browser"` is the anonymous per-device
  limit (formerly `once_per_visitor`). `scopeField` folds into the browser
  per-visitor key and the server's per-person dedup so one shared form can enforce
  "one response per responder per article/product".

### Patch Changes

- 63a0355: Once-per-visitor forms no longer scroll-hijack or redirect on remount. When a visitor had already answered a `once_per_visitor` form, every remount (in an SPA, every route change) replayed the "just submitted" reactions: `<FilloForm>` moved focus onto the success screen — scrolling it into view and drawing a focus ring — and a configured `redirectUrl` navigated the host page away. The engine now distinguishes a submit that happened in this mount from the restored gate via a new `restoredSubmission` flag on the controller state (also on `FilloApi`), and `<FilloForm>` only focuses the success screen and runs `redirectUrl` for a live submit. Headless renderers can use the same flag to skip their own one-time success reactions.

## 0.6.2

### Patch Changes

- 43827d2: Docs-review fixes: `FILLO_SDK_VERSION` is now injected from package.json at build (it had silently stayed at 0.5.0, which would eventually brick the min-SDK gate); a client-without-sync-handle now gets its own accurate console diagnosis instead of the misleading "no client" warning; `data-option` joins the documented data-attribute contract and `FILLO_THEME_VARS` exports the theme-token table; content blocks' `visibleIf` is now typed (runtime already accepted it); the last "headless is paid" doc-comment removed from @usefillo/dom.

## 0.6.1

### Patch Changes

- beeaafb: Upload hardening (found by the customer e2e harness) + refreshed READMEs:
  - The hidden file input no longer starts an upload before the form has a submission target (previously a programmatic change event could POST to an undefined form id).
  - Failed uploads surface the server's actionable message ("This form has no file storage connected — …") instead of a generic "try again".

## 0.6.0

### Minor Changes

- f2a7f5a: JSX authoring: write forms as components.

  ```tsx
  "use client";
  import { Fillo, when } from "@usefillo/react";

  <Fillo.Form id="contact" title="Talk to us" client={client}>
    <Fillo.Text id="name" label="Your name" required />
    <Fillo.Email id="email" label="Work email" required />
    <Fillo.Select id="topic" label="Topic">
      <Fillo.Option id="sales" label="Sales" />
      <Fillo.Option id="support" label="Support" />
    </Fillo.Select>
    <Fillo.LongText
      id="message"
      label="How can we help?"
      visibleIf={when("topic").eq("support")}
    />
  </Fillo.Form>;
  ```

  - Field elements are **inert descriptors** compiled — never rendered — into the exact `CodeForm` that `defineForm()` produces: byte-identical JSON, identical content hash, so switching authoring styles never stages a spurious draft. The sync pipeline, server, and dashboard see no JSX.
  - One component per block kind plus `Fillo.Page` (multi-page) and `Fillo.Option`; `Fillo.defineForm(<Fillo.Form …/>)` compiles at module scope for headless/CLI use. `when()` builds `visibleIf` conditions as plain data.
  - Every forbidden pattern fails **loudly in production too** with a fix-it message and stable error code: missing/duplicate ids, host tags or wrapper components as children, opaque (server-component) types, unknown/typo'd props, options-prop-vs-children conflicts. Conditional questions are `visibleIf`, never conditional JSX — a dev warning flags unstable structure.
  - Define forms in a client module (`"use client"`); pass the compiled value across boundaries. `defineForm()` remains first-class and canonical — JSX is sugar that compiles to it.

- 1309582: The Tailwind styling contract, plus the surface-default alignment.
  - **`appearance` prop** on `<FilloForm>` and `<FilloProvider>`: 19 named slots (`root`, `field`, `label`, `control`, `option`, `button`, …) accepting class strings or `(state) => string` functions, appended after the built-in `fillo-*` classes so your utilities win by cascade order. Per-field overrides via `appearance.fields`. `appearance.theme` is the highest-precedence theme source. The Powered-by badge is deliberately not a slot.
  - **`data-*` state contract** emitted on every rendered part: `data-fillo` (slot name), `data-kind`, `data-field`, `data-invalid`, `data-required`, `data-selected` (options, stars, scale steps), `data-checked` (checkbox/toggle), `data-drag-over` (upload), and `data-state`/`data-page` on the root — so `data-[invalid]:border-red-400` and friends just work. BEM modifier classes keep being emitted alongside.
  - **`styles.unlayered.css`**: a second stylesheet artifact with the cascade-layer wrapper stripped, for Tailwind v3 / reset-heavy sites where layered defaults lose to any unlayered CSS.
  - Multi-page progress width is now driven by `--fillo-progress-value` instead of an inline `width`, so `progressFill` can be fully restyled.
  - Auto-submit decisions (`shouldAutoSubmit`/`needsExplicitSubmit`) moved into `@usefillo/core` — one implementation shared by every renderer.
  - `useFilloController` now defaults `surface` to `"headless"`, matching `@usefillo/core`; the framed renderers pass `"default"` explicitly.

### Patch Changes

- f4f4a8b: Two fixes found by the new install-as-a-customer e2e harness:
  - **URL prefill now works in embeds**, not just the hosted page: hidden fields read their `paramName` from the page's query string, and any field can be prefilled by id (`?email=…`) — previously embedded hidden campaign fields silently stored nothing. Applied after hydration; explicit `initialData` and typed answers win.
  - **`createClient({ baseUrl })`**: point the SDK at a different Fillo server (staging, tests, a proxy on your own domain).

- aaf29e0: Data-loss fixes for code-defined forms — a patch with deliberate additive API so the fixes propagate to every `^0.5` install on reinstall.
  - **Submissions can no longer be silently dropped.** A rate-limited or failed mount-time sync used to leave the form without a submission target; submit now resolves the target on the spot (`resolveFormId`, wired automatically in `<FilloForm>` and `renderForm`), syncs retry transient failures with backoff honoring `Retry-After`, and every failed submit shows a visible, answer-preserving error (`state.submitError`) in both renderers instead of an unhandled rejection. Blocked requests (extension / firewall / CSP) get a distinguishable message.
  - **Server error messages reach the respondent.** Non-422 submit failures now surface the server's own `error` body ("Form not found — …", workspace closed) instead of a bare status code.
  - **Draft lifecycle is visible.** `syncForm` returns `status` / `staged` / `warning` (previously dropped); the SDK logs a publish reminder for drafts and staged changes.
  - **Honeypot is inline.** The spam trap and the upload live region are hidden without the optional stylesheet (and re-asserted via CSSOM under strict CSP) — a Tailwind-only embed no longer shows real humans a fillable trap.
  - **`FormField` respects conditional logic** — it no longer renders fields whose answers the engine discards at submit.
  - The SDK sends `X-Fillo-Client` (version) with JSON requests for server-side observability, and `useFilloController` warns once when no explicit `surface` is passed — a future release defaults it to `"headless"` to match `@usefillo/core`.

- 93e3d6e: Sync cache + honest draft lifecycle.
  - **Returning visitors stop re-registering forms**: successful code-form syncs persist in localStorage (published 1h, drafts 60s — publishing flips visitors fast), so steady traffic no longer POSTs `/forms/sync` on every page load. Submit-time resolution always bypasses the cache. Stored values are PII-free: form id, slug, status, content hash, timestamp.
  - **Draft forms are honest in production**: a code-defined form that hasn't been published renders a "This form isn't live yet" panel instead of a fillable form whose submissions silently fail; in development it renders normally with a banner. (`renderError` receives a 403 `FilloError` if you want your own UI.)
  - **No more hydration mismatch on `once_per_visitor` forms**: the localStorage-based "already submitted" gate now applies right after hydration instead of during SSR-visible render.

## 0.5.1

### Patch Changes

- f85e41c: Harden response handling: reject non-finite numbers (Infinity would persist as null), reject impossible calendar dates like 2026-02-30 that only matched the format regex, make formatAnswer fail soft instead of throwing when a reused field id changes kind across versions, and fix Google Drive resumable uploads to recompute the chunk after a mid-chunk retry so a partial-chunk network failure can resume instead of dead-locking on a Content-Range mismatch.
- f0af5bc: Keep the phone country dropdown inside the viewport on short or narrow embeds, and use browser timezone as a privacy-light phone country hint before falling back to browser locale.
- 299facb: Core quality and resilience fixes:
  - Conditional visibility now resolves to a fixpoint so answers to fields that are themselves hidden no longer leak into the visible/validated set (a chained branch could keep or require a field the respondent can't see).
  - `eq`/`neq` conditions coerce number↔numeric-string consistently with `gt`/`lt`, and `neq` no longer matches an unanswered field (premature reveal fixed).
  - `linear_scale` answers are normalized to numbers like `rating`/`number`, so NPS aggregation and `gt`/`lt` conditions work instead of comparing strings.
  - URL prefill for number/rating/scale fields rejects non-finite/non-decimal input (no more `Infinity`/hex seeds).
  - The client bounds every request with a timeout (a hung submit now surfaces a retryable error instead of wedging the form in "submitting" forever), Box uploads retry transient 5xx/429 like Drive/S3, GET requests no longer send `Content-Type` (avoids a CORS preflight on every form load), and `SubmitResult` is a discriminated union that narrows on `ok`.
  - Every submission carries an idempotency key so a retry after a lost response acknowledgement can't create a duplicate, and the Drive resumable upload bails with an error if the storage endpoint stops advancing the offset instead of looping forever.
  - Ship `zod/mini` instead of the classic zod barrel, cutting a large chunk of gzipped weight out of every embed/standalone bundle.
