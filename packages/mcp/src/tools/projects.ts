import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiOrigin, readConfig, resolveAccountToken, writeConfig } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok, plural } from "../result.js";

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
  const {
    apiKey: _apiKey,
    apiKeyApi: _apiKeyApi,
    provision: _provision,
    claimToken: _claimToken,
    claimUrl: _claimUrl,
    email: _email,
    name: _name,
    preview: _preview,
    ...current
  } = readConfig();
  writeConfig({
    ...current,
    activeContext: "account",
    pk: selected.publishableKey,
    pkApi: apiOrigin(),
  });
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
      title: localCapability("fillo_list_projects").title,
      description: localCapability("fillo_list_projects").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_projects").annotations,
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
          ? `${plural(res.json.projects.length, "project")}; the current one is marked in the data.`
          : "No projects found in this workspace.",
        { projects: res.json.projects },
      );
    },
  );

  server.registerTool(
    "fillo_create_project",
    {
      title: localCapability("fillo_create_project").title,
      description: localCapability("fillo_create_project").description,
      inputSchema: { name: z.string().min(1).max(80).describe("Human-readable project name") },
      annotations: localCapability("fillo_create_project").annotations,
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
      title: localCapability("fillo_select_project").title,
      description: localCapability("fillo_select_project").description,
      inputSchema: {
        project: z
          .string()
          .min(1)
          .describe("Project id, slug, or unique exact name from fillo_list_projects"),
      },
      annotations: localCapability("fillo_select_project").annotations,
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
