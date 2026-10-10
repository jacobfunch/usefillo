<p align="center">
  <a href="https://fillo.so">
    <img src="https://fillo.so/brand/readme-banner.png" alt="Fillo — forms inside your product, with your UI." />
  </a>
</p>

<p align="center">
  <a href="https://fillo.so/docs">Docs</a> ·
  <a href="https://fillo.so/guides">Guides</a> ·
  <a href="https://fillo.so/agents">Agents</a> ·
  <a href="https://fillo.so/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@usefillo/mcp"><img src="https://img.shields.io/npm/v/@usefillo/mcp" alt="npm version" /></a>
  <img src="https://img.shields.io/npm/l/@usefillo/mcp" alt="MIT license" />
</p>

The [Fillo](https://fillo.so) MCP server. It gives a coding agent the full Fillo
loop — provision a workspace, scaffold a form into the host repo, publish it, and
query its responses — without leaving the session, authenticated exactly like a
human CLI user.

## Install

One click, if your editor supports it:

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=fillo&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB1c2VmaWxsby9tY3BAbGF0ZXN0Il19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?name=fillo&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40usefillo%2Fmcp%40latest%22%5D%7D)

Claude Code:

```sh
claude mcp add fillo -- npx -y @usefillo/mcp@latest
```

Any other MCP client: run `npx -y @usefillo/mcp@latest` over stdio. Set `FILLO_API` to
point at a non-production deployment.

The local server checks for a newer stable release at startup, at most once an
hour, and runs it from `~/.fillo/runtime`. Reconnect to acquire updates; a running
connection keeps its version until it ends. Failed or offline downloads keep the
installed server available. Update diagnostics go to stderr, preserving the
JSON-RPC channel. Set `FILLO_AUTO_UPDATE=0` to pin your installed version; CI and
development checkouts skip updates. Existing installations acquire this behavior
by reconnecting with the `@latest` command above. The hosted MCP server uses the
deployed server version directly.

### Choose a focused toolset

The default server loads the complete catalogue. Set `FILLO_MCP_TOOLSET` in the server's environment to choose a task area:

| Value | Tasks |
| --- | --- |
| `all` | Every tool (default) |
| `build` | Provision a workspace, choose a project, build/publish forms, and manage form settings and storage |
| `responses` | Read responses, inspect delivery and drafts, manage respondents and webhooks |
| `integrations` | Configure form storage, settings, and destinations |
| `admin` | Manage projects, workspace settings, members, and credentials |
| `discovery` | Start with two catalogue tools and activate native tools as needed |

Each focused set contains fewer than 50 tools; their union covers the full catalogue. An omitted tool cannot be called through that focused connection. Switch the value and reconnect when your work changes.

In `discovery` mode, call `fillo_search_tools` with task words, then `fillo_get_tool_schema` with a returned name. Fetching the contract registers the original tool on the connection and sends a tools-list-changed notification. Use a client that refreshes its inventory on that notification. Call the tool by its native name: credentials, argument validation, and human confirmations still apply.

`fillo_list_responses` and `fillo_list_held_responses` accept `includeFields` and `includeMeta`. An empty field list requests no answers; `includeMeta: false` returns metadata as null. IDs, timestamps, and pagination remain available. Omitted options keep the full result, and respondent data keeps its untrusted envelope.

For command execution, `npx @usefillo/cli --agent-help` explains the CLI discovery path. `fillo commands search <task words>` returns names; `fillo commands schema <name>` returns a CLI parser schema with exact subcommand help, or the local MCP contract for a `fillo_` tool name. These reads need no login.

## Credentials

The server reads the same credentials the CLI writes to `~/.fillo/config.json`,
or from the environment:

- `FILLO_TOKEN` — a `fcli_…` login token (from `npx @usefillo/cli login`).
  Authenticated tools (`fillo_list_forms`, `fillo_publish_form`, and trusted
  pushes to a claimed workspace), plus local project selection with an ordinary
  login. File-request pushes remain draft/staged for review.
- `FILLO_PK` — a `pk_…` publishable key. `fillo_provision_workspace` mints one
  and saves it for you.
- `FILLO_API_KEY` — a `fsk_…` project API key, minted in **Settings →
  Connections** of a claimed workspace. Required by the response tools.
- `FILLO_API` — overrides the origin (default `https://fillo.so`).
- `FILLO_CONFIG_DIR` — overrides the config directory (default `~/.fillo`).
- `FILLO_MCP_TOOLSET` — `all` (default), `build`, `responses`, `integrations`, `admin`, or `discovery`.

The server never prints login tokens, API keys, or claim tokens into the
transcript. The `pk_` publishable key is safe to surface (it lives in browser
code), so `fillo_provision_workspace` returns it for you to wire into the app's
public env. Provisioning also makes that temporary project the active local MCP
context, so an older saved account login cannot receive the next push. Selecting
a project switches the context back to the account.

## Tools

| Tool | Auth | What it does |
| --- | --- | --- |
| `fillo_provision_workspace` | none (needs an email) | Create an unclaimed preview workspace, return its `pk_` key and caps, and email its claim link. |
| `fillo_whoami` | login token or `pk_` | Report the active credential, workspace, and project. |
| `fillo_list_projects` | ordinary login token | List projects in the current workspace and mark the current selection. |
| `fillo_create_project` | ordinary login token | Create and select an isolated project and save its `pk_` key. |
| `fillo_select_project` | ordinary login token | Select by id, slug, or unique exact name and update local project state. |
| `fillo_push_form` | login token or `pk_` | Create or update a form and publish by default; set `publish: false` with a login token for explicit review workflows. Storage-blocked file requests remain draft. |
| `fillo_publish_form` | login token | Take a draft or staged changes live after review; return the exact storage setup link when blocked. |
| `fillo_list_forms` | login token | List the project's forms. |
| `fillo_get_form` | none (published) | Fetch a published form's schema, theme, and capabilities. |
| `fillo_search_examples` | none | Search the curated Fillo example library. |
| `fillo_docs` | none | Fetch a Fillo docs page as Markdown by topic. |
| `fillo_list_responses` | login token or `fsk_` key | List a form's accepted responses (claimed workspaces only). |
| `fillo_search_library` / `fillo_get_library_form` | none | Search and read the public form library. |
| `fillo_get_response` | `fsk_` API key | Fetch one response (claimed workspaces only). |
| `fillo_response_summary` | `fsk_` API key | Summarize a form's responses without reading every row (claimed workspaces only). |
| `fillo_claim_status` | `pk_` | Report the provisioned workspace's caps and claim deadline. |

### Managing a claimed workspace

Everything a member can do in the Fillo dashboard also has a tool, under the
SAME NAME the hosted Fillo MCP server uses — one name, one capability, whichever
server your agent reached. Each one calls the HTTP route the Fillo CLI calls:
your `fcli_` login token when you have one (`npx @usefillo/cli login` or
`FILLO_TOKEN`), otherwise an `fsk_` project API key in `FILLO_API_KEY` carrying
the named scope. With both, the login token wins — a key has no acting human.

| Area | Tools | Scope |
| --- | --- | --- |
| Form lifecycle | `fillo_pull_form`, `fillo_rename_form`, `fillo_duplicate_form`, `fillo_unpublish_form`, `fillo_discard_changes`, `fillo_delete_form`, `fillo_list_versions` | `forms:read`, `forms:write` |
| Logo | `fillo_import_logo` — download a PNG, JPEG, or WebP from a public https URL; put the returned id in the theme's `logo` or `dark.logo` | `forms:write` |
| Uploads | `fillo_get_storage`, `fillo_set_storage`, `fillo_list_drive_folders`, `fillo_set_drive_folder`, `fillo_reset_drive_folder` | `storage:manage` |
| Settings | `fillo_get_settings`, `fillo_update_settings` | `settings:manage` (plus `forms:write` for the presentation keys) |
| Destinations | `fillo_get_integration`, `fillo_enable_integration`, `fillo_disable_integration`, `fillo_list_connections`, `fillo_select_connection`, `fillo_disconnect_integration`, `fillo_remove_connection_account`, `fillo_rename_discord_channel`, `fillo_hubspot_properties`, `fillo_hubspot_pipelines` | `integrations:manage` |
| Responses and delivery | `fillo_list_held_responses`, `fillo_release_responses`, `fillo_delete_response`, `fillo_delivery_status`, `fillo_retry_deliveries`, `fillo_redeliver_responses`, `fillo_list_drafts`, `fillo_form_insights`, `fillo_list_respondents`, `fillo_delete_respondent` | `responses:manage`, `respondents:*`; `fillo_form_insights` needs `forms:read` **and** `responses:read` |
| Webhooks | `fillo_list_webhooks`, `fillo_add_webhook`, `fillo_update_webhook`, `fillo_remove_webhook` | `webhooks:manage` |
| Workspace | `fillo_rename_workspace`, `fillo_rename_project`, `fillo_get_branding`, `fillo_set_branding`, `fillo_get_billing`, `fillo_list_members`, `fillo_invite_member`, `fillo_change_member_role`, `fillo_remove_member` | `workspace:manage`, `members:manage` |
| Credentials | `fillo_list_tokens`, `fillo_revoke_token`, `fillo_list_sync_tokens`, `fillo_create_sync_token`, `fillo_revoke_sync_token`, `fillo_list_api_keys`, `fillo_revoke_api_key`, `fillo_list_agents`, `fillo_revoke_agent` | `workspace:manage` |
| Developer settings | `fillo_get_code_sync_policy`, `fillo_set_code_sync_policy`, `fillo_get_origins`, `fillo_set_origins`, `fillo_identity_status`, `fillo_enable_identity`, `fillo_disable_identity` | `workspace:manage` |

`fillo_delete_form`, `fillo_get_branding`, `fillo_set_branding`,
`fillo_get_billing`, `fillo_list_api_keys`, and `fillo_revoke_api_key` need a
login token — there is no project-API-key route for them, so a leaked key can
never enumerate or revoke the workspace's credentials or read its plan.
`fillo_get_billing` is read-only: it reports the plan and this month's usage and
returns the Settings link, but no tool can subscribe, change the plan, or open
checkout — an owner or admin does that in Settings → Billing & plan. `fillo_delete_response` needs one too, for a
different reason: its scoped route takes no typed confirmation, so on a project
API key the confirmation would be checked only by the caller, which is no
confirmation at all.

A webhook's target URL is a credential — the path of a Zapier catch hook or an
n8n webhook is what authorizes posting to it — so `fillo_delivery_status` names
destinations without spelling them out: connector-owned hooks come back as
"Zapier" or "n8n", and other webhooks as their host plus a short fingerprint of
the path. Read the full URL in the dashboard's Activity page.

### The human layer

Routine, reversible actions run on the credential alone. Two kinds do not:

- **Outward** — unpublishing, starting a third-party destination, adding a
  webhook, releasing or re-sending responses, inviting a member or changing a
  role, a code-sync policy, the allowed origins, or identity verification. These
  take `confirm: true`, and the tool refuses without it with a message telling
  the model to ask a person first. Nothing has changed when it refuses.
  Publishing is the exception on this server: `fillo_push_form` and
  `fillo_publish_form` take no `confirm`, because a login token IS the person
  who ran `fillo login` on this machine — the same reason `fillo publish` runs
  without a flag. The hosted OAuth server, where the grant belongs to an agent
  rather than to you, is what gates publishing behind an approval link.
- **Destructive** — deleting a form, a response, or a respondent, removing a
  member or an integration account, disconnecting a provider or a Discord
  server, revoking a token, sync token, API key, or MCP grant, turning identity
  verification off. These take `confirm` as a
  string that must equal the target exactly — a member's email, a token id, a
  response id — and the server compares it, so a guess is a 409 that quotes the
  value to retry with.

A secret Fillo mints once (a webhook signing secret, an `fsync_` token, an
identity-verification secret) is returned in that one tool result and never
again. Store it in a secret manager; it is never written to a log.

Write annotations use the conservative worst-case hint because a push can
replace draft state and a publish can replace the public schema, and
`openWorldHint` marks exactly the actions whose effect leaves the workspace.
Every tool is a thin wrapper over Fillo's public HTTP API — the server never
touches the database and imports no app code, so workspace scoping, rate limits,
authorization, and validation stay in one place.

The three project tools are local-only and require the general token minted by
`fillo login`. A project-specific handoff and a hosted remote-MCP OAuth grant
remain pinned to the project a human approved. Selecting locally also clears
cached preview and `fsk_` state from the prior project; replace any
`FILLO_PK` or `FILLO_API_KEY` environment overrides yourself.

Projects are sites/apps beneath one billed workspace. They isolate forms,
publishable/API keys, allowed origins, respondent identities, and agent
authority. Workspace membership, billing, storage connections, and usage totals
remain shared.

## Links

- **Docs:** [fillo.so/docs](https://fillo.so/docs)
- **Website:** [fillo.so](https://fillo.so)

MIT licensed.
