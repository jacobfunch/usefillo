import { api, readJson, requireToken } from "../lib/api.js";
import type { Flags } from "../lib/flags.js";
import { boldRaw, die, dim, dimRaw, emitResult, jsonMode, okMark } from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo branding` — the workspace's "Powered by Fillo" checkbox, over the
 * human's `fcli_` credential. `off` hides the badge (needs the Everything
 * plan; the server enforces it and explains the Settings step when not),
 * `on` shows it again, no argument prints the current state. Plan selection
 * itself is deliberately NOT a CLI action — a human clicks that in Settings.
 */

type BrandingBody = {
  plan?: "free" | "pro";
  showBranding?: boolean;
  poweredBy?: boolean;
  canHide?: boolean;
  error?: string;
};

function printState(body: BrandingBody) {
  const plan = body.plan === "pro" ? "Everything" : "Free";
  console.log(`  Plan:   ${plan}`);
  console.log(`  Badge:  ${body.poweredBy ? "shown" : "hidden"}`);
  // Gate on the server's own verdict, not the plan name — it stays correct if
  // the entitlement rule ever changes.
  if (body.canHide === false) {
    console.log(dim("  Turning it off needs the Everything plan (Settings → Plan)."));
  }
}

async function branding(subcommand: string | undefined, flags: Flags) {
  if (subcommand === "help") return brandingHelp();
  if (subcommand !== undefined && subcommand !== "on" && subcommand !== "off") {
    die(`Unknown branding command: ${subcommand} (expected on, off, or nothing for status).`);
  }
  const token = requireToken();
  const res =
    subcommand === undefined
      ? await api("/cli/workspace/branding", { token })
      : await api("/cli/workspace/branding", {
          method: "PATCH",
          token,
          body: JSON.stringify({ show: subcommand === "on" }),
        });
  const body = (await readJson(res)) as BrandingBody;
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok) die(body.error ?? `branding ${subcommand ?? "status"} failed (${res.status}).`);
  if (jsonMode(flags)) return emitResult(body);
  console.log("");
  if (subcommand !== undefined) {
    console.log(
      `  ${okMark()} Badge ${body.poweredBy ? "shown" : "hidden"} on Fillo-rendered forms.\n`,
    );
  }
  printState(body);
  console.log("");
}

function brandingHelp() {
  console.log(`
  ${boldRaw("fillo branding")} — the workspace's "Powered by Fillo" badge

  ${boldRaw("Commands")}
    branding           Print the current badge state
    branding off       Hide the badge on Fillo-rendered forms (Everything plan)
    branding on        Show the badge again

  ${dimRaw("Hiding needs the Everything plan; a workspace owner or admin selects")}
  ${dimRaw("that in Settings → Plan. Headless embeds never show a badge.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const brandingCommand: Command = {
  name: "branding",
  flags: [],
  run: (args, flags) => branding(args[0], flags),
  help: brandingHelp,
};
