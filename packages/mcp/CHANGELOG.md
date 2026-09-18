# @usefillo/mcp

## 0.7.1

### Patch Changes

- 903f44a: Attach package version and canonical command/tool names to existing Fillo API
  requests so server-side usage diagnostics can distinguish CLI and local MCP
  operations. No arguments, command lines, answers, credentials, or tool results
  are added to telemetry, and no separate analytics requests are sent.

## 0.7.0

### Minor Changes

- 6b66be8: Run the whole workspace from your coding agent. Sixty-two new tools cover what
  the dashboard covers: a form's lifecycle, its destinations, held responses,
  delivery repair, drafts, insights, webhooks, members, credentials, embed
  origins, and identity verification. Every one answers to the same name as its
  twin on Fillo's hosted MCP server, so an agent that learned one can drive the
  other. Each calls the route the Fillo CLI calls: your login token when you have
  one, a scoped `fsk_` key otherwise, and that key is bound to its deployment.

  Outward actions take `confirm: true` after you ask a person; irreversible ones
  take the target typed back exactly. Adding a webhook counts as outward. Upload
  destinations and Drive folders ride `storage:manage`; `fillo_form_insights`
  needs `responses:read` as well as `forms:read` because its breakdowns quote
  answers; `fillo_update_settings` needs `forms:write` on top of `settings:manage`
  for the six keys that live in the form's schema. `fillo_delivery_status` names a
  destination rather than returning a webhook's target URL, `fillo_delete_response`
  needs a login token, and `fillo_delete_respondent` returns its receipt in the
  untrusted envelope.

## 0.6.0

### Minor Changes

- 292105d: Add read-only product form library search and exact schema retrieval, including source attribution, suitability guidance, setup requirements, and measurement caveats. Catalog content is fetched from Fillo's live public endpoint; existing setup and publishing permissions are unchanged.

## 0.5.1

### Patch Changes

- 8d9bbd7: Forward an optional marketing `promptCopyId` on workspace provision (`--pc` in the CLI, `promptCopyId` on the MCP tool) so a copied landing prompt can be joined to the provisioned workspace.

## 0.5.0

### Minor Changes

- 1e6940a: Make `fillo_push_form` publish regular forms by default, add an explicit `publish: false` review mode for login-token workflows, and mark the tool's public-write behavior honestly for MCP clients.

## 0.4.0

### Minor Changes

- f7517ed: Add `fillo_publish_form` so token-authenticated agents can complete a reviewed draft or staged form, including actionable storage setup and breaking-change guidance. Preserve file-request purpose and exact storage during pushes, and report setup drafts and storage warnings truthfully.
- 87926fb: Add project lifecycle commands to the CLI and local MCP server. Ordinary human-approved logins can list, create, and select isolated projects inside their billed workspace, while handoffs and remote grants remain pinned to their approved project.

  Clarify the core client contract so browser-safe publishable keys are described as project keys.

## 0.3.1

### Patch Changes

- 96d5a78: Broaden npm keywords and add the top-level `mcpName`
  (`io.github.jacobfunch/usefillo`) so `@usefillo/mcp` surfaces in registry search
  and passes the official MCP Registry's npm-ownership validation. Metadata only —
  no code or public API changes.

## 0.3.0

### Minor Changes

- 16b5c8d: Wrap response tool payloads (`fillo_list_responses`, `fillo_get_response`) in an
  `{ untrusted, note, data }` envelope so models treat respondent-provided answers as
  data, not instructions, and add a `fillo_response_summary` tool that aggregates
  totals, per-field answer rates, and choice distributions with a recent sample.

### Patch Changes

- 1e655a5: Sharpen three MCP tool descriptions so coding agents select the right tool on the
  first pass: disambiguate `fillo_docs` vs `fillo_search_examples` (prose docs vs an
  adaptable form schema + code) and point `fillo_whoami` to `fillo_claim_status` for
  the claim deadline. Wording only — no change to tool names, input schemas, auth,
  or behavior.

## 0.2.1

### Patch Changes

- e3f143f: README now opens like a product SDK: the shared fillo.so banner, a centered
  Docs / Guides / Agents / Changelog link row, and npm version + license badges
  ahead of the pitch. No install or API changes.

## 0.2.0

### Minor Changes

- a26f9e0: Initial release of `@usefillo/mcp`, the Fillo MCP server. Install it with
  `claude mcp add fillo -- npx -y @usefillo/mcp` (or point any stdio MCP client at
  `npx -y @usefillo/mcp`) to give a coding agent the full Fillo loop from inside
  its session: provision an unclaimed preview workspace, scaffold and publish a
  form, read docs and examples, check the claim deadline, and query responses.

  The server is a thin client over Fillo's public HTTP API — it never touches the
  database and imports no app code, so workspace scoping, rate limits, and schema
  validation stay server-side. It authenticates with the same credentials a human
  already has: `~/.fillo/config.json` (written by `@usefillo/cli`) or the
  `FILLO_TOKEN` / `FILLO_PK` / `FILLO_API_KEY` environment variables, with
  `FILLO_API` overriding the origin. Ten read/scaffold tools, no destructive ones.
  Response tools require an `fsk_` workspace API key and therefore a claimed
  workspace.
