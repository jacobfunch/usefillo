import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBundlesEqual, bundledSkillRoot } from "./skill-bundle.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const marker = ".fillo-managed.json";

function project() {
  const root = mkdtempSync(join(tmpdir(), "fillo-skill-install-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function install(root, agent, ...args) {
  const command = [cli, "skill", "install"];
  if (agent) command.push("--agent", agent);
  command.push(...args);
  return spawnSync(process.execPath, command, {
    cwd: root,
    encoding: "utf8",
  });
}

function installGlobal(home, agent, ...extraArgs) {
  const args = [cli, "skill", "install", "--global"];
  if (agent) args.push("--agent", agent);
  args.push(...extraArgs);
  return spawnSync(process.execPath, args, {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
    },
  });
}

const providerCases = [
  ["shared", ".agents"],
  ["agents", ".agents"],
  ["universal", ".agents"],
  ["codex", ".agents"],
  ["claude", ".claude"],
  ["claude-code", ".claude"],
  ["cursor", ".agents"],
  ["copilot", ".agents"],
  ["github-copilot", ".agents"],
  ["gemini", ".agents"],
  ["gemini-cli", ".agents"],
  ["opencode", ".agents"],
];
const providerProjects = providerCases.map(([agent, directory]) => ({
  agent,
  directory,
  root: project(),
}));
const globalCases = [
  { agent: undefined, directories: [".agents", ".claude"], label: "default global" },
  { agent: "claude", directories: [".claude"], label: "Claude global" },
].map((entry) => ({
  ...entry,
  home: mkdtempSync(join(tmpdir(), "fillo-skill-global-")),
}));
const managedProject = project();
const customProject = project();
const customDirectoryProject = project();
const customGlobalHome = mkdtempSync(join(tmpdir(), "fillo-skill-custom-global-"));

try {
  for (const { agent, directory, root } of providerProjects) {
    const result = install(root, agent);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const target = join(root, directory, "skills", "build-with-fillo");
    assert.equal(JSON.parse(readFileSync(join(target, marker), "utf8")).managedBy, "@usefillo/cli");
    assertBundlesEqual(bundledSkillRoot, target, `${agent} installed skill`);
  }

  for (const { agent, directories, home, label } of globalCases) {
    const result = installGlobal(home, agent);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const directory of directories) {
      const target = join(home, directory, "skills", "build-with-fillo");
      assert.equal(
        JSON.parse(readFileSync(join(target, marker), "utf8")).managedBy,
        "@usefillo/cli",
      );
      assertBundlesEqual(bundledSkillRoot, target, `${label} installed skill`);
    }
  }

  const help = spawnSync(process.execPath, [cli, "skill", "help"], {
    cwd: managedProject,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /--agent <shared\|claude>/);
  assert.match(help.stdout, /--dir <path>/);

  const invalidAgent = install(managedProject, "invalid");
  assert.notEqual(invalidAgent.status, 0);
  assert.match(
    `${invalidAgent.stdout}\n${invalidAgent.stderr}`,
    /Use --agent shared, --agent claude, or --dir/,
  );

  const customDirectory = install(customDirectoryProject, undefined, "--dir", ".windsurf/skills");
  assert.equal(customDirectory.status, 0, customDirectory.stderr || customDirectory.stdout);
  assertBundlesEqual(
    bundledSkillRoot,
    join(customDirectoryProject, ".windsurf", "skills", "build-with-fillo"),
    "custom-directory installed skill",
  );
  assert.match(customDirectory.stdout, /SKILL\.md/);

  const customGlobal = installGlobal(customGlobalHome, undefined, "--dir", ".windsurf/skills");
  assert.equal(customGlobal.status, 0, customGlobal.stderr || customGlobal.stdout);
  assertBundlesEqual(
    bundledSkillRoot,
    join(customGlobalHome, ".windsurf", "skills", "build-with-fillo"),
    "custom global-directory installed skill",
  );

  const conflictingDestination = install(
    customDirectoryProject,
    "shared",
    "--dir",
    ".windsurf/skills",
  );
  assert.notEqual(conflictingDestination.status, 0);
  assert.match(
    `${conflictingDestination.stdout}\n${conflictingDestination.stderr}`,
    /Choose either --agent or --dir/,
  );

  for (const unsafeDirectory of ["../skills", join(customDirectoryProject, "skills")]) {
    const unsafe = install(customDirectoryProject, undefined, "--dir", unsafeDirectory);
    assert.notEqual(unsafe.status, 0);
    assert.match(`${unsafe.stdout}\n${unsafe.stderr}`, /--dir must|must stay inside/);
  }

  const first = install(managedProject);
  assert.equal(first.status, 0, first.stderr);
  const managedTarget = join(managedProject, ".agents", "skills", "build-with-fillo");
  assert.equal(
    JSON.parse(readFileSync(join(managedTarget, marker), "utf8")).managedBy,
    "@usefillo/cli",
  );
  assertBundlesEqual(bundledSkillRoot, managedTarget, "freshly installed skill");
  assertBundlesEqual(
    bundledSkillRoot,
    join(managedProject, ".claude", "skills", "build-with-fillo"),
    "freshly installed Claude skill",
  );

  // Simulate an older official bundle: content differs, but the installer-owned
  // provenance remains. A normal install must update it without --force.
  writeFileSync(join(managedTarget, "SKILL.md"), "old official bundle\n");
  const update = install(managedProject);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /Updated/);
  assert.doesNotMatch(readFileSync(join(managedTarget, "SKILL.md"), "utf8"), /old official/);
  assertBundlesEqual(bundledSkillRoot, managedTarget, "updated installed skill");

  const customTarget = join(customProject, ".agents", "skills", "build-with-fillo");
  mkdirSync(customTarget, { recursive: true });
  writeFileSync(join(customTarget, "SKILL.md"), "user-authored skill\n");
  const collision = install(customProject);
  assert.notEqual(collision.status, 0);
  assert.match(`${collision.stdout}\n${collision.stderr}`, /different skill already exists/);
  assert.equal(readFileSync(join(customTarget, "SKILL.md"), "utf8"), "user-authored skill\n");
  assert.equal(
    existsSync(join(customProject, ".claude")),
    false,
    "a collision must be detected before the second destination is written",
  );

  console.log("skill installer provider, global, update, and collision checks passed");
} finally {
  for (const { root } of providerProjects) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const { home } of globalCases) {
    rmSync(home, { recursive: true, force: true });
  }
  rmSync(managedProject, { recursive: true, force: true });
  rmSync(customProject, { recursive: true, force: true });
  rmSync(customDirectoryProject, { recursive: true, force: true });
  rmSync(customGlobalHome, { recursive: true, force: true });
}
