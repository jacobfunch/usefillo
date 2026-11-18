import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBundlesEqual, bundledSkillRoot } from "./skill-bundle.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const marker = ".fillo-managed.json";
// Automatic updates run from a shipping-shaped package, not the checkout.
const shippedRoot = mkdtempSync(join(tmpdir(), "fillo-shipped-skill-"));
cpSync(join(packageRoot, "dist"), join(shippedRoot, "dist"), { recursive: true });
cpSync(join(packageRoot, "package.json"), join(shippedRoot, "package.json"));
const shippedCli = join(shippedRoot, "dist/index.js");

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
    env: { ...process.env, HOME: root, USERPROFILE: root, FILLO_AUTO_UPDATE: "0" },
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
      FILLO_AUTO_UPDATE: "0",
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

  const refresh = (root, home = root, extraEnv = {}) =>
    spawnSync(
      process.execPath,
      [extraEnv.CHECKOUT ? cli : shippedCli, "commands", "search", "forms", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CI: "",
          FILLO_AUTO_UPDATE: "1",
          FILLO_RUNTIME_UPDATED: "1",
          ...extraEnv,
        },
      },
    );
  // A normal read command updates managed copies quietly, including recorded
  // custom/global destinations. Missing and user-owned copies stay untouched.
  writeFileSync(join(managedTarget, "SKILL.md"), "older managed skill\n");
  rmSync(join(managedProject, ".claude/skills/build-with-fillo"), { recursive: true });
  const development = refresh(managedProject, managedProject, { CHECKOUT: "1" });
  assert.equal(development.status, 0, development.stderr);
  assert.equal(
    readFileSync(join(managedTarget, "SKILL.md"), "utf8"),
    "older managed skill\n",
    "a checkout cannot refresh customer skills implicitly",
  );
  const automatic = refresh(managedProject);
  assert.equal(automatic.status, 0, automatic.stderr);
  JSON.parse(automatic.stdout);
  assertBundlesEqual(bundledSkillRoot, managedTarget, "automatically refreshed skill");
  assert.equal(existsSync(join(managedProject, ".claude/skills/build-with-fillo")), false);

  const customDirectoryTarget = join(customDirectoryProject, ".windsurf/skills/build-with-fillo");
  writeFileSync(join(customDirectoryTarget, "SKILL.md"), "older custom managed skill\n");
  assert.equal(refresh(customDirectoryProject).status, 0);
  assertBundlesEqual(bundledSkillRoot, customDirectoryTarget, "automatic custom-directory refresh");

  const globalTarget = join(customGlobalHome, ".windsurf/skills/build-with-fillo");
  writeFileSync(join(globalTarget, "SKILL.md"), "older global managed skill\n");
  assert.equal(refresh(managedProject, customGlobalHome).status, 0);
  assertBundlesEqual(
    bundledSkillRoot,
    globalTarget,
    "automatic global refresh from another project",
  );

  writeFileSync(join(managedTarget, "SKILL.md"), "opted out\n");
  assert.equal(refresh(managedProject, managedProject, { FILLO_AUTO_UPDATE: "0" }).status, 0);
  assert.equal(readFileSync(join(managedTarget, "SKILL.md"), "utf8"), "opted out\n");
  const installRegistry = join(managedProject, ".fillo/skill-installs.json");
  const registry = JSON.parse(readFileSync(installRegistry, "utf8"));
  registry.find((entry) => entry.directory === ".agents/skills").version = "999.0.0";
  writeFileSync(installRegistry, JSON.stringify(registry));
  assert.equal(refresh(managedProject).status, 0);
  assert.equal(
    readFileSync(join(managedTarget, "SKILL.md"), "utf8"),
    "opted out\n",
    "an older CLI cannot roll back a newer skill",
  );

  const markerPath = join(customDirectoryTarget, marker);
  const optedOutMarker = JSON.parse(readFileSync(markerPath, "utf8"));
  optedOutMarker.allowAutomaticUpdates = false;
  writeFileSync(markerPath, JSON.stringify(optedOutMarker));
  writeFileSync(join(customDirectoryTarget, "SKILL.md"), "custom instructions\n");
  assert.equal(refresh(customDirectoryProject).status, 0);
  assert.equal(
    readFileSync(join(customDirectoryTarget, "SKILL.md"), "utf8"),
    "custom instructions\n",
  );

  rmSync(globalTarget, { recursive: true });
  symlinkSync(managedTarget, globalTarget, "dir");
  const failedRefresh = refresh(customProject, customGlobalHome);
  assert.equal(failedRefresh.status, 0, "symlink refusal must not break the command");
  const warnings = failedRefresh.stderr.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(
    warnings.some((event) => event.status === "warning" && /could not refresh/.test(event.message)),
  );
  assert.equal(readFileSync(join(managedTarget, "SKILL.md"), "utf8"), "opted out\n");

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
  assert.equal(refresh(customProject).status, 0);
  assert.equal(readFileSync(join(customTarget, "SKILL.md"), "utf8"), "user-authored skill\n");

  console.log("skill installer provider, global, update, and collision checks passed");
} finally {
  rmSync(shippedRoot, { recursive: true, force: true });
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
