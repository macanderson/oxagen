/**
 * MCP plugin-type contributor: yields raw tools for every server
 * selectMaterializableMcpServers returns (../mcp-servers.ts, the selection
 * get_agent_toolbelt reports from). The decrypted per-workspace credential is
 * injected into connectMcp.
 *
 * For OAuth listings (authKind === "oauth"), a DbOAuthClientProvider is built so
 * the transport auto-refreshes via the provider's tokens()/saveTokens() interface.
 * On UnauthorizedError (or any auth failure), the credential is flipped to
 * needs_reauth and that server is skipped for this turn.
 *
 * KILL SWITCHES (spec §6.11): before anything reaches a server, the turn's
 * gate is asked about the server and the connection it would be reached with.
 * A switch on either (or on the agent, operator, workspace or organisation)
 * leaves the server out of the turn: no connect, no tools/list, no grant. The
 * broker's grant is recorded before the credential is presented, so a killed
 * connection mints no grant and an unrecorded credential use cannot occur.
 *
 * DESCRIPTOR PINNING (pin-or-fail-closed): live tool descriptors are diffed
 * against the newest mcp.tool_snapshots pins before anything reaches the model.
 * Only exact-hash matches are contributed — and the PINNED descriptor (name,
 * description, input schema) is what gets injected, never the live text. A
 * drifted or never-pinned tool is excluded for the turn and audited as a
 * `drift_detected` row in security.mcp_server_changes. Re-pinning is the
 * explicit admin action of disabling + re-enabling the server (which
 * re-captures snapshots), or re-registering it.
 */
import pino from "pino";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { withTenantDb } from "@oxagen/database";
import {
  getWorkspaceSecret,
  DbOAuthClientProvider,
  findCredentialConnection,
  markCredentialNeedsReauth,
  recordCredentialGrant,
  type CredentialConnection,
} from "@oxagen/plugins";
import type { CapabilityContext } from "../../types";
import {
  connectMcp,
  listMcpToolDescriptors,
  materializePinnedMcpTools,
} from "../../dispatch/mcp-client";
import {
  registerPluginType,
  type ContributedRawTool,
  type PluginContributeOptions,
} from "../plugin-type";
import { decryptMcpAuthConfig } from "../mcp-server-auth-crypto";
import { selectMaterializableMcpServers } from "../mcp-servers";
import {
  captureToolSnapshots,
  diffDescriptorsAgainstPins,
  readLatestPinnedDescriptors,
  recordServerChange,
} from "../mcp-snapshots";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.plugin-types.mcp" },
});

/**
 * OAuth redirect_uri used by the runtime's DbOAuthClientProvider during token
 * refresh. Prefers APP_URL but falls back to NEXT_PUBLIC_APP_URL (the one
 * reliably set in production) so the redirect_uri stays an absolute URL —
 * with neither set it would degrade to a relative path, which only works today
 * because the refresh_token grant never sends redirect_uri.
 */
export function resolveMcpOAuthRedirectUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "") +
    "/api/v1/mcp/oauth/callback"
  );
}

async function contributeMcpTools(
  ctx: CapabilityContext,
  options: PluginContributeOptions,
): Promise<ContributedRawTool[]> {
  if (!ctx.workspaceId) return [];

  const workspaceId = ctx.workspaceId;
  const servers = await withTenantDb((tx) =>
    selectMaterializableMcpServers(tx, {
      orgId: ctx.orgId,
      workspaceId,
      serverAllowlist: options.serverAllowlist,
    }),
  );

  const out: ContributedRawTool[] = [];
  for (const server of servers) {
    try {
      // The connection the broker would present for this server, resolved
      // before the gate is asked so a switch on it is seen.
      const connection = await connectionFor(ctx, server);
      const killed = await options.killSwitches.check({
        capabilityId: `mcp.${server.id}`,
        serverId: server.id,
        connectionId: connection?.id ?? null,
        readOnly: false,
      });
      if (killed !== null) {
        logger.warn(
          {
            serverId: server.id,
            serverName: server.name,
            killSwitch: killed.publicId,
            target: `${killed.targetKind} ${killed.targetId}`,
          },
          "MCP server left out of the turn by kill switch",
        );
        continue;
      }
      // The grant is on record before the credential is presented.
      const connectionId =
        connection === null
          ? null
          : (await grantFor(ctx, server, connection)).connectionId;

      let client;
      if (server.authKind === "oauth" && server.orgListingId) {
        // OAuth path: build a DbOAuthClientProvider so the transport auto-refreshes.
        const redirectUrl = resolveMcpOAuthRedirectUrl();
        const authProvider = new DbOAuthClientProvider({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          orgListingId: server.orgListingId,
          redirectUrl,
          // Stable state key for the runtime (not a fresh PKCE flow — just used
          // for the code-verifier store key during token refresh cycles).
          state: "runtime:" + server.orgListingId,
          returnTo: "",
          clientName: "Oxagen",
          now: () => Date.now(),
          // Pre-registered-client fallback for non-DCR providers (GitHub).
          serverUrl: server.endpointUrl,
        });
        client = await connectMcp({
          endpointUrl: server.endpointUrl,
          authStrategy: "none",
          authProvider,
        });
      } else {
        // Static bearer/secret path (Plan 3 behaviour).
        let authStrategy = server.authStrategy as "none" | "bearer" | "header";
        // Decrypt: auth_config is envelope-encrypted at rest (or
        // legacy plaintext, pre-backfill).
        let authConfig = await decryptMcpAuthConfig(server.authConfig);
        if (server.orgListingId && authStrategy !== "none") {
          const cred = await getWorkspaceSecret({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            orgListingId: server.orgListingId,
          });
          const token = cred?.accessToken ?? cred?.secret ?? null;
          if (token) {
            authStrategy = "bearer";
            authConfig = { token };
          }
        }
        client = await connectMcp({
          endpointUrl: server.endpointUrl,
          authStrategy,
          authConfig,
        });
      }

      // ── Descriptor pinning (pin-or-fail-closed) ─────────────────────────
      const live = await listMcpToolDescriptors(client);
      let pins = await readLatestPinnedDescriptors(
        ctx.orgId,
        workspaceId,
        server.id,
      );
      if (pins.length === 0 && live.length > 0) {
        // No baseline on record (server registered before pinning existed, or
        // its snapshot write was dropped). The admin's register/enable action
        // is the trust event, so capture a trust-on-first-use baseline now —
        // but if that write fails we must NOT proceed with unpinned live
        // descriptors: skip the server for this turn (fail closed).
        try {
          await captureToolSnapshots({
            orgId: ctx.orgId,
            workspaceId,
            mcpServerId: server.id,
            descriptors: live,
          });
          pins = live;
          logger.info(
            { serverId: server.id, toolCount: live.length },
            "no descriptor pins on record — captured trust-on-first-use baseline",
          );
        } catch (pinErr) {
          logger.error(
            { serverId: server.id, err: pinErr },
            "failed to capture descriptor baseline — skipping server this turn (fail closed)",
          );
          continue;
        }
      }
      const verdict = diffDescriptorsAgainstPins(live, pins);
      if (verdict.drifted.length > 0 || verdict.unpinned.length > 0) {
        // Poisoning containment: these tools never reach the model this turn.
        logger.warn(
          {
            serverId: server.id,
            serverName: server.name,
            drifted: verdict.drifted,
            unpinned: verdict.unpinned,
          },
          "MCP tool descriptor drift detected — drifted/unpinned tools excluded (fail closed); disable + re-enable the server to accept and re-pin",
        );
        await recordServerChange({
          orgId: ctx.orgId,
          workspaceId,
          serverId: server.id,
          changeType: "drift_detected",
          actorUserId: null,
        }).catch((auditErr) => {
          logger.error(
            { serverId: server.id, err: auditErr },
            "failed to write drift_detected audit row",
          );
        });
      }
      // Only exact pin matches are contributed, and the PINNED descriptor is
      // what the model sees — the live listing is used solely to execute.
      for (const pinnedTool of materializePinnedMcpTools(
        client,
        `mcp.${server.id}`,
        verdict.pinned,
      )) {
        out.push({
          realName: pinnedTool.key,
          description: pinnedTool.description ?? undefined,
          inputSchema: pinnedTool.inputSchema,
          execute: pinnedTool.execute,
          externalServerId: server.id,
          // Agent-RBAC rule identity (spec §3.7): rules address servers by
          // NAME ("github:*"), not by row uuid.
          externalServerName: server.name,
          externalToolName: pinnedTool.toolName,
          externalConnectionId: connectionId,
        });
      }
    } catch (err) {
      // Auth failures: flip credential to needs_reauth and skip this server.
      const isAuthError =
        err instanceof UnauthorizedError ||
        (err instanceof Error &&
          (err.message.includes("401") ||
            err.message.includes("Unauthorized") ||
            err.message.includes("unauthorized")));

      if (isAuthError && server.orgListingId) {
        logger.warn(
          { serverId: server.id, serverName: server.name },
          "auth failure for MCP server; marking needs_reauth",
        );
        await markCredentialNeedsReauth(
          ctx.workspaceId,
          server.orgListingId,
        ).catch((e) => {
          logger.error(
            { serverId: server.id, err: e },
            "failed to mark needs_reauth",
          );
        });
      } else {
        // Per-server non-auth failure is isolated — log and continue.
        logger.error(
          { serverId: server.id, serverName: server.name, err },
          "failed to load MCP tools from server",
        );
      }
    }
  }
  return out;
}

/**
 * The stored credential the broker presents for this server: the workspace's
 * credential for the server's listing, when the server is reached with one
 * (an OAuth listing, or a static strategy other than `none`). Null when the
 * server is reached without a credential.
 */
function connectionFor(
  ctx: CapabilityContext,
  server: {
    authKind: string | null;
    authStrategy: string;
    orgListingId: string | null;
  },
): Promise<CredentialConnection | null> {
  if (
    !server.orgListingId ||
    (server.authKind !== "oauth" && server.authStrategy === "none")
  ) {
    return Promise.resolve(null);
  }
  return findCredentialConnection({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    orgListingId: server.orgListingId,
  });
}

/**
 * The credential broker's record of this use (spec §6.8): `connection` is
 * about to be presented to the server for this turn, on behalf of the run
 * when there is one. Written before the credential is presented; a grant
 * that cannot be written fails the server for this turn, so an unrecorded
 * credential use cannot occur.
 */
function grantFor(
  ctx: CapabilityContext,
  server: {
    id: string;
    publicId: string;
    name: string;
    endpointUrl: string;
  },
  connection: CredentialConnection,
) {
  return recordCredentialGrant({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    connection,
    mcpServerId: server.id,
    // Named on the row, not joined: the server row does not outlive an
    // uninstall and the grants log has to.
    mcpServerPublicId: server.publicId,
    mcpServerName: server.name,
    endpointUrl: server.endpointUrl,
    runId: ctx.agentRun?.runId ?? null,
  });
}

registerPluginType({ type: "mcp_server", contributeTools: contributeMcpTools });

export { contributeMcpTools };
