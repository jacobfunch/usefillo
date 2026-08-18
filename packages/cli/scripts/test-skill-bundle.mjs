import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBundlesEqual,
  bundledSkillRoot,
  canonicalSkillRoot,
  packageRoot,
  validateSkillBundle,
} from "./skill-bundle.mjs";

validateSkillBundle(canonicalSkillRoot, "canonical Build with Fillo skill");
validateSkillBundle(bundledSkillRoot, "bundled Build with Fillo skill");
assertBundlesEqual(canonicalSkillRoot, bundledSkillRoot, "dist skill bundle");

const canonicalSkill = readFileSync(join(canonicalSkillRoot, "SKILL.md"), "utf8");
assert.match(canonicalSkill, /@usefillo\/react@latest/);
assert.match(canonicalSkill, /@usefillo\/dom@latest/);
assert.match(canonicalSkill, /registry's current `latest`/);
assert.match(canonicalSkill, /Treat a rendered form as preview proof only/u);
assert.match(canonicalSkill, /Not live — responses will not be saved/u);
assert.match(canonicalSkill, /Never describe a draft as deployed, ready, or complete/u);

const packRoot = mkdtempSync(join(tmpdir(), "fillo-cli-pack-"));
try {
  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packRoot],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const result = JSON.parse(packed.stdout);
  assert.equal(result.length, 1);

  const archive = join(packRoot, result[0].filename);
  const untar = spawnSync("tar", ["-xzf", archive, "-C", packRoot], {
    encoding: "utf8",
  });
  assert.equal(untar.status, 0, untar.stderr || untar.stdout);

  const packedSkill = join(
    packRoot,
    "package",
    "dist",
    "skill",
    "build-with-fillo",
  );
  validateSkillBundle(packedSkill, "packed Build with Fillo skill");
  assertBundlesEqual(canonicalSkillRoot, packedSkill, "packed skill bundle");

  // Keep this assertion close to npm's own file manifest as a second check that
  // every canonical path is part of the published package.
  const packedPaths = new Set(result[0].files.map((file) => file.path));
  for (const file of validateSkillBundle(canonicalSkillRoot)) {
    assert.ok(
      packedPaths.has(`dist/skill/build-with-fillo/${file}`),
      `npm tarball manifest is missing ${file}`,
    );
  }

  const scratchProject = join(packRoot, "scratch-project");
  mkdirSync(join(scratchProject, ".git"), { recursive: true });
  writeFileSync(
    join(scratchProject, "package.json"),
    JSON.stringify({ name: "fillo-cli-scratch-install", private: true }),
  );
  const installPackage = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
    { cwd: scratchProject, encoding: "utf8" },
  );
  assert.equal(
    installPackage.status,
    0,
    installPackage.stderr || installPackage.stdout,
  );

  const installedCli = join(
    scratchProject,
    "node_modules",
    "@usefillo",
    "cli",
    "dist",
    "index.js",
  );
  const installSkill = spawnSync(
    process.execPath,
    [installedCli, "skill", "install", "--agent", "agents"],
    { cwd: scratchProject, encoding: "utf8" },
  );
  assert.equal(installSkill.status, 0, installSkill.stderr || installSkill.stdout);
  assertBundlesEqual(
    canonicalSkillRoot,
    join(scratchProject, ".agents", "skills", "build-with-fillo"),
    "skill installed by the packed CLI",
  );

  console.log("npm tarball and scratch install contain the byte-identical skill bundle");
} finally {
  rmSync(packRoot, { recursive: true, force: true });
}
