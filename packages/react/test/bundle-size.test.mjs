import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/** Gzipped budgets, baselined 2026-07 (+~20% headroom). Raising one is a
 * deliberate release decision, not a side effect — the JSX release gets an
 * explicit allowance when it lands.
 * 2026-07: core 26 → 28 for the saved-progress draft protocol (client draft
 * calls + controller autosave/restore/flush), measured at 26.96KB gz.
 * 2026-07: core 28 → 29 for drop-off recovery — resume-link fragment adoption
 * with server-side token rotation on adopt (single-use resume links, closes
 * draft fixation), measured at 28.02KB gz.
 * 2026-07: core 29 → 30 for validated conditional operands, upload-resume
 * binding, and the public JSX helpers. The bundle measures 28.97KB locally and
 * just over 29KB with GitHub's Linux zlib, so the old ceiling had no portable
 * headroom.
 * 2026-07: core 30 → 31 for resumable S3 multipart control, idempotent session
 * creation, and lost-completion reconciliation, measured at 30.22KB gz.
 * 2026-07: core 31 → 33 for the review-remediation batch — the shared phone
 * popover positioner lifted from react/dom into core (so both renderers share
 * one impl), the whole-form cross-page visibility helper, and the expanded
 * FilloStrings surface (validation/upload/duplicate/resume-link localization).
 * react/dom each shrank by the popover copy they no longer carry. Measured at
 * 32.25KB gz.
 * 2026-07: core 33 → 34 for logic-depth P1 page jumps — the shared
 * reachability engine (reachablePageSequence + resolveNextPage + terminal/
 * reachable-field helpers) that the client renderer AND the server validator
 * both walk, plus the jump normalization. Measured at 33.81KB gz.
 * 2026-07: react 22 → 23 for the submission-trust P2 Turnstile widget — the
 * headless script loader + widget lifecycle (turnstile.tsx) and the FilloForm
 * token/expiry/reset wiring. Only loaded when a form requires a challenge, but
 * it ships in the bundle. Measured at 22.9KB gz.
 * 2026-07: react 23 → 24 for the P2 Turnstile hardening — the script-load-
 * failure path now removes the dead <script> so a later remount injects a FRESH
 * element and actually re-fetches (fixing a permanently-bricked challenge after
 * a transient load error), and the timeout path now resets the widget so an
 * interactive-challenge timeout no longer dead-ends (shared clear+reset closure).
 * Measured at 23.04KB gz.
 * 2026-07: core 34 → 35 for the P2 Turnstile challenge — TrustPolicy.challenge,
 * normalizeTrust's challenge branch, the ChallengeConfig type, SubmitMeta's
 * challengeToken, and the controller's challengeRequired/getChallengeToken/
 * onChallengeFailed submit wiring (the client attaches the token; the server is
 * the gate). Measured at 34.12KB gz.
 * 2026-07: react 24 → 25 for the first-render dev chrome — the `preview` prop
 * (badge + production console guard), the shared DevChrome precedence
 * component with the devNotices opt-out, developer-grade submit failures with
 * the connect-storage deep-link, and the storage-blocked upload dropzone
 * pre-emption. The bundle was already brushing the old ceiling before this
 * batch; measured at 24.52KB gz after.
 * 2026-07: dom 19 → 21 for the same first-render chrome landing in the DOM
 * renderer — visible draft banner with the storage deep-link, preview
 * option/attr + badge, single-notice precedence with the devNotices opt-out,
 * verbose submit errors, and the upload pre-emption. Measured 20.0KB gz.
 * 2026-07: react 25 → 26, dom 21 → 22 for the not-open blur overlay — the
 * approved respondent-facing replacement for the dead draft panel (display-only
 * display-only schema + card, layered no-submit construction). Measured
 * 25.46KB / 21.15KB gz.
 * 2026-07: core 35 → 38 for logic-depth P2 calculated fields — the CalcExpr
 * evaluator (calc.ts), the joint {visible set, calc values} fixpoint in
 * logic.ts, the calc AST normalizer + structural hard errors (missing/
 * non-numeric refs, cycles) in schema-validation, the calc floor constant,
 * and the controller's computeCalculated-before-notify wiring. Alone the calc
 * batch measured 36.5KB gz (35 → 37); merging main's first-render/not-open
 * core additions on top lands the combined bundle at 37.03KB, so the ceiling
 * takes the next whole step rather than a zero-headroom 37.
 * 2026-07: react 26 → 27 for the calculated display row (Stage C) — the
 * read-only Calculated component in fields.tsx (label-tied <output> value
 * formatted through core's formatAnswer). The bundle was already brushing the
 * old ceiling at 25.83KB before the row; measured 26.02KB gz after. The same
 * row in dom fits its existing 22 ceiling (21.62KB gz).
 * 2026-07: core 38 → 39 for the number-formatting SDK input — the display-
 * only grouped-number helpers (number-format.ts: formatGroupedNumber +
 * parseGroupedNumber, locale group/decimal detection via formatToParts and
 * the de-DE-family structural disambiguation) plus the number field's
 * decimals/prefix/suffix/notation schema additions. Measured 39,725 B gz —
 * 38.79KB, just under the new ceiling. react's own slice (the adornment
 * wrapper + grouped focus/blur draft state in fields.tsx) fits the existing
 * 27 ceiling, measured 26.6KB gz.
 * 2026-07: dom 22 → 23 for the same number-formatting input (grouped
 * focus/blur listeners + the .fillo-number affix wrapper in index.ts). The
 * dom bundle was already brushing its ceiling at 21.74KB; the slice adds
 * +0.33KB and lands at 22.07KB gz, so the ceiling takes the next whole
 * step.
 * 2026-07: core 39 → 41 for the input-quality CORE batch (phone.ts, radio-
 * nav.ts, appearance.ts, strings.ts): full ITU phone-country coverage (70
 * curated + ~177 packed, ~247 total) with Intl.DisplayNames-resolved names
 * and an Intl.Collator-sorted picker list, plus the pending-international
 * "+" parse fix; the shared radioGroupStep keyboard-nav helper consolidating
 * both renderers' radiogroup math; resolveThemeAppearance's WCAG-luminance
 * dark/light inference; and the new error-summary/announcement/ranking/
 * phone/signature strings. Measured 41,364 B gz — 40.4KB, over the
 * single-step 39→40 headroom this batch was estimated against, so the
 * ceiling takes the next whole step instead of a zero-headroom 40.
 * 2026-07: react 27 → 28 for the input-quality REACT batch: rating/scale
 * radiogroup ids (label wiring dead before this), the radioGroupStep
 * keyboard-nav adoption replacing the local wrap math, ranking's
 * refocus-after-extreme-move effect, the phone picker's closed-state
 * trigger keyboard + Tab-away close + pending-"+" handling (now consuming
 * core's previousDigits option and rendering PHONE_PICKER_COUNTRIES), the
 * signature canvas's live role=img accessible name plus Clear's focus fix,
 * upload's per-row alert/status text, and the choice-row/Other-row rewrite
 * onto native label click-forwarding. Measured 27,668 B gz — 27.02KB, just
 * over the old ceiling.
 * 2026-07: dom 23 → 24 for the same input-quality batch landing in the DOM
 * renderer — matrix per-row radiogroups + cell labels, the phone trigger
 * keyboard/focusout-close/pending-"+" handling, forced-colors + target-size
 * + RTL CSS, signature/upload aria, and the stale-context.value phone fix.
 * Measured 23,765 B gz (23.2KB), 213 B over the old ceiling, so it takes
 * the next whole step.
 * 2026-07: dom 24 → 26 for the upload per-file UI port (the audit's largest
 * parity gap — per-file rows with individual progress/cancel/retry/remove
 * and genuinely concurrent uploads, replacing the aggregate bar and the
 * one-upload-per-field busy guard), the hoisted polite/alert announcement
 * channels, the reachable-sequence progress bar, and the original aggregate
 * validation pass (the summary UI was later retired). Measured 25,840 B gz
 * (25.23KB); the next whole step above the
 * measurement is 26.
 * 2026-07: react 28 → 29 for the number keystroke filter + announcement
 * slice — measured 27.97KB locally, 35 B under the 28 ceiling, which is
 * inside the documented local-vs-CI zlib gap (see the core 29 → 30 entry):
 * no portable headroom, so the ceiling takes the next step.
 * 2026-07: dom 26 → 28 for the P0.1 Turnstile port (audit finding — dom
 * shipped no widget at all, so a challenge-gated form's token never reached
 * the server gate and the form was unsubmittable through this renderer): the
 * script-loader singleton + load-failure recovery ported from react's
 * turnstile.tsx, the widget lifecycle as DomFormController fields/methods
 * (token/expiry/timeout/reset, the persistent re-attached container so the
 * iframe survives replaceChildren()), and the challengeRequired/
 * getChallengeToken/onChallengeFailed engine wiring plus showChallenge parity
 * in renderForm(). Comparable in scope to react's own 22→24 Turnstile
 * growth, landed in one pass here instead of two. Measured 27,844 B gz
 * (27.19KB) — over the single-step 26→27 headroom this port was estimated
 * against, so the ceiling takes the next whole step instead of a
 * zero-headroom 27.
 * 2026-07: core 41 → 44 for the logic-depth P3 repeating-groups CORE slice —
 * the RepeatingGroupField kind + the named GroupInstanceValue[] FieldValue
 * member, the recursive normalizeBlock case plus the hard-error battery
 * (bounds, child allowlist, per-group child-id uniqueness, both scope walls,
 * the ~180KB worst-case size estimate), the canonical per-instance/per-child
 * recursion, instance-count + compound-key child validation, the scoped
 * visibleGroupChildren helper (resolveLogicState reused one level down), the
 * formatAnswer "N × item" summary, the <Fillo.RepeatingGroup> blockChildren
 * walk mode, and the 0.12.0 group floor. Core headroom was 0.51KB before the
 * batch, so the design contract pre-authorized the three-step bump (decision
 * 12: 41→44) instead of estimating single steps. Measured 44,738 B gz
 * (43.69KB).
 * 2026-07: dom 28 → 29 for the carried-forward input-quality fix wave (the
 * ledger in docs/decisions/input-quality.md): the file_upload dropzone —
 * role=button, drag & drop, Enter/Space activation, a hidden native input it
 * forwards to — react/dom parity for a control this package used to lack
 * entirely, plus the aria-required role-scoping fix, the matrix empty-corner
 * <td>, and the macrotask-deferred queueRender (a same-gesture pointer click
 * surviving a text field's blur-triggered rebuild instead of landing on a
 * node the rebuild already replaced). Measured 28,843 B gz (28.17KB) — over
 * the old 28 ceiling, so it takes the next whole step.
 * 2026-07: react/dom 29 → 30 for embed-identity enforcement: active raw
 * schemas now fail before rendering without a formId, explicit renderOnly
 * previews disable transport with truthful upload copy, and active roots
 * expose their resolved form id for browser verification. Measured 29,932 B
 * gz for react and 29,674 B for dom; both safety paths are shipped by the
 * public renderers, so the ceiling takes the next whole step.
 * 2026-07: core 41 → 42 for field-aware required-error defaults and the
 * shared localization resolver used by both renderers. Measured 42,381 B gz
 * (41.39KB); the additional copy is public renderer behavior, so the ceiling
 * takes the next whole step.
 * 2026-07: react 29 → 30 for the logic-depth P3 repeating-groups REACT slice
 * — the RepeatingGroup component (group.tsx): instance cards + Add/Remove
 * rendered through the same public BlockRenderer via a synthesized
 * per-instance child-scoped api slice (compound "${groupId}.${index}.
 * ${childId}" ids/data/errors, whole-array read-patch-write through the
 * group's own setValue, memoized per instance so an edit in one card can't
 * fan out and re-render every sibling), the add/remove focus management +
 * polite-channel announcements, and the .fillo-group* CSS. Decision 12
 * pre-authorized exactly this step (29→30) the same day the contract
 * locked. Measured 30,319 B gz (29.61KB), just over the old ceiling.
 * 2026-07: dom 29 → 31 for the repeating-group renderer — instance cards
 * rendered through the shared per-field dispatch with compound-id child
 * contexts, whole-array read-patch-write closures, the widened
 * group-focus intent resolved by position across the deferred rebuild, and
 * add/remove announcements. Measured 30,878 B gz (30.15KB); the
 * contract's pre-authorized single step was consumed by the ledger wave,
 * so this takes the two steps the measurement demands (the Turnstile-port
 * precedent).
 * 2026-07: rebasing repeating groups over the field-aware required-copy and
 * embed-identity releases combines their previously separate measurements:
 * core 45,625 B (44.56KB), react 31,402 B (30.67KB), and dom 31,729 B
 * (30.99KB). Core/react take the next whole step; dom takes 32 because a
 * 31KB ceiling leaves only 15 bytes and would recreate the known cross-zlib
 * CI flake documented above.
 * 2026-08: react 31 → 32, dom 32 → 33 for the challenge BRIDGE — the human
 * check now renders inside a Fillo-hosted iframe (postMessage token/error/
 * expired/reset protocol, origin+source checks, ready watchdog, cdata form
 * binding, challengeTheme pass-through) so it works on ANY embedding domain
 * with only the deployment's hostname on the Cloudflare widget; the direct
 * script path stays as the older-server fallback. Measured 31,4xx B gz react
 * (31.4KB) and 32,9xx B dom (32.2KB); both take the next whole step.
 * 2026-08: core 45 → 46 for the respondent-safe error contract — stable API
 * codes now map to renderer-localized copy, including challenge, upload,
 * identity, scope, closed, and rate-limit states, without reflecting server
 * prose. Measured 46,368 B gz (45.28KB); take the next whole step. */
const BUDGETS_KB = {
  "../../core/dist/index.js": 46,
  "../dist/index.js": 32,
  "../../dom/dist/index.js": 33,
};

for (const [rel, budget] of Object.entries(BUDGETS_KB)) {
  test(`bundle budget: ${rel} ≤ ${budget}KB gz`, () => {
    const gz = gzipSync(readFileSync(new URL(rel, import.meta.url)), { level: 9 });
    const kb = gz.length / 1024;
    assert.ok(kb <= budget, `${kb.toFixed(1)}KB gz exceeds the ${budget}KB budget`);
  });
}
