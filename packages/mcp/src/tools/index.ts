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
import { registerResponseOps } from "./responses-ops.js";
import { registerResponseSummary } from "./response-summary.js";
import { registerSearchExamples } from "./search-examples.js";
import { registerWebhooks } from "./webhooks.js";
import { registerWhoami } from "./whoami.js";
import { registerWorkspaceAdmin } from "./workspace.js";

/**
 * Register all Fillo tools on the server.
 *
 * The first group is the build loop — provision, scaffold, push, publish, read
 * back. The management groups below it mirror, one tool per capability, what a
 * workspace member can do in the dashboard: they call the same `/api/v1/cli`
 * and `/api/v1/manage` routes the Fillo CLI does, so authorization, validation,
 * and the human-approval tiers all stay server-side.
 */
export function registerTools(server: McpServer): void {
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
