import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertBundlesEqual,
  bundledSkillRoot as target,
  canonicalSkillRoot as source,
  validateSkillBundle,
} from "./skill-bundle.mjs";

validateSkillBundle(source, "canonical Build with Fillo skill");
rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
validateSkillBundle(target, "bundled Build with Fillo skill");
assertBundlesEqual(source, target, "bundled Build with Fillo skill");
