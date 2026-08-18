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

/** An idempotent write that changes publicly visible state. */
export const PUBLIC_IDEMPOTENT_WRITE: ToolAnnotations = {
  ...IDEMPOTENT_WRITE,
  openWorldHint: true,
};

/** A non-idempotent create — each call provisions a fresh workspace. */
export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
