import { accessSync } from "node:fs";
import { join } from "node:path";
import {
  assertBundlesEqual,
  bundledSkillRoot,
  canonicalSkillRoot,
  packageRoot,
  validateSkillBundle,
} from "./skill-bundle.mjs";

accessSync(join(packageRoot, "dist", "index.js"));
validateSkillBundle(canonicalSkillRoot, "canonical Build with Fillo skill");
validateSkillBundle(bundledSkillRoot, "bundled Build with Fillo skill");
assertBundlesEqual(
  canonicalSkillRoot,
  bundledSkillRoot,
  "bundled Build with Fillo skill",
);

console.log("canonical and bundled Build with Fillo skills are byte-identical");
