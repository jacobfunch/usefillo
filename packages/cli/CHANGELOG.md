# @usefillo/cli

## 0.19.0

### Minor Changes

- d90fb7e: New `fillo discord` command family: everything the dashboard offers for the Discord destination now works from the terminal. `discord connect` opens Discord's own channel picker in your signed-in browser and waits (and says so plainly when a deployment has no Discord app, pointing at the paste lane instead); `discord webhook` connects a channel webhook you paste — read from a hidden prompt or `FILLO_DISCORD_WEBHOOK_URL`, never from an argument, because the URL is the whole credential and arguments land in shell history and `ps` output; `discord status <form>` reports where a form posts, which fields it carries, and whether the project was re-pointed at another webhook; `discord enable <form>` turns it on and sets `--fields`, `--early-signal 5|10|25|off`, `--role <guildId>/<roleId>`, and `--auto-join`; `discord disable <form>` stops that form without disconnecting the workspace's webhook; `discord roles [guildId]` lists your servers, then one server's roles with whether Fillo can actually grant each.

  `--early-signal` and `--auto-join` widen what leaves Fillo — every answer into a channel, and adding people to a server — so setting either prints a one-line notice saying exactly what was agreed to (on stderr as a JSON line under `--json`, so stdout stays one document).

  Also new: `fillo tokens create-connector --tool zapier|n8n` mints the project-bound token a no-code connector authenticates with, printed once with the treat-as-secret warning and revocable from Settings → Connections.

### Patch Changes

- 1e6940a: Make code-form draft and staged previews state that responses are not live, link developers directly to the required Fillo publish step, and make server-confirmed publication a required agent completion check.

## 0.18.0

### Minor Changes

- 5abda93: New `fillo branding` command: print, hide (`off`), or restore (`on`) the workspace's "Powered by Fillo" badge over an authenticated CLI login — hiding requires the Everything plan, which stays a human-only selection in Settings. Plus an onboarding-feedback round for the build-with-fillo skill: first-time setups open with a three-line plan (including a permission-prompt heads-up); first-build verification is capped at one load plus one safe submit, with the full state matrix reserved for production-readiness; `fillo claim` now runs at handoff so a single inbox click claims the workspace and connects the terminal, and the already-claimed branch is documented as a plain login; the badge policy is taught (a paid-plan checkbox, `fillo branding off` when unlocked, headless never shows it, never hide it with CSS, no unprompted upsell); labels must not contain "(optional)" — the renderer appends its own marker. The dual-folder install notice now names the single-folder flags (`--agent`, `--dir`).
- 87926fb: Add project lifecycle commands to the CLI and local MCP server. Ordinary human-approved logins can list, create, and select isolated projects inside their billed workspace, while handoffs and remote grants remain pinned to their approved project.

  Clarify the core client contract so browser-safe publishable keys are described as project keys.

- f7517ed: Let CLI push payloads bind an exact Google Drive, Box, Amazon S3, or Cloudflare R2 destination, and teach the bundled Build with Fillo skill to create and verify standalone hosted file requests without adding an unnecessary host-app route.

### Patch Changes

- f7517ed: Forward the explicit `file_request` purpose from canonical push files so guided file-request setup and its upload invariant survive every dashboard and agent handoff.

## 0.16.1

### Patch Changes

- 96d5a78: Broaden npm keywords so the packages surface in registry search; repository
  metadata ships with this release. The linked release group carries the metadata
  out on the next publish — no code or public API changes.
- eded9fc: Add `repository` metadata pointing each public package at the source mirror
  github.com/jacobfunch/usefillo, so npm links the package page to its code. The
  five public packages (`@usefillo/core`, `@usefillo/react`, `@usefillo/dom`,
  `@usefillo/cli`, `@usefillo/mcp`) each carry a `repository.directory`; the
  linked release group carries the change out on the next publish.

## 0.16.0

### Minor Changes

- 26ab063: Surface the pre-authoring uploads signal and advisory push notices on the
  unclaimed-preview path so first-timers aren't locked out of the storage check.
  - `agent bootstrap` now reports `canPublishFileFields` (human line + `--json`),
    read straight from provisioning — no login required, where `whoami`/`storage
status` are unreachable until the workspace is claimed.
  - Preview `push --json` now carries a top-level `staged` boolean and
    `canPublishFileFields`, matching the authenticated lane.
  - `push` now prints (and forwards in `--json`) advisory `notices`: field
    properties the schema normalizer dropped (e.g. a `defaultValue` on a
    `select`, which has no default option yet) and any declared per-file
    `maxFileSizeMb` above what the workspace's current storage lane accepts (the
    effective cap wins). The push still succeeds.

## 0.15.0

### Minor Changes

- af56be3: `fillo agent bootstrap` and `fillo init` now resolve and echo the workspace they will use before doing any work — its name and whether it is NEW (just provisioned) or EXISTING (from a stored login). When a stored `fillo login` would attach the run to a real, connected workspace, bootstrap no longer silently provisions a throwaway preview beside it: it names that workspace in an unmissable line and points to `fillo logout` for an isolated preview instead, matching how `push` resolves credentials. New previews take their name from the repository/directory the CLI runs in (override with `--workspace-name <name>`) instead of a generic placeholder; the name is derived from the filesystem, never by spawning git.
- af56be3: Truthful go-live preflight for file uploads and push lifecycle.
  - `fillo whoami` and `fillo storage status` now report `canPublishFileFields`,
    a single pre-authoring "can I ship a file field right now?" boolean. It is
    `true` only when a default upload destination resolves for the workspace (an
    implicit pin, one connected durable provider, or the transit allowance with
    headroom), so it is honestly `false` when several providers are connected but
    none is chosen as the default — the case a per-form `uploadsAvailable: true`
    used to mask. The value appears on both the human output and `--json`.
  - `fillo push --json` now returns the full lifecycle for each form in one
    round-trip — `status`, `staged`, `accepting`, `uploadsAvailable`,
    `canPublishFileFields`, and any storage `warning`/`warningUrl` — instead of
    just `{ formId, slug, url }`, so a push no longer needs a follow-up `status`
    call. A one-off draft push also surfaces any storage warning in human output.
  - The bundled Build with Fillo skill tells agents to check `canPublishFileFields`
    before authoring a `file_upload` field rather than dropping optional
    attachments defensively, and documents the per-form vs. workspace distinction.

### Patch Changes

- af56be3: Bundled Build with Fillo skill: check storage readiness (`fillo storage status`/`whoami`) before choosing the schema instead of finding out at a blocked publish, so agents stop defensively dropping file fields. Document the real behavior at the 10-response preview cap (rejected outright, HTTP 403, never queued or silently dropped). Explain why `skill install` writes both `.agents/skills` and `.claude/skills` (cross-agent compatibility, not duplication) in the installer output, help text, and README.

## 0.14.1

### Patch Changes

- 2384792: Network failures now name the API host the CLI tried and why it was unreachable (ECONNREFUSED, DNS failure, timeout) instead of dying with Node's bare "fetch failed", and call out the FILLO_API/--api override when one is active. An empty or blank FILLO_API is treated as unset. Standalone `fillo agent bootstrap` now honors `--api`.

## 0.14.0

### Minor Changes

- 16b5c8d: `fillo agent bootstrap` now works without a browser handoff: run with no `--run`/`--token` and it provisions a workspace (the same email flow as `fillo init` — a TTY confirms your git identity, agents pass `--email`) and installs the Build with Fillo skill in one step. The `--run`/`--token` form remains the browser-watched variant. In agent mode without an email it prints an actionable next step instead of a bare usage error.
- 16b5c8d: `fillo login` now finishes in the browser with a loopback + PKCE handshake on the
  same machine: it opens the approval page, you click Connect, and the terminal
  catches its token on 127.0.0.1 with nothing to copy or type. The device-code flow
  (a short code you approve in any browser) stays as the automatic fallback for
  headless, CI, SSH, and agent sessions, and you can force it with `fillo login
--headless`. Claiming a workspace from the emailed link now connects the terminal
  that ran `fillo claim` as part of saving, so there is no separate code to match.
- 16b5c8d: Terminal-first workspace control: `keys` (create/list/revoke with read/agent/full
  presets, explicit danger scopes, 90-day default expiry, and plaintext shown once),
  `claim` (device-code and claim-email fusion that approves the terminal from the
  inbox and upgrades the stored config in place), `responses` (list/export/summary),
  `storage` (connect S3/R2 headless, or Drive/Box over a signed-in browser URL),
  `slack`, `webhooks` (list/add/set/remove with the signing secret shown once),
  `settings` (get/set), `members`/`invite`/`cancel-invite`, and guarded
  `delete form|workspace` (typed confirmation; `--confirm` for agents, `--yes` never
  skips). Adds a global `--json` mode and an automatic agent mode (non-TTY or
  `FILLO_AGENT=1`): no ANSI, no browser auto-open, and do-not-retry-login guidance.

### Patch Changes

- 16b5c8d: `fillo claim` now denies its device code when interrupted (Ctrl-C), so opening the claim link afterward shows "Save workspace" instead of offering to connect a terminal that is no longer listening.

## 0.12.1

### Patch Changes

- 0e8e288: Teach the installed Build with Fillo skill to install explicit latest SDK packages and verify the resolved registry version before inspecting their APIs.

## 0.12.0

### Patch Changes

- 54c7315: Keep upload progress, retry, and remove controls aligned across active, failed,
  and completed file rows. Require every active embed to resolve a real Fillo
  target, add explicit transportless `renderOnly` previews, expose the resolved
  form id for browser verification, and distinguish preview-disabled uploads
  from storage or connection failures.

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
- 3abac4e: Add `fillo agent bootstrap` to install the Fillo skill, complete any required
  browser workspace approval, and connect a tracked coding-agent run with one
  command.
- fa773f5: Ship the first-render experience as one coordinated SDK release. Core adds
  developer-grade resolution errors plus optional server-truth
  `accepting`/`acceptingReason` fields. React and DOM gain cosmetic preview chrome,
  structured storage guidance, and a display-only blurred form beneath honest
  not-open/closed cards. The CLI adds guarded `fillo publish` for staged changes
  and `fillo test-response` for credentialed staged-schema validation whose
  short-lived preview rows never enter normal response, delivery, limit, or
  analytics paths.

### Patch Changes

- e3f143f: READMEs now open like a product SDK: a shared fillo.so banner, a centered
  Docs / Guides / Examples / Changelog link row, and npm version + license
  badges ahead of the pitch. No install or API changes.
- 2ae6254: READMEs slimmed to the quickstart shape: install, a first form, one
  differentiator per package, and links into the docs. Operational depth
  (CI sync tokens, stdin pushes, the raw sync endpoint, the agent progress
  protocol, styling minutiae) now lives only in the docs it links.

## 0.9.0

### Patch Changes

- 9672604: Install the redesigned Build with Fillo skill for shared Agent Skills hosts and
  Claude Code by default, with a safe `--dir` fallback for every other coding
  agent skill directory.

## 0.8.0

### Minor Changes

- 025ce57: Add a project-scoped installer for the provider-neutral Build with Fillo Agent
  Skill, with explicit Codex, Cursor, GitHub Copilot, Gemini CLI, and Claude Code
  targets, an explicit global option, and safe automatic updates for CLI-managed
  copies. Agent handoffs can also attach an existing logged-in workspace with
  `fillo agent connect --account`. New preview workspaces require
  `fillo init --email` and send their private workspace link directly to that
  inbox.
- c8dd79a: Add review-preserving `fillo push --stage`, stdin schema input, and
  `FILLO_SYNC_TOKEN` support for least-privilege server and CI staging. The legacy
  `--draft` flag aliases safe staging when a stable handle is present while its
  legacy no-handle form remains a new one-off draft. Sync authorization errors
  include actionable recovery without printing bearer tokens.

### Patch Changes

- c8dd79a: `fillo push` now validates a code-defined form's schema locally (with the same
  @usefillo/core validator the server uses) before syncing, so a malformed form
  fails instantly with a clear message instead of a server round-trip.
- 35a487f: Validate the canonical Agent Skill before copying it, require the published
  bundle to be complete and byte-identical, and verify the same invariant inside
  the npm tarball.
- be2abfa: Harden schema validation, conditional logic, resumed uploads, server-finalized resumable S3 multipart uploads, renderer lifecycle and accessibility, concurrent file handling, and CLI argument/config safety.

## 0.5.1

### Patch Changes

- 8850310: CLI reliability and DX fixes:
  - `fillo login` no longer crashes when no browser opener exists (headless/CI/WSL); the printed URL stays the working fallback.
  - Unknown commands exit non-zero (so a typo is detectable in scripts), and non-JSON/gateway error responses surface a clear message instead of an "Unexpected token <" parser error.
  - `logout` clears only the account token and preserves a provisioned publishable key (so an unclaimed workspace isn't orphaned); `login` merges rather than replacing the config.
  - Adds `--version`/`-v`, an `engines` (`node >=18`) field, and a clear error when a pushed module exports no recognizable form schema (instead of silently pushing `undefined`).
