/**
 * The tool inventory, spelled out once.
 *
 * Tool NAMES are a public contract shared with the HOSTED server
 * (apps/web/src/lib/mcp/tools/*.ts): the same capability answers to the same
 * name whether an agent reached Fillo over stdio or over OAuth, so an agent's
 * saved plan and a customer's prompt keep working across both. A rename is
 * therefore a breaking change to two servers, and adding, renaming, or dropping
 * one has to be a deliberate edit to this file.
 *
 * `apps/web/src/lib/mcp-parity-tools.test.ts` is the other half of that
 * contract, on the hosted side.
 *
 * The tier groupings below are the human layer from
 * `docs/engineering/agent-parity.md`: OUTWARD tools take `confirm: true` and
 * tell the model to ask a person first; TYPED_CONFIRM tools take the target
 * typed out exactly.
 */

/**
 * Tools only the local server has: provisioning a preview workspace, the local
 * project context, and the docs/example corpus. The hosted server has no use
 * for them — it is already inside a chosen workspace, and its docs ride as MCP
 * resources.
 */
export const LOCAL_ONLY_TOOLS = [
  "fillo_provision_workspace",
  "fillo_claim_status",
  "fillo_list_projects",
  "fillo_create_project",
  "fillo_select_project",
  "fillo_docs",
  "fillo_search_examples",
];

/** The build loop, shared with the hosted server. */
export const BUILD_TOOLS = [
  "fillo_whoami",
  "fillo_push_form",
  "fillo_publish_form",
  "fillo_list_forms",
  "fillo_get_form",
  "fillo_search_library",
  "fillo_get_library_form",
  "fillo_list_responses",
  "fillo_get_response",
  "fillo_response_summary",
];

/** Wave 1a — a form's own lifecycle. */
export const FORM_TOOLS = [
  "fillo_pull_form",
  "fillo_rename_form",
  "fillo_duplicate_form",
  "fillo_unpublish_form",
  "fillo_discard_changes",
  "fillo_delete_form",
  "fillo_get_storage",
  "fillo_set_storage",
  "fillo_list_drive_folders",
  "fillo_set_drive_folder",
  "fillo_reset_drive_folder",
  "fillo_get_settings",
  "fillo_update_settings",
  "fillo_list_versions",
];

/** Wave 1b — where a form's answers go. */
export const INTEGRATION_TOOLS = [
  "fillo_get_integration",
  "fillo_enable_integration",
  "fillo_disable_integration",
  "fillo_list_connections",
  "fillo_select_connection",
  "fillo_disconnect_integration",
  "fillo_remove_connection_account",
  "fillo_rename_discord_channel",
  "fillo_hubspot_properties",
  "fillo_hubspot_pipelines",
];

/** Wave 1c — operating what has come in, plus the form's own webhooks. */
export const RESPONSE_TOOLS = [
  "fillo_list_held_responses",
  "fillo_release_responses",
  "fillo_delete_response",
  "fillo_delivery_status",
  "fillo_retry_deliveries",
  "fillo_redeliver_responses",
  "fillo_list_drafts",
  "fillo_form_insights",
  "fillo_list_respondents",
  "fillo_delete_respondent",
  "fillo_list_webhooks",
  "fillo_add_webhook",
  "fillo_update_webhook",
  "fillo_remove_webhook",
];

/** Wave 1d — administering the workspace. */
export const WORKSPACE_TOOLS = [
  "fillo_rename_workspace",
  "fillo_rename_project",
  "fillo_get_branding",
  "fillo_set_branding",
  "fillo_list_members",
  "fillo_invite_member",
  "fillo_change_member_role",
  "fillo_remove_member",
  "fillo_list_tokens",
  "fillo_revoke_token",
  "fillo_list_sync_tokens",
  "fillo_create_sync_token",
  "fillo_revoke_sync_token",
  "fillo_get_code_sync_policy",
  "fillo_set_code_sync_policy",
  "fillo_get_origins",
  "fillo_set_origins",
  "fillo_identity_status",
  "fillo_enable_identity",
  "fillo_disable_identity",
  "fillo_list_agents",
  "fillo_revoke_agent",
  "fillo_list_api_keys",
  "fillo_revoke_api_key",
];

export const ALL_TOOLS = [
  ...LOCAL_ONLY_TOOLS,
  ...BUILD_TOOLS,
  ...FORM_TOOLS,
  ...INTEGRATION_TOOLS,
  ...RESPONSE_TOOLS,
  ...WORKSPACE_TOOLS,
];

/** Every tool the hosted server must also expose, under the same name. */
export const SHARED_WITH_HOSTED = ALL_TOOLS.filter((n) => !LOCAL_ONLY_TOOLS.includes(n));

/**
 * Tier B. Every one takes `confirm: boolean`, refuses without it, and says so
 * in its description. `openWorldHint` is true for exactly this set plus
 * push/publish, because these are the calls whose effect leaves the workspace.
 */
export const OUTWARD_TOOLS = [
  "fillo_unpublish_form",
  "fillo_enable_integration",
  "fillo_add_webhook",
  "fillo_release_responses",
  "fillo_redeliver_responses",
  "fillo_invite_member",
  "fillo_change_member_role",
  "fillo_set_code_sync_policy",
  "fillo_set_origins",
  "fillo_enable_identity",
];

/**
 * Tier C. Every one takes `confirm: string`, and the string is the target named
 * in the second element — the same value the server compares against, so a
 * mismatch 409 quotes something the human can read back.
 */
export const TYPED_CONFIRM_TOOLS = [
  ["fillo_delete_form", "form title"],
  ["fillo_disconnect_integration", "provider name"],
  ["fillo_remove_connection_account", "account label"],
  ["fillo_delete_response", "response id"],
  ["fillo_delete_respondent", "respondent external id"],
  ["fillo_remove_member", "member email"],
  ["fillo_revoke_token", "token id"],
  ["fillo_revoke_sync_token", "sync token id"],
  ["fillo_revoke_agent", "grant id"],
  ["fillo_revoke_api_key", "API key id"],
  ["fillo_disable_identity", "project slug"],
];

/**
 * Tools whose payload carries respondent-authored content and must wrap it.
 * `fillo_delete_respondent` is here because its receipt echoes the external id
 * the respondent's own identify() call supplied — a write can hand back
 * stranger-written text just as a read can.
 */
export const UNTRUSTED_TOOLS = [
  "fillo_list_responses",
  "fillo_list_held_responses",
  "fillo_get_response",
  "fillo_list_drafts",
  "fillo_form_insights",
  "fillo_list_respondents",
  "fillo_delete_respondent",
];

/**
 * Tools that refuse the scoped (`fsk_`) lane before making any request.
 *
 * Most are here because there is no project-API-key route at all: a leaked key
 * must not be able to enumerate or revoke the workspace's credentials, or spend
 * a plan's badge setting. `fillo_delete_response` is here for a different
 * reason — its `fsk_` route deliberately takes no body, so the only thing left
 * to compare the typed `confirm` against would be this tool's own `id`
 * argument. A confirmation a model can satisfy from its own context is not a
 * confirmation, so the lane is refused instead of faked.
 */
export const LOGIN_TOKEN_ONLY_TOOLS = [
  "fillo_delete_form",
  "fillo_delete_response",
  "fillo_get_branding",
  "fillo_set_branding",
  "fillo_list_api_keys",
  "fillo_revoke_api_key",
];
