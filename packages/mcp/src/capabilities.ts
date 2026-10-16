import catalog from "./capabilities.json";
import { rankCapabilities } from "./search.mjs";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type McpToolset = "all" | "build" | "responses" | "integrations" | "admin" | "discovery";
export const MCP_TOOLSETS = catalog.toolsets as readonly McpToolset[];
export type TaskToolset = Exclude<McpToolset, "all" | "discovery">;

export interface LocalCapability {
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

const byName = new Map(catalog.capabilities.map((capability) => [capability.name, capability]));

/** The catalogue is bundled into both public bins. Native Zod validators retain
 * transformations and inference; execution tests check their wire schemas
 * against this reviewed contract. Hosted declarations use these schemas. */
export function localCapability(name: string): LocalCapability {
  const capability = byName.get(name)?.local;
  if (!capability) throw new Error(`Unknown local capability: ${name}`);
  return capability as LocalCapability;
}

export function inToolset(name: string, toolset: McpToolset): boolean {
  return (
    toolset === "all" || toolset === "discovery" || !!byName.get(name)?.toolsets.includes(toolset)
  );
}

export function parseToolset(value: string | undefined): McpToolset {
  const toolset = value?.trim() || "all";
  if (MCP_TOOLSETS.some((candidate) => candidate === toolset)) return toolset as McpToolset;
  throw new Error(`Invalid FILLO_MCP_TOOLSET. Choose: ${MCP_TOOLSETS.join(", ")}.`);
}

export function searchCapabilities(query: string, limit = 10) {
  return rankCapabilities(
    catalog.capabilities.filter((capability) => capability.local),
    query,
    (capability) => ({
      name: capability.name,
      title: capability.local!.title,
      description: capability.local!.description,
      tags: capability.toolsets,
    }),
    limit,
  ).map((capability) => ({
    name: capability.name,
    title: capability.local!.title,
    toolsets: capability.toolsets,
    annotations: capability.local!.annotations,
  }));
}
