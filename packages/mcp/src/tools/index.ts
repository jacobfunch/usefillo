import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerClaimStatus } from "./claim-status.js";
import { registerDocs } from "./docs.js";
import { registerFormLifecycle } from "./form-lifecycle.js";
import { registerGetForm } from "./get-form.js";
import { registerGetResponse } from "./get-response.js";
import { registerIntegrations } from "./integrations.js";
import { registerLibrary } from "./library.js";
import { registerListForms } from "./list-forms.js";
import { registerListResponses } from "./list-responses.js";
import { registerProjects } from "./projects.js";
import { registerProvisionWorkspace } from "./provision.js";
import { registerPublishForm } from "./publish-form.js";
import { registerPushForm } from "./push-form.js";
import { registerResponseSummary } from "./response-summary.js";
import { registerResponseOps } from "./responses-ops.js";
import { registerSearchExamples } from "./search-examples.js";
import { registerWebhooks } from "./webhooks.js";
import { registerWhoami } from "./whoami.js";
import { registerWorkspaceAdmin } from "./workspace.js";

export { MCP_TOOLSETS, parseToolset } from "../capabilities.js";
import { inToolset, type McpToolset } from "../capabilities.js";

/**
 * Copy each tool's `title` into its annotations as it registers. Connector
 * directory reviews check `annotations.title` alongside the hint flags, and
 * this keeps the two titles from drifting across dozens of registrations.
 */
function withTitleAnnotations(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: Record<string, unknown>, ...rest: unknown[]) => {
    const annotations = config.annotations as Record<string, unknown> | undefined;
    const title = typeof config.title === "string" ? config.title : undefined;
    return register(
      name,
      title && annotations ? { ...config, annotations: { title, ...annotations } } : config,
      ...rest,
    );
  }) as McpServer["registerTool"];
}

/**
 * Register all Fillo tools on the server.
 *
 * The first group is the build loop — provision, scaffold, push, publish, read
 * back. The management groups below it mirror, one tool per capability, what a
 * workspace member can do in the dashboard: they call the same `/api/v1/cli`
 * and `/api/v1/manage` routes the Fillo CLI does, so authorization, validation,
 * and the human-approval tiers all stay server-side.
 */
export function registerTools(server: McpServer, toolset: McpToolset = "all"): void {
  withTitleAnnotations(server);
  const register = server.registerTool.bind(server);
  server.registerTool = ((name, config, cb) => {
    const tool = register(name, config, cb);
    if (!inToolset(name, toolset)) tool.disable();
    return tool;
  }) as McpServer["registerTool"];
  registerProvisionWorkspace(server);
  registerWhoami(server);
  registerProjects(server);
  registerPushForm(server);
  registerPublishForm(server);
  registerListForms(server);
  registerGetForm(server);
  registerSearchExamples(server);
  registerLibrary(server);
  registerDocs(server);
  registerListResponses(server);
  registerGetResponse(server);
  registerResponseSummary(server);
  registerClaimStatus(server);

  registerFormLifecycle(server);
  registerIntegrations(server);
  registerResponseOps(server);
  registerWebhooks(server);
  registerWorkspaceAdmin(server);
}
