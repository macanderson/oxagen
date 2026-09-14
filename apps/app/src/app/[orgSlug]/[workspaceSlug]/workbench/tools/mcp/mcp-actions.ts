"use server";
/**
 * mcp-actions.ts — server action for Marketplace → MCP: connect a custom
 * MCP server by endpoint URL (not a registry lookup).
 *
 * settings/plugins/plugin-actions.ts `installPlugin` only supports
 * *registry*-sourced mcp_server installs (it resolves the endpoint from the
 * workspace's enabled registries by name). Connecting an arbitrary MCP
 * endpoint needs the full `custom` object (name/endpointUrl/transport/
 * authKind) that the `plugin.org.install` contract already accepts
 * (see packages/oxagen/src/contracts/plugin.org.install.ts) — this action
 * exposes that path. Toggle/uninstall for the resulting listing reuse the
 * existing `togglePlugin`/`uninstallPlugin` actions from settings/plugins/
 * plugin-actions.ts (see mcp-server-list.tsx) since that logic is
 * plugin-type-agnostic.
 *
 * Also home to `revokeMcpCredential` — the "Remove authentication" action
 * that deletes an installed MCP server's stored credential via the
 * `revoke_plugin_credential` capability.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import { resolveAgentToolsManager } from "@/lib/agent-tools/authz";

const ConnectCustomMcpSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  name: z.string().min(1).max(120),
  endpointUrl: z.string().url(),
  transport: z
    .enum(["streamable-http", "sse", "stdio"])
    .default("streamable-http"),
  authKind: z.enum(["oauth", "secret", "none"]).default("none"),
});

export async function connectCustomMcpServer(
  input: z.infer<typeof ConnectCustomMcpSchema>,
): Promise<{
  ok: boolean;
  orgListingId?: string;
  /** Effective auth kind after the install-time OAuth probe. */
  authKind?: "oauth" | "secret" | "none";
  error?: string;
}> {
  const parsed = ConnectCustomMcpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, name, endpointUrl, transport, authKind } =
    parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws, ctx } = auth.scope;

  try {
    const out = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () =>
        invoke(
          "install_plugin",
          {
            pluginType: "mcp_server" as const,
            custom: { name, endpointUrl, transport, authKind },
          },
          ctx,
          { surface: "agent" },
        ),
    );
    revalidatePath(workspace.marketplace.mcp({ orgSlug, workspaceSlug }));
    const typed = out as {
      orgListingId: string;
      authKind?: "oauth" | "secret" | "none";
    };
    return {
      ok: true,
      orgListingId: typed.orgListingId,
      authKind: typed.authKind,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Connect failed",
    };
  }
}

const SetMcpServerSecretSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  // The API key / static bearer token the user pastes for a secret-auth server
  // (e.g. Stripe). Stored envelope-encrypted in mcp.credentials.secret_enc via
  // set_plugin_secret — never logged, never returned.
  secret: z.string().min(1).max(8192),
});

/**
 * "Enter API key" for a secret-auth MCP server: stores the workspace's static
 * credential (encrypted) so the server flips to Connected and its tools become
 * usable. This is the secret-auth counterpart to the OAuth authorize flow —
 * Stripe and other API-key servers have no consent screen, so the key is
 * entered directly here. Wires the app surface to the `set_plugin_secret`
 * capability.
 */
export async function setMcpServerSecret(
  input: z.infer<typeof SetMcpServerSecretSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = SetMcpServerSecretSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, secret } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws, ctx } = auth.scope;

  try {
    await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
      invoke(
        "set_plugin_secret",
        { orgListingId, authKind: "secret" as const, secret },
        ctx,
        { surface: "agent" },
      ),
    );
    revalidatePath(workspace.workbench.tools.mcp({ orgSlug, workspaceSlug }));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Saving the key failed",
    };
  }
}

const RevokeMcpCredentialSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
});

/**
 * "Remove authentication" for an installed MCP server: deletes the stored
 * credential (OAuth tokens or secret) for the listing in this workspace, so
 * the workspace must re-authenticate before the server can be used again.
 * `revoked` reports whether a credential row actually existed.
 */
export async function revokeMcpCredential(
  input: z.infer<typeof RevokeMcpCredentialSchema>,
): Promise<{ ok: boolean; revoked?: boolean; error?: string }> {
  const parsed = RevokeMcpCredentialSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws, ctx } = auth.scope;

  try {
    const out = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () =>
        invoke("revoke_plugin_credential", { orgListingId }, ctx, {
          surface: "agent",
        }),
    );
    revalidatePath(workspace.workbench.tools.mcp({ orgSlug, workspaceSlug }));
    const typed = out as { revoked: boolean };
    return { ok: true, revoked: typed.revoked };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Revoke failed",
    };
  }
}
