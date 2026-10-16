import { callApi, failed } from "../lib/api.js";
import type { Flags } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo workspace rename` — and the shared implementation behind
 * `fillo project rename`, which is wired into the `project` command family.
 *
 * Both are Tier A in the human layer (docs/engineering/agent-parity.md): a
 * rename is contained and reversible, and it changes no id, no publishable key,
 * and no public form URL. So neither asks for confirmation — an agent renames
 * directly, exactly like a human clicking Settings.
 */

type RenamedWorkspace = { id: string; name: string };
type RenamedProject = { id: string; name: string; slug: string };

async function renameWorkspace(args: string[], flags: Flags) {
  const name = args.join(" ").trim();
  if (!name) die('Usage: fillo workspace rename "New name"');
  const body = await callApi<{ workspace: RenamedWorkspace }>(
    "/cli/workspace",
    { method: "PATCH", body: JSON.stringify({ name }) },
    {
      fallback: failed("workspace rename"),
      expect: (b) => Boolean(b.workspace),
    },
  );
  if (jsonMode(flags)) return emitResult(body);
  console.log(`  ${okMark()} Renamed the workspace to ${bold(terminalText(body.workspace.name))}.`);
  console.log(`  ${dim("Form URLs, keys, and member access are unchanged.")}`);
}

/**
 * `fillo project rename [<project>] <name>`. One argument renames the selected
 * project; two or more read the first as the project (id, slug, or unique name)
 * and the rest as the new name — so a multi-word name that follows a selector
 * must be quoted.
 */
export async function renameProject(args: string[], flags: Flags) {
  const [first, ...rest] = args;
  const project = rest.length > 0 ? first : undefined;
  const name = (rest.length > 0 ? rest.join(" ") : (first ?? "")).trim();
  if (!name) {
    die('Usage: fillo project rename "New name"  ·  fillo project rename <id|slug> "New name"');
  }
  const body = await callApi<{ project: RenamedProject }>(
    "/cli/project",
    { method: "PATCH", body: JSON.stringify({ name, ...(project ? { project } : {}) }) },
    {
      fallback: failed("project rename"),
      expect: (b) => Boolean(b.project),
      on: (res, b) => {
        if (res.status === 404) {
          die(
            b.error ??
              "No project in this workspace matches that value. Run `fillo project` to see them.",
          );
        }
      },
    },
  );
  if (jsonMode(flags)) return emitResult(body);
  console.log(`  ${okMark()} Renamed the project to ${bold(terminalText(body.project.name))}.`);
  console.log(`  ${dim("The project id, publishable key, and form URLs are unchanged.")}`);
}

async function workspace(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return workspaceHelp();
  if (subcommand === "rename") return renameWorkspace(args, flags);
  die(`Unknown workspace command: ${terminalText(subcommand)} (expected rename).`);
}

function workspaceHelp() {
  console.log(`
  ${boldRaw("fillo workspace")} — the billing workspace itself

  ${boldRaw("Commands")}
    workspace rename <name>   Rename the workspace (quote a multi-word name)

  ${dimRaw("A rename changes nothing else: ids, keys, member access, and every live")}
  ${dimRaw("form URL stay exactly as they are. To schedule the workspace for deletion")}
  ${dimRaw("use `fillo delete workspace`, and for the badge `fillo branding`.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const workspaceCommand: Command = {
  name: "workspace",
  flags: [],
  run: (args, flags) => workspace(args[0], args.slice(1), flags),
  help: workspaceHelp,
};
