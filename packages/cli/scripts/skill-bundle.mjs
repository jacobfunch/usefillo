import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const canonicalSkillRoot = resolve(
  packageRoot,
  "../../plugins/fillo/skills/build-with-fillo",
);
export const bundledSkillRoot = join(
  packageRoot,
  "dist",
  "skill",
  "build-with-fillo",
);

const REQUIRED_FILES = [
  ".fillo-managed.json",
  "SKILL.md",
  "agents/openai.yaml",
  "references/auth-and-lifecycle.md",
  "references/frameworks.md",
  "references/operations.md",
  "references/schema-and-ux.md",
  "references/source-map.md",
  "references/troubleshooting.md",
];

function portablePath(path) {
  return path.split(sep).join("/");
}

export function listBundleFiles(root) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill bundles cannot contain symlinks: ${portablePath(relative(root, absolute))}`);
      }
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(portablePath(relative(root, absolute)));
      else throw new Error(`Unsupported skill bundle entry: ${absolute}`);
    }
  }

  visit(root);
  return files.sort();
}

function localMarkdownTargets(root, file) {
  const markdown = readFileSync(join(root, file), "utf8");
  return [...markdown.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1].split("#", 1)[0])
    .filter(
      (target) =>
        target &&
        !target.startsWith("#") &&
        !target.startsWith("/") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(target),
    );
}

export function validateSkillBundle(root, label = "skill bundle") {
  const files = listBundleFiles(root);
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) {
      throw new Error(`${label} is missing required file: ${required}`);
    }
  }

  const marker = JSON.parse(readFileSync(join(root, ".fillo-managed.json"), "utf8"));
  if (marker.managedBy !== "@usefillo/cli") {
    throw new Error(`${label} has an invalid .fillo-managed.json provenance marker`);
  }

  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  const frontmatterEnd = skill.indexOf("\n---\n", 4);
  const frontmatter = frontmatterEnd === -1 ? "" : skill.slice(4, frontmatterEnd);
  if (!/^name: build-with-fillo$/m.test(frontmatter)) {
    throw new Error(`${label} SKILL.md must declare name: build-with-fillo in frontmatter`);
  }

  for (const file of files.filter((path) => path.endsWith(".md"))) {
    for (const target of localMarkdownTargets(root, file)) {
      const sourceDirectory = dirname(join(root, file));
      const resolved = resolve(sourceDirectory, target);
      const relativeTarget = portablePath(relative(root, resolved));
      if (relativeTarget.startsWith("../") || !files.includes(relativeTarget)) {
        throw new Error(`${label} has a missing local reference from ${file}: ${target}`);
      }
    }
  }

  return files;
}

export function assertBundlesEqual(expectedRoot, actualRoot, label = "skill bundle") {
  const expectedFiles = listBundleFiles(expectedRoot);
  const actualFiles = listBundleFiles(actualRoot);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `${label} file list differs from canonical source\nexpected: ${expectedFiles.join(", ")}\nactual: ${actualFiles.join(", ")}`,
    );
  }

  for (const file of expectedFiles) {
    const expected = readFileSync(join(expectedRoot, file));
    const actual = readFileSync(join(actualRoot, file));
    if (!actual.equals(expected)) {
      throw new Error(`${label} differs from canonical source at ${file}`);
    }
  }
}
