import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Behavior hints for the local Fillo tools, mirroring the remote MCP server's
 * annotations (apps/web/src/lib/mcp/tools.ts) so a client can tell reads
 * (fillo_docs, fillo_list_forms) from writes (fillo_push_form,
 * fillo_publish_form, fillo_provision_workspace, fillo_create_project) without
 * calling them. Most
 * tools stay inside the private Fillo workspace, so openWorldHint is false;
 * publishing is the exception because it makes the hosted form publicly live.
 */

/** Pure read: no state change, safe to repeat. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** An idempotent write that can replace existing draft/configuration state. */
export const IDEMPOTENT_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Tier B: an idempotent write whose effect is visible OUTSIDE the workspace — a
 * form going live, a third-party destination starting to receive answers, held
 * responses going out, a person's access changing.
 */
export const OUTWARD_WRITE: ToolAnnotations = {
  ...IDEMPOTENT_WRITE,
  openWorldHint: true,
};

/**
 * Tier A: a non-idempotent create — each call provisions a fresh workspace or
 * project, or mints a credential that did not exist and is returned exactly
 * once. Not destructive (nothing is replaced) and not idempotent (calling it
 * again makes another one).
 */
export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Tier C: an irreversible removal or revocation. Not idempotent — the second
 * call answers "not found" rather than repeating the first one's effect — and
 * `openWorldHint` stays false because what it destroys is workspace state, even
 * when the credential it kills was used elsewhere.
 */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
