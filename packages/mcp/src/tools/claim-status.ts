import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiOrigin, resolvePk, resolveProvision } from "../config.js";
import { fail, ok } from "../result.js";
import { READ_ONLY } from "./annotations.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function registerClaimStatus(server: McpServer): void {
  server.registerTool(
    "fillo_claim_status",
    {
      title: "Check a preview workspace's claim deadline",
      description:
        "Report an unclaimed preview workspace's response cap and claim deadline so you can tell " +
        "the user the real date to claim it by. Uses the caps returned when fillo_provision_workspace " +
        "ran on this machine. If none is recorded, it says so. The claim link is emailed (never " +
        "printed); the developer claims by opening that email and signing in.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const provision = resolveProvision();
      if (!provision) {
        if (resolvePk()) {
          return ok(
            "A publishable key is configured, but no provisioning record is stored on this machine, so " +
              "the claim deadline is not known here. If you provisioned elsewhere, the claim link was " +
              "emailed then; open it and sign in to claim.",
            { mode: "publishable-key", api: apiOrigin() },
          );
        }
        return fail(
          "No provisioned workspace is recorded on this machine. Run fillo_provision_workspace first, " +
            "or open the claim link Fillo emailed when it was provisioned.",
        );
      }

      const expiresMs = provision.expiresAt ? Date.parse(provision.expiresAt) : Number.NaN;
      const daysLeft = Number.isFinite(expiresMs)
        ? Math.max(0, Math.round((expiresMs - Date.now()) / DAY_MS))
        : undefined;
      const expired = Number.isFinite(expiresMs) && expiresMs <= Date.now();

      return ok(
        expired
          ? `This preview workspace's ${provision.expiresAt} hold has passed. The claim link Fillo ` +
              `emailed to ${provision.email ?? "the provisioning address"} may no longer work — ` +
              `provision a fresh workspace if needed.`
          : `Unclaimed preview workspace: up to ${provision.responseCap ?? "a capped number of"} ` +
              `responses, hold ${
                provision.expiresAt ? `ends ${provision.expiresAt}` : "active"
              }${daysLeft !== undefined ? ` (~${daysLeft} day${daysLeft === 1 ? "" : "s"} left)` : ""}. ` +
              `Claim it by opening the link Fillo emailed to ${provision.email ?? "the provisioning address"} ` +
              `and signing in.`,
        {
          mode: "provisional",
          api: apiOrigin(),
          organizationId: provision.organizationId,
          claimLinkEmailedTo: provision.email,
          responseCap: provision.responseCap,
          expiresAt: provision.expiresAt,
          daysLeft,
          expired,
        },
      );
    },
  );
}
