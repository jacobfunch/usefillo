import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readConfig, resolveAccountToken, writeConfig } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { CREATE, IDEMPOTENT_WRITE, READ_ONLY } from "./annotations.js";

type SelectedProject = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  publishableKey: string;
};

function tokenOrFailure(): string | ReturnType<typeof fail> {
  return (
    resolveAccountToken() ??
    fail(
      "Project management needs an ordinary login token. Run `npx @usefillo/cli login`, then retry.",
    )
  );
}

function saveSelection(project: unknown): SelectedProject | undefined {
  if (!project || typeof project !== "object") return undefined;
  const value = project as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.organizationId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.publishableKey !== "string" ||
    !value.publishableKey.startsWith("pk_")
  ) {
    return undefined;
  }
  const selected: SelectedProject = {
    id: value.id,
    organizationId: value.organizationId,
    name: value.name,
    slug: value.slug,
    publishableKey: value.publishableKey,
  };
  // fsk_ keys and provisional metadata are project-pinned. The workspace login
  // survives because the server retargets only this ordinary CLI credential.
  const { apiKey: _apiKey, provision: _provision, ...current } = readConfig();
  writeConfig({ ...current, activeContext: "account", pk: selected.publishableKey });
  return selected;
}

function environmentWarning(): string {
  const overrides = [
    process.env.FILLO_PK?.trim() ? "FILLO_PK" : undefined,
    process.env.FILLO_API_KEY?.trim() ? "FILLO_API_KEY" : undefined,
  ].filter(Boolean);
  return overrides.length
    ? ` Environment override${overrides.length === 1 ? "" : "s"} ${overrides.join(
        " and ",
      )} still point outside the saved selection; unset or replace them before using form/response tools.`
    : "";
}

export function registerProjects(server: McpServer): void {
  server.registerTool(
    "fillo_list_projects",
    {
      title: "List Fillo projects",
      description:
        "List the isolated sites/apps in the current billing workspace and mark the project " +
        "selected for this local Fillo login. Requires an ordinary human-approved login. " +
        "Project-specific handoffs, API keys, publishable keys, and remote MCP OAuth grants " +
        "cannot enumerate sibling projects.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const token = tokenOrFailure();
      if (typeof token !== "string") return token;
      const res = await filloFetch("/api/v1/cli/projects", { token });
      if (!res.ok || !Array.isArray(res.json?.projects)) {
        return fail(apiErrorMessage(res, "Couldn't list projects"));
      }
      return ok(
        res.json.projects.length
          ? `${res.json.projects.length} project${res.json.projects.length === 1 ? "" : "s"}; the current one is marked in the data.`
          : "No projects found in this workspace.",
        { projects: res.json.projects },
      );
    },
  );

  server.registerTool(
    "fillo_create_project",
    {
      title: "Create and select a Fillo project",
      description:
        "Create an isolated site/app under the current workspace, select it for this local " +
        "login, and save its publishable key. Forms, keys, origins, respondent identities, and " +
        "agent authority are project-specific; members, billing, storage, and usage totals remain " +
        "workspace-wide. Requires an ordinary `fillo login`.",
      inputSchema: { name: z.string().min(1).max(80).describe("Human-readable project name") },
      annotations: CREATE,
    },
    async ({ name }) => {
      const token = tokenOrFailure();
      if (typeof token !== "string") return token;
      const res = await filloFetch("/api/v1/cli/projects", {
        method: "POST",
        token,
        body: { name, source: "mcp" },
      });
      if (!res.ok || res.json?.selected !== true) {
        return fail(apiErrorMessage(res, "Couldn't create a project"));
      }
      const project = saveSelection(res.json?.project);
      if (!project) return fail("Fillo returned an invalid created project.");
      return ok(
        `Created and selected ${project.name}. Future local Fillo tools use this project.${environmentWarning()}`,
        { project, selected: true },
      );
    },
  );

  server.registerTool(
    "fillo_select_project",
    {
      title: "Select a Fillo project",
      description:
        "Select an existing project in the current workspace by id, slug, or unique exact name. " +
        "Updates this ordinary login and saves the project's publishable key locally. Cached API " +
        "key and preview state are cleared because they belong to the previous project. " +
        "Project-pinned handoffs and remote MCP grants cannot use this tool.",
      inputSchema: {
        project: z
          .string()
          .min(1)
          .describe("Project id, slug, or unique exact name from fillo_list_projects"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ project: target }) => {
      const token = tokenOrFailure();
      if (typeof token !== "string") return token;
      const res = await filloFetch("/api/v1/cli/projects/select", {
        method: "POST",
        token,
        body: { project: target, source: "mcp" },
      });
      if (!res.ok || res.json?.selected !== true) {
        return fail(apiErrorMessage(res, "Couldn't select a project"));
      }
      const project = saveSelection(res.json?.project);
      if (!project) return fail("Fillo returned an invalid selected project.");
      return ok(
        `Selected ${project.name}. Future local Fillo tools use this project.${environmentWarning()}`,
        { project, selected: true },
      );
    },
  );
}
