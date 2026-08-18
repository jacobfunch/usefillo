import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Flags, flagString } from "../lib/flags.js";
import { bold, boldRaw, die, dim, dimRaw, okMark } from "../lib/output.js";
import type { Command } from "../lib/registry.js";

const BUNDLED_SKILL_DIR = fileURLToPath(new URL("./skill/build-with-fillo", import.meta.url));

const SKILL_AGENT_DIRECTORIES = {
  shared: ".agents/skills",
  universal: ".agents/skills",
  agents: ".agents/skills",
  codex: ".agents/skills",
  cursor: ".agents/skills",
  copilot: ".agents/skills",
  "github-copilot": ".agents/skills",
  gemini: ".agents/skills",
  "gemini-cli": ".agents/skills",
  amp: ".agents/skills",
  cline: ".agents/skills",
  opencode: ".agents/skills",
  warp: ".agents/skills",
  claude: ".claude/skills",
  "claude-code": ".claude/skills",
} as const;

type SkillAgent = keyof typeof SKILL_AGENT_DIRECTORIES;

function isSkillAgent(value: string): value is SkillAgent {
  return Object.prototype.hasOwnProperty.call(SKILL_AGENT_DIRECTORIES, value);
}

function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function parseSkillDirectories(flags: Flags): string[] {
  const agent = flagString(flags, "agent");
  const customDirectory = flagString(flags, "dir");
  if (agent && customDirectory) die("Choose either --agent or --dir, not both.");

  if (customDirectory) {
    if (isAbsolute(customDirectory)) {
      die("--dir must be relative to the project root, or to your home directory with --global.");
    }
    const parts = customDirectory.split(/[\\/]+/).filter((part) => part && part !== ".");
    if (parts.length === 0 || parts.some((part) => part === "..")) {
      die("--dir must name a skill directory inside the selected project or home scope.");
    }
    return [join(...parts)];
  }

  if (!agent) return [SKILL_AGENT_DIRECTORIES.shared, SKILL_AGENT_DIRECTORIES.claude];
  if (isSkillAgent(agent)) return [SKILL_AGENT_DIRECTORIES[agent]];
  die(
    `Unknown agent ${agent}. Use --agent shared, --agent claude, or --dir <agent-skill-directory>.`,
  );
}

function skillFiles(root: string, relative = ""): string[] {
  const directory = join(root, relative);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const next = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...skillFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

function sameSkillBundle(source: string, target: string): boolean {
  try {
    const sourceFiles = skillFiles(source);
    const targetFiles = skillFiles(target);
    if (sourceFiles.length !== targetFiles.length) return false;
    return sourceFiles.every(
      (file, index) =>
        file === targetFiles[index] &&
        readFileSync(join(source, file)).equals(readFileSync(join(target, file))),
    );
  } catch {
    return false;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const MANAGED_SKILL_MARKER = ".fillo-managed.json";

function isCliManagedFilloSkill(target: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(target, MANAGED_SKILL_MARKER), "utf8")) as Record<
      string,
      unknown
    >;
    return (
      marker.managedBy === "@usefillo/cli" &&
      marker.skill === "build-with-fillo" &&
      marker.format === 1 &&
      marker.allowAutomaticUpdates === true
    );
  } catch {
    return false;
  }
}

function assertSafeSkillDestination(scopeRoot: string, parts: string[]) {
  const realScopeRoot = realpathSync(scopeRoot);
  let current = scopeRoot;
  for (const part of parts) {
    current = join(current, part);
    if (!pathEntryExists(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to install through symlinked path ${current}.`);
    }
    const resolved = realpathSync(current);
    const fromScope = relative(realScopeRoot, resolved);
    if (fromScope === ".." || fromScope.startsWith(`..${sep}`) || isAbsolute(fromScope)) {
      throw new Error(`Refusing to install outside ${scopeRoot}.`);
    }
  }
}

function moveSkillIntoPlace(staging: string, target: string) {
  if (!pathEntryExists(target)) {
    renameSync(staging, target);
    return;
  }

  const backup = `${target}.backup-${randomUUID()}`;
  renameSync(target, backup);
  try {
    renameSync(staging, target);
  } catch (error) {
    try {
      renameSync(backup, target);
    } catch {
      throw new Error(`Skill install failed. The previous copy is preserved at ${backup}.`);
    }
    throw error;
  }

  try {
    rmSync(backup, { recursive: true, force: true });
  } catch {
    console.warn(`  ${dim(`Previous skill copy could not be removed: ${backup}`)}`);
  }
}

export function installSkill(flags: Flags, opts: { quiet?: boolean } = {}): string[] {
  if (flags.global === true && flags.project === true) {
    die("Choose either --project or --global, not both.");
  }

  const skillDirectories = parseSkillDirectories(flags);
  const global = flags.global === true;
  const scopeRoot = global ? homedir() : findProjectRoot(process.cwd());

  if (!existsSync(BUNDLED_SKILL_DIR)) {
    die("This CLI package is missing its bundled Fillo skill. Reinstall @usefillo/cli@latest.");
  }

  const destinations = Array.from(new Set(skillDirectories)).map((skillDirectory) => {
    const skillsRoot = resolve(scopeRoot, skillDirectory);
    const target = join(skillsRoot, "build-with-fillo");
    const relativeSkillsRoot = relative(scopeRoot, skillsRoot);
    if (
      relativeSkillsRoot === ".." ||
      relativeSkillsRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeSkillsRoot)
    ) {
      die("The skill destination must stay inside the selected project or home scope.");
    }
    const destinationParts = [...relativeSkillsRoot.split(sep).filter(Boolean), "build-with-fillo"];
    assertSafeSkillDestination(scopeRoot, destinationParts);
    const targetExists = pathEntryExists(target);
    const current = targetExists && sameSkillBundle(BUNDLED_SKILL_DIR, target);
    const updatingManagedSkill = targetExists && isCliManagedFilloSkill(target);
    if (targetExists && !current && !updatingManagedSkill && flags.force !== true) {
      die(`A different skill already exists at ${target}. Re-run with --force to replace it.`);
    }
    return {
      skillsRoot,
      target,
      destinationParts,
      targetExists,
      current,
      updatingManagedSkill,
    };
  });

  for (const destination of destinations) {
    if (destination.current) continue;
    mkdirSync(destination.skillsRoot, { recursive: true });
    assertSafeSkillDestination(scopeRoot, destination.destinationParts.slice(0, 2));
    const staging = join(destination.skillsRoot, `.build-with-fillo.install-${randomUUID()}`);
    try {
      cpSync(BUNDLED_SKILL_DIR, staging, { recursive: true, errorOnExist: true });
      assertSafeSkillDestination(scopeRoot, destination.destinationParts);
      if (!destination.targetExists && pathEntryExists(destination.target)) {
        throw new Error(`Skill destination changed during install: ${destination.target}`);
      }
      moveSkillIntoPlace(staging, destination.target);
    } finally {
      if (pathEntryExists(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }

  const changed = destinations.filter((destination) => !destination.current);
  const action =
    changed.length === 0
      ? "Fillo skill is already installed"
      : changed.every((destination) => destination.updatingManagedSkill)
        ? `Updated ${bold("Build with Fillo")}`
        : `Installed ${bold("Build with Fillo")}`;
  const targets = destinations.map((destination) => destination.target);
  // Quiet mode: the caller (agent bootstrap --json) prints its own single
  // result; skip the human lines but still return where it landed.
  if (opts.quiet) return targets;
  console.log(`\n  ${okMark()} ${action}.`);
  for (const target of targets) console.log(`  ${dim(target)}`);
  if (targets.length > 1) {
    console.log(
      `  ${dim("Same bundle in both — cross-agent compatibility, not duplication (want one folder? --agent <name> or --dir <path>).")}`,
    );
  }
  console.log(`\n  Ask your agent to use ${bold("build-with-fillo")}.`);
  console.log(
    `  ${dim(`If it does not discover skills, point it to ${join(targets[0]!, "SKILL.md")}.`)}\n`,
  );
  return targets;
}

function skill(subcommand: string | undefined, flags: Flags) {
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return skillHelp();
  }
  if (subcommand === "install") {
    installSkill(flags);
    return;
  }
  die(`Unknown skill command: ${subcommand}`);
}

function skillHelp() {
  console.log(`
  ${boldRaw("fillo skill")} — install the Build with Fillo Agent Skill

  ${boldRaw("Commands")}
    skill install       Install into this project (default)
                       ${dimRaw("--agent <shared|claude>   choose a standard destination")}
                       ${dimRaw("--dir <path>              install into any agent's skill directory")}
                       ${dimRaw("--global   install for the current user")}
                       ${dimRaw("--force    replace a different existing copy")}

  ${dimRaw("Default: open Agent Skills path (.agents/skills) plus Claude Code (.claude/skills) —")}
  ${dimRaw("the same bundle in both, so either agent convention discovers it.")}
`);
}

export const skillCommand: Command = {
  name: "skill",
  flags: ["agent", "dir", "global", "project", "force"],
  run: (args, flags) => skill(args[0], flags),
  help: skillHelp,
};
