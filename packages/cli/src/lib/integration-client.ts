import { API, callApi, failed, requireToken } from "./api.js";
import type { Flags } from "./flags.js";
import { die, emitResult, jsonMode, okMark } from "./output.js";

/**
 * The client half of the uniform per-form integration surface
 * (`/api/v1/cli/forms/{form}/integrations/{provider}`): GET reports
 * `{ enabled, config }`, PUT enables or reconfigures, DELETE stops it. Every
 * `fillo sheets|notion|hubspot|slack` verb goes through here, so one status
 * mapping serves all four instead of four near-copies.
 *
 * The human-layer gates those commands need (docs/engineering/agent-parity.md)
 * are `requireConfirm` in lib/confirm.ts — an agent must not be able to send a
 * workspace's answers to a third party on its own initiative:
 *
 *   - Tier B (enable): in agent mode the command refuses without a bare
 *     `--confirm`, and prints where the data will flow before the write.
 *   - Tier C (remove/disconnect): the caller types the target's exact name.
 */

export type IntegrationProviderSlug = "google_sheets" | "notion" | "slack" | "hubspot";

export type IntegrationView = {
  provider: IntegrationProviderSlug;
  enabled: boolean;
  config: Record<string, unknown> | null;
  error?: string;
};

function integrationPath(form: string, provider: IntegrationProviderSlug): string {
  return `/cli/forms/${encodeURIComponent(form)}/integrations/${provider}`;
}

function integrationRequest(
  form: string,
  provider: IntegrationProviderSlug,
  init: { method?: string; body?: string } = {},
): Promise<IntegrationView> {
  return callApi<IntegrationView>(integrationPath(form, provider), init, {
    fallback: failed("integration request"),
    on: (res, body) => {
      if (res.status === 404) die(body.error ?? "Form not found in the selected project.");
      if (res.status === 409) {
        // Connect-first, destination-changed, and provider rejections all
        // arrive here already worded for a human; the server never echoes
        // provider prose.
        die(body.error ?? "That destination isn't available right now.");
      }
    },
  });
}

export function getIntegration(form: string, provider: IntegrationProviderSlug) {
  return integrationRequest(form, provider);
}

export function putIntegration(
  form: string,
  provider: IntegrationProviderSlug,
  config: Record<string, unknown>,
) {
  return integrationRequest(form, provider, { method: "PUT", body: JSON.stringify(config) });
}

export function deleteIntegration(form: string, provider: IntegrationProviderSlug) {
  return integrationRequest(form, provider, { method: "DELETE" });
}

/**
 * `<provider> status <form>` and `<provider> disable <form>` are the same
 * command four times over — read or clear one form's destination, honor --json,
 * and otherwise print. Each provider supplies only what differs: its usage line,
 * how an enabled destination reads, and what stays behind after disabling.
 */
export function integrationStatus(
  provider: IntegrationProviderSlug,
  opts: { usage: string; print: (body: IntegrationView) => void },
) {
  return async (form: string | undefined, flags: Flags): Promise<void> => {
    if (!form) die(opts.usage);
    const body = await getIntegration(form, provider);
    if (jsonMode(flags)) return emitResult(body);
    opts.print(body);
  };
}

export function integrationDisable(
  provider: IntegrationProviderSlug,
  opts: { usage: string; done: string },
) {
  return async (form: string | undefined, flags: Flags): Promise<void> => {
    if (!form) die(opts.usage);
    const body = await deleteIntegration(form, provider);
    if (jsonMode(flags)) return emitResult(body);
    console.log(`  ${okMark()} ${opts.done}`);
  };
}

/** The OAuth start URL for a provider whose connect flow a terminal can launch,
 *  pinned to the token's project. The browser bounce lands on
 *  /connections/done, which is why the provider slug must be one the server's
 *  `return=terminal` list knows. */
export async function terminalConnectUrl(provider: string): Promise<string> {
  const body = await callApi<{ projectId: string }>(
    "/cli/whoami",
    { token: requireToken() },
    {
      fallback: "Couldn't resolve the selected Fillo project.",
      expect: (b) => typeof b.projectId === "string" && Boolean(b.projectId),
    },
  );
  return `${API}/api/integrations/${provider}/start?return=terminal&project=${encodeURIComponent(
    body.projectId,
  )}`;
}

export type ConnectionsView = {
  accounts: Array<{
    id: string;
    provider: string;
    label: string;
    selected: boolean;
    projectCount: number;
    formDestinationCount: number;
  }>;
  selected: Record<string, string | null>;
  discordServers: Array<{ id: string; guildId: string; name: string | null }>;
  error?: string;
};

export function fetchConnections(): Promise<ConnectionsView> {
  return callApi<ConnectionsView>(
    "/cli/integrations/connections",
    {},
    { fallback: failed("connections") },
  );
}
