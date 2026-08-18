# @usefillo/dom

## 0.19.0

### Patch Changes

- 1e6940a: Make code-form draft and staged previews state that responses are not live, link developers directly to the required Fillo publish step, and make server-confirmed publication a required agent completion check.
- 1e6940a: Make unthemed embeds inherit the host page's CSS color scheme and font, while retaining explicit light, dark, and system-driven modes. Fixed hex backgrounds still select a readable light or dark control palette.
- Updated dependencies [1e6940a]
- Updated dependencies [1e6940a]
  - @usefillo/core@0.19.0

## 0.18.0

### Patch Changes

- 9294f43: Answer text is now the same size everywhere: choice option labels, ranking labels, and the "Other" free-text input match typed answers (1em) instead of running slightly smaller. All form text also switches from rem (page-root scale) to em (form scale), so labels and answers keep their proportions on host pages whose root and body font sizes differ; on a default 16px page nothing moves except the answer-text alignment. New `--fillo-font-size` token on the form root (default: inherit) — set it once to pin or scale the entire form's type.
- bb9c5fc: Keep respondent-facing form failures concise and actionable. Network, unavailable-form, and verification errors no longer expose CORS, Content Security Policy, provider domains, form identifiers, or other developer troubleshooting details; host applications still receive the original diagnostics through the SDK error surfaces.
- Updated dependencies [87926fb]
- Updated dependencies [bb9c5fc]
  - @usefillo/core@0.18.0

## 0.17.0

### Minor Changes

- 9abf137: The human check is now invisible by default. In bridge mode the challenge frame stays collapsed while Cloudflare's silent verification runs — most respondents never see a box and the form looks fully native. The widget appears only when Cloudflare needs the visitor to act (reported by the bridge via `fillo:challenge:interactive`/`interactive-done`), then folds away after the solve. New `challengeAppearance` option on both renderers: `"interaction-only"` (default) or `"always"` for the classic visible box.
- a443d13: The human check (Turnstile) now works on any embedding domain. Renderers load the check inside a small Fillo-hosted challenge frame (`/embed/challenge`) instead of injecting Cloudflare's script into the host page, so the widget always runs on the Fillo deployment's own hostname — the only one Cloudflare needs to allowlist — and host pages no longer need any Cloudflare CSP entries (`frame-src` for your Fillo origin replaces them). Servers advertise the frame via the new `challenge.bridgeUrl` field; against older servers that don't send it, renderers keep the previous direct-render behavior. Both renderers also gain `challengeTheme` (`"auto" | "light" | "dark"`) so apps that manage their own theme can match the widget to it.

### Patch Changes

- Updated dependencies [a443d13]
  - @usefillo/core@0.17.0

## 0.16.1

### Patch Changes

- 96d5a78: Broaden npm keywords so the packages surface in registry search; repository
  metadata ships with this release. The linked release group carries the metadata
  out on the next publish — no code or public API changes.
- Updated dependencies [96d5a78]
  - @usefillo/core@0.16.1

## 0.14.0

### Patch Changes

- 16b5c8d: Hosted-form completion polish: the success screen's check is now an affirming filled mark (a solid primary disc with a contrast-colored check that flips per theme and honors the host's `--fillo-primary`) instead of a faint gray ring, with steadier spacing. The DOM renderer ships the identical mark, keeping the two SDK stylesheets in sync.
- Updated dependencies [3f1aaef]
  - @usefillo/core@0.14.0

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

### Patch Changes

- Updated dependencies [4676887]
  - @usefillo/core@0.13.0

## 0.12.1

### Patch Changes

- d4e3b24: Show actionable, field-aware required messages in the default renderers, clear stale file-required validation as soon as a valid upload starts, and revalidate upload-form storage readiness on each visit so a disconnected destination never remains enabled from cache.
- Updated dependencies [d4e3b24]
  - @usefillo/core@0.12.1

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

### Patch Changes

- 54c7315: Keep upload progress, retry, and remove controls aligned across active, failed,
  and completed file rows. Require every active embed to resolve a real Fillo
  target, add explicit transportless `renderOnly` previews, expose the resolved
  form id for browser verification, and distinguish preview-disabled uploads
  from storage or connection failures.
- Updated dependencies [54c7315]
- Updated dependencies [36dfa8b]
- Updated dependencies [b1cb3a4]
  - @usefillo/core@0.12.0

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
- ed8e70d: Cloudflare Turnstile support: challenge-gated forms now submit through the
  DOM renderer. The widget lifecycle is ported from @usefillo/react — script
  loader with load-failure recovery, token capture with expiry/timeout reset,
  full teardown on destroy — with a persistent container so the Cloudflare
  iframe survives re-renders. `renderForm` accepts an explicit `challenge`
  config for inline schemas; hosted and code-defined forms pick it up from the
  server automatically, matching react.

### Patch Changes

- da2b3ed: Keep upload hints truthful by honoring the server-owned per-file limit for temporary storage, render a consistent success mark that does not depend on the host font, and replace the blurred not-open overlay with a calmer inline state.
- 7517be7: Show concise retry copy for temporary-storage service failures and correctly recognize Cloudflare R2 as non-versioned during upload safety checks.
- Updated dependencies [024f361]
- Updated dependencies [da2b3ed]
- Updated dependencies [05bf67e]
- Updated dependencies [25fd16c]
- Updated dependencies [7517be7]
  - @usefillo/core@0.11.0

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
- 2ae6254: READMEs slimmed to the quickstart shape: install, a first form, one
  differentiator per package, and links into the docs. Operational depth
  (CI sync tokens, stdin pushes, the raw sync endpoint, the agent progress
  protocol, styling minutiae) now lives only in the docs it links.
- Updated dependencies [9246bce]
- Updated dependencies [f8d4a8d]
- Updated dependencies [fa773f5]
- Updated dependencies [6ba0eb8]
- Updated dependencies [e3f143f]
  - @usefillo/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [cef2cad]
- Updated dependencies [e2d4b10]
  - @usefillo/core@0.9.0

## 0.8.0

### Minor Changes

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

- c8dd79a: Expose stable API error codes on `FilloError` and make code-defined forms render only a server-confirmed schema in production. React and DOM now show a loading state during bounded sync retries, render the authoritative live snapshot while code changes await trusted sync/review, keep resolved integration warnings in developer error surfaces, show respondents a generic unavailable state after unresolved failures, preserve intentional render-only and local-development use, avoid unsafe cross-page caching of staged fallbacks, and re-verify the live schema before submit so stale pages stop safely without dropping entered answers.
- be2abfa: Harden schema validation, conditional logic, resumed uploads, server-finalized resumable S3 multipart uploads, renderer lifecycle and accessibility, concurrent file handling, and CLI argument/config safety.
- 35a487f: Use the renderer's selector-string overload in copy-paste TypeScript examples.
- Updated dependencies [79ef430]
- Updated dependencies [025ce57]
- Updated dependencies [35a487f]
- Updated dependencies [c8dd79a]
- Updated dependencies [c8dd79a]
- Updated dependencies [be2abfa]
  - @usefillo/core@0.8.0

## 0.7.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [a803417]
- Updated dependencies [aa44a83]
- Updated dependencies [9c64665]
- Updated dependencies [2c2ba36]
- Updated dependencies [0140045]
- Updated dependencies [63a0355]
- Updated dependencies [6f995a6]
- Updated dependencies [5b1de34]
  - @usefillo/core@0.7.0

## 0.6.2

### Patch Changes

- 43827d2: Docs-review fixes: `FILLO_SDK_VERSION` is now injected from package.json at build (it had silently stayed at 0.5.0, which would eventually brick the min-SDK gate); a client-without-sync-handle now gets its own accurate console diagnosis instead of the misleading "no client" warning; `data-option` joins the documented data-attribute contract and `FILLO_THEME_VARS` exports the theme-token table; content blocks' `visibleIf` is now typed (runtime already accepted it); the last "headless is paid" doc-comment removed from @usefillo/dom.
- Updated dependencies [43827d2]
  - @usefillo/core@0.6.2

## 0.6.1

### Patch Changes

- beeaafb: Upload hardening (found by the customer e2e harness) + refreshed READMEs:
  - The hidden file input no longer starts an upload before the form has a submission target (previously a programmatic change event could POST to an undefined form id).
  - Failed uploads surface the server's actionable message ("This form has no file storage connected — …") instead of a generic "try again".

- Updated dependencies [beeaafb]
  - @usefillo/core@0.6.1

## 0.6.0

### Minor Changes

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

- Updated dependencies [f4f4a8b]
- Updated dependencies [f2a7f5a]
- Updated dependencies [aaf29e0]
- Updated dependencies [1309582]
- Updated dependencies [93e3d6e]
  - @usefillo/core@0.6.0

## 0.5.4

### Patch Changes

- f0af5bc: Keep the phone country dropdown inside the viewport on short or narrow embeds, and use browser timezone as a privacy-light phone country hint before falling back to browser locale.
- f589bf4: DOM renderer robustness and accessibility fixes:
  - Importing `@usefillo/dom` no longer crashes in SSR/Node/test environments — the `<fillo-form>` element class and registration are guarded when `HTMLElement`/`customElements` are undefined.
  - Focus is preserved across re-renders: after an interaction, submit, or page change the renderer restores focus (ranking reorder is keyboard-usable again), moves focus to the first error on a failed submit, and to the new page on Next/Back.
  - The signature field has a keyboard/screen-reader "type your name to sign" path (it was pointer-only), and no longer flickers or loses ink on each stroke.
  - The `<fillo-form>` element mounts once on load instead of up to three times (no duplicate `getForm` fetches), and theme/data/client changes update in place instead of destroying entered data.
  - Selecting more files in a multi-file field appends to the existing selection instead of overwriting it.
  - The phone country popover's window/document listeners are cleaned up when the form is destroyed.

- Updated dependencies [f85e41c]
- Updated dependencies [f0af5bc]
- Updated dependencies [299facb]
  - @usefillo/core@0.5.1
