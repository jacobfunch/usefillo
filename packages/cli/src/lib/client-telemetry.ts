import { readFileSync } from "node:fs";

let command: string | undefined;
let version = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof pkg.version === "string") version = pkg.version;
} catch {
  // A missing package manifest must not break a command.
}

/** Only the registry's canonical name is passed here, never argv or flags. */
export function setClientCommand(name: string): void {
  command = name;
}

export function clientTelemetryHeaders(): Record<string, string> {
  return {
    "X-Fillo-Client": `@usefillo/cli@${version}`,
    ...(command ? { "X-Fillo-Command": command } : {}),
  };
}
