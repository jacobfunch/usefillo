import { callApi, failed } from "../lib/api.js";
import { connectViaBrowser } from "../lib/browser-connect.js";
import { requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  fetchConnections,
  type IntegrationView,
  integrationDisable,
  integrationStatus,
  putIntegration,
  terminalConnectUrl,
} from "../lib/integration-client.js";
import {
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

/**
 * `fillo hubspot` — upsert a Contact (and optionally a Company and a Deal) in
 * HubSpot for every response.
 *
 * `properties` and `pipelines` exist so a mapping can be built from real ids
 * instead of guesses: HubSpot's internal property names are not the labels a
 * person sees, and a Deal needs a live pipeline/stage pair.
 *
 * Enabling is Tier B (docs/engineering/agent-parity.md): respondent answers
 * start creating CRM records in someone's HubSpot account, so an agent must
 * carry the human's yes as a bare `--confirm`. The server re-validates every
 * field and pipeline against the live account before anything is saved.
 */

type HubSpotConfig = {
  hubspotPortalId?: string;
  hubspotEmailFieldId?: string;
  hubspotMappings?: Array<{ fieldId: string; property: string }>;
  hubspotCreateMarketableContact?: boolean;
  hubspotCompany?: {
    domainFieldId: string;
    mappings: Array<{ fieldId: string; property: string }>;
  };
  hubspotDeal?: { nameFieldId: string; pipelineLabel?: string; stageLabel?: string };
};

/** `--map fieldId=property,fieldId2=property2`. Repeated flags can't work —
 *  the parser keeps one value per flag — so the list is comma-separated. */
function parsePairs(raw: string, flag: string): Array<{ fieldId: string; property: string }> {
  if (raw.trim().toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [fieldId, property, ...extra] = pair.split("=");
      if (extra.length > 0 || !fieldId?.trim() || !property?.trim()) {
        die(`--${flag} must be fieldId=property pairs, comma-separated (got: ${pair}).`);
      }
      return { fieldId: fieldId.trim(), property: property.trim() };
    });
}

function printStatus(body: IntegrationView) {
  const config = (body.config ?? {}) as HubSpotConfig;
  if (!body.enabled) {
    console.log(
      "  This form isn't sending to HubSpot. Turn it on with `fillo hubspot enable <form> --email-field <id>`.",
    );
    return;
  }
  console.log(
    `  ${okMark()} Upserting a HubSpot Contact for every response${
      config.hubspotPortalId ? ` (account ${terminalText(config.hubspotPortalId)})` : ""
    }`,
  );
  console.log(`  ${dim("Email field:")}  ${terminalText(config.hubspotEmailFieldId ?? "—")}`);
  const mappings = config.hubspotMappings ?? [];
  console.log(
    `  ${dim("Contact map:")}  ${
      mappings.length > 0
        ? terminalText(mappings.map((m) => `${m.fieldId}=${m.property}`).join(", "))
        : "email only"
    }`,
  );
  console.log(
    `  ${dim("Company:")}      ${config.hubspotCompany ? terminalText(`domain from ${config.hubspotCompany.domainFieldId}`) : "off"}`,
  );
  console.log(
    `  ${dim("Deal:")}         ${
      config.hubspotDeal
        ? terminalText(
            `${config.hubspotDeal.nameFieldId} → ${config.hubspotDeal.pipelineLabel ?? "pipeline"} / ${
              config.hubspotDeal.stageLabel ?? "stage"
            }`,
          )
        : "off"
    }`,
  );
  console.log(
    `  ${dim("Marketable:")}   ${config.hubspotCreateMarketableContact ? "new contacts are marketing contacts" : "off"}`,
  );
}

async function connect(flags: Flags) {
  const json = jsonMode(flags);
  const startUrl = await terminalConnectUrl("hubspot");
  await connectViaBrowser({
    json,
    what: "HubSpot",
    startUrl,
    poll: async () => {
      const connections = await fetchConnections();
      return typeof connections.selected?.hubspot === "string";
    },
    onConnected: () => ({
      result: { connected: true },
      lines: [
        `  ${okMark()} HubSpot connected.`,
        "  List the properties you can map with `fillo hubspot properties`.",
      ],
    }),
  });
}

async function lookup(kind: "properties" | "pipelines", flags: Flags) {
  const json = jsonMode(flags);
  const body = await callApi<{
    properties?: Array<{ name: string; label: string; type?: string }>;
    pipelines?: Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }>;
  }>(`/cli/integrations/hubspot/${kind}`, {}, { fallback: failed(`hubspot ${kind}`) });
  if (json) return emitResult(body);

  if (kind === "properties") {
    const rows = body.properties ?? [];
    if (rows.length === 0) return console.log("  No writable Contact properties came back.");
    console.log("");
    printTable(
      ["PROPERTY", "LABEL", "TYPE"],
      rows.map((row) => [row.name, terminalText(row.label), row.type ?? ""]),
    );
    console.log(
      `\n  ${dim("Map one: fillo hubspot enable <form> --email-field <id> --map <fieldId>=<property>")}`,
    );
    return;
  }

  const pipelines = body.pipelines ?? [];
  if (pipelines.length === 0) return console.log("  No Deal pipelines came back.");
  console.log("");
  printTable(
    ["PIPELINE", "PIPELINE ID", "STAGE", "STAGE ID"],
    pipelines.flatMap((pipeline) =>
      pipeline.stages.map((stage) => [
        terminalText(pipeline.label),
        pipeline.id,
        terminalText(stage.label),
        stage.id,
      ]),
    ),
  );
  console.log(
    `\n  ${dim("Use one: --deal-pipeline <pipelineId> --deal-stage <stageId> --deal-name <fieldId>")}`,
  );
}

const status = integrationStatus("hubspot", {
  usage: "Usage: fillo hubspot status <form> — a form id, slug, or push handle.",
  print: printStatus,
});

async function enable(form: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!form) {
    die(
      "Usage: fillo hubspot enable <form> --email-field <fieldId> [--map a=prop,b=prop] " +
        "[--company-domain <fieldId> --company-map a=name] " +
        "[--deal-name <fieldId> --deal-pipeline <id> --deal-stage <id> --deal-map a=amount] [--confirm]",
    );
  }
  const emailField = flagString(flags, "email-field");
  if (!emailField) {
    die(
      "--email-field <fieldId> is required: HubSpot upserts the Contact by email, so the form " +
        "must carry one. `fillo status <form>` lists the field ids.",
    );
  }

  const companyDomain = flagString(flags, "company-domain");
  const companyMap = flagString(flags, "company-map");
  if (companyMap !== undefined && companyDomain === undefined) {
    die("--company-map needs --company-domain <fieldId> — it maps onto that Company.");
  }
  const dealName = flagString(flags, "deal-name");
  const dealPipeline = flagString(flags, "deal-pipeline");
  const dealStage = flagString(flags, "deal-stage");
  const dealMap = flagString(flags, "deal-map");
  const dealAsked = [dealName, dealPipeline, dealStage, dealMap].some((v) => v !== undefined);
  if (dealAsked && (!dealName || !dealPipeline || !dealStage)) {
    die(
      "A Deal needs --deal-name <fieldId>, --deal-pipeline <id>, and --deal-stage <id> together. " +
        "List the ids with `fillo hubspot pipelines`.",
    );
  }

  const destinations = ["a Contact"];
  if (companyDomain) destinations.push("a Company");
  if (dealName) destinations.push("a Deal");
  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    command: `fillo hubspot enable ${form} --email-field ${emailField}`,
    notice: `Every response will create or update ${destinations.join(", ")} in the connected HubSpot account.`,
  });

  const contactMap = flagString(flags, "map");
  const body = await putIntegration(form, "hubspot", {
    hubspotEmailFieldId: emailField,
    hubspotMappings: contactMap ? parsePairs(contactMap, "map") : [],
    ...(flags.marketable === true ? { hubspotCreateMarketableContact: true } : {}),
    ...(companyDomain
      ? {
          hubspotCompany: {
            domainFieldId: companyDomain,
            mappings: companyMap ? parsePairs(companyMap, "company-map") : [],
          },
        }
      : {}),
    ...(dealName && dealPipeline && dealStage
      ? {
          hubspotDeal: {
            nameFieldId: dealName,
            pipelineId: dealPipeline,
            stageId: dealStage,
            mappings: dealMap ? parsePairs(dealMap, "deal-map") : [],
          },
        }
      : {}),
  });
  if (json) return emitResult(body);
  printStatus(body);
}

const disable = integrationDisable("hubspot", {
  usage: "Usage: fillo hubspot disable <form> — a form id, slug, or push handle.",
  done: "This form no longer writes to HubSpot. Records already created stay there.",
});

async function hubspot(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "help") return hubspotHelp();
  if (subcommand === "connect") return connect(flags);
  if (subcommand === "properties") return lookup("properties", flags);
  if (subcommand === "pipelines") return lookup("pipelines", flags);
  if (subcommand === "status") return status(args[0], flags);
  if (subcommand === "enable") return enable(args[0], flags);
  if (subcommand === "disable") return disable(args[0], flags);
  die(
    `Unknown hubspot command: ${terminalText(subcommand)} ` +
      "(expected connect, properties, pipelines, status, enable, or disable).",
  );
}

function hubspotHelp() {
  console.log(`
  ${boldRaw("fillo hubspot")} — create HubSpot CRM records from every response

  ${boldRaw("Commands")}
    hubspot connect          Connect a HubSpot account (opens an OAuth URL to approve)
    hubspot properties       Writable Contact properties you can map onto
    hubspot pipelines        Deal pipelines and stages, with their ids
    hubspot status <form>    What this form sends, and with which mapping
    hubspot enable <form>    Start upserting records
                       ${dimRaw("--email-field <id>       required — the Contact identity")}
                       ${dimRaw("--map a=prop,b=prop      Fillo field → Contact property")}
                       ${dimRaw("--marketable             new Contacts become marketing contacts")}
                       ${dimRaw("--company-domain <id>    also upsert a Company from that answer")}
                       ${dimRaw("--company-map a=name     Fillo field → Company property")}
                       ${dimRaw("--deal-name <id>         also upsert a Deal named from that answer")}
                       ${dimRaw("--deal-pipeline <id> --deal-stage <id>   from `hubspot pipelines`")}
                       ${dimRaw("--deal-map a=amount      Fillo field → Deal property")}
                       ${dimRaw("--confirm                required for agents; ask the human first")}
    hubspot disable <form>   Stop writing (records already created stay there)

  ${dimRaw("The whole workflow is saved at once: enable always sends the complete")}
  ${dimRaw("mapping, so a Company or Deal you stop naming is dropped rather than kept.")}
  ${dimRaw("Enabling puts respondent answers in someone's CRM, so agents (--json or")}
  ${dimRaw("FILLO_AGENT=1) must pass a bare --confirm.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const hubspotCommand: Command = {
  name: "hubspot",
  flags: [
    "email-field",
    "map",
    "marketable",
    "company-domain",
    "company-map",
    "deal-name",
    "deal-pipeline",
    "deal-stage",
    "deal-map",
    "confirm",
  ],
  run: (args, flags) => hubspot(args[0], args.slice(1), flags),
  help: hubspotHelp,
};
