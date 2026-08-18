import { api, readJson, requireToken } from "../lib/api.js";
import { readConfig, writeConfig } from "../lib/config.js";
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
  printTable,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

type Project = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  current: boolean;
};

type SelectedProject = Omit<Project, "current"> & { publishableKey: string };

function authFailure(status: number): void {
  if (status === 401) die("Token invalid — run `fillo login` again.");
}

function saveSelectedProject(project: SelectedProject): void {
  if (!project.publishableKey.startsWith("pk_")) {
    die("Fillo returned an invalid publishable key; the selected project was not saved locally.");
  }
  // Preview claim metadata belongs to the earlier provisional project. Keep
  // the workspace login, replace the public key, and retire stale claim state.
  const {
    claimUrl: _claimUrl,
    email: _email,
    name: _name,
    claimToken: _claimToken,
    ...current
  } = readConfig();
  writeConfig({ ...current, pk: project.publishableKey });
}

async function list(flags: Flags) {
  const res = await api("/cli/projects", { token: requireToken() });
  const body = (await readJson(res)) as { projects?: Project[]; error?: string };
  authFailure(res.status);
  if (!res.ok || !Array.isArray(body.projects)) {
    die(body.error ?? `project list failed (${res.status}).`);
  }
  if (jsonMode(flags)) return emitResult(body);
  console.log(`\n  ${bold("Projects")}`);
  printTable(
    ["", "NAME", "SLUG", "ID"],
    body.projects.map((project) => [
      project.current ? "*" : "",
      terminalText(project.name),
      terminalText(project.slug),
      terminalText(project.id),
    ]),
  );
  console.log(`\n  ${dim("* selected for this CLI login")}`);
  console.log(`  ${dim("Switch with `fillo project select <id-or-slug>`.")}\n`);
}

async function create(name: string | undefined, flags: Flags) {
  if (!name) die('Usage: fillo project create "Project name"');
  const res = await api("/cli/projects", {
    method: "POST",
    token: requireToken(),
    body: JSON.stringify({ name, source: "cli" }),
  });
  const body = (await readJson(res)) as {
    project?: SelectedProject;
    selected?: boolean;
    error?: string;
  };
  authFailure(res.status);
  if (!res.ok || !body.project || body.selected !== true) {
    die(body.error ?? `project create failed (${res.status}).`);
  }
  saveSelectedProject(body.project);
  if (jsonMode(flags)) return emitResult(body);
  console.log(`  ${okMark()} Created and selected ${bold(terminalText(body.project.name))}.`);
  console.log(`  ${dim("Forms, keys, origins, identities, and agent access are isolated here.")}`);
  console.log(`  ${dim("Members, billing, storage, and usage totals stay with the workspace.")}`);
}

async function select(target: string | undefined, flags: Flags) {
  if (!target) die("Usage: fillo project select <id|slug|unique-name>");
  const res = await api("/cli/projects/select", {
    method: "POST",
    token: requireToken(),
    body: JSON.stringify({ project: target, source: "cli" }),
  });
  const body = (await readJson(res)) as {
    project?: SelectedProject;
    selected?: boolean;
    error?: string;
  };
  authFailure(res.status);
  if (!res.ok || !body.project || body.selected !== true) {
    die(body.error ?? `project select failed (${res.status}).`);
  }
  saveSelectedProject(body.project);
  if (jsonMode(flags)) return emitResult(body);
  console.log(`  ${okMark()} Selected ${bold(terminalText(body.project.name))}.`);
  console.log(`  ${dim("Future CLI commands use this project until you select another.")}`);
}

async function projects(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "list" || subcommand === "ls") {
    return list(flags);
  }
  if (subcommand === "help") return projectHelp();
  if (subcommand === "create") return create(args.join(" ").trim() || undefined, flags);
  if (subcommand === "select" || subcommand === "use") {
    return select(args.join(" ").trim() || undefined, flags);
  }
  die(`Unknown project command: ${terminalText(subcommand)} (expected list, create, or select).`);
}

function projectHelp() {
  console.log(`
  ${boldRaw("fillo project")} — create and select isolated sites/apps

  ${boldRaw("Commands")}
    project                         List projects in the current workspace
    project create <name>           Create and select a project
    project select <id|slug|name>   Select a project for future commands

  ${dimRaw("Requires an ordinary `fillo login`. Project-pinned agent handoff")}
  ${dimRaw("tokens cannot list, create, or select sibling projects.")}
  ${dimRaw("--json prints the server response on stdout.")}
`);
}

export const projectCommand: Command = {
  name: "project",
  aliases: ["projects"],
  flags: [],
  run: (args, flags) => projects(args[0], args.slice(1), flags),
  help: projectHelp,
};
