import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerClaimStatus } from "./claim-status.js";
import { registerDocs } from "./docs.js";
import { registerGetForm } from "./get-form.js";
import { registerGetResponse } from "./get-response.js";
import { registerListForms } from "./list-forms.js";
import { registerListResponses } from "./list-responses.js";
import { registerProjects } from "./projects.js";
import { registerProvisionWorkspace } from "./provision.js";
import { registerPublishForm } from "./publish-form.js";
import { registerPushForm } from "./push-form.js";
import { registerResponseSummary } from "./response-summary.js";
import { registerSearchExamples } from "./search-examples.js";
import { registerWhoami } from "./whoami.js";

/** Register all fifteen Fillo tools on the server. */
export function registerTools(server: McpServer): void {
  registerProvisionWorkspace(server);
  registerWhoami(server);
  registerProjects(server);
  registerPushForm(server);
  registerPublishForm(server);
  registerListForms(server);
  registerGetForm(server);
  registerSearchExamples(server);
  registerDocs(server);
  registerListResponses(server);
  registerGetResponse(server);
  registerResponseSummary(server);
  registerClaimStatus(server);
}
