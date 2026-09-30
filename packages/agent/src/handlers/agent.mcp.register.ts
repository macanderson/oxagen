import {
  assertPublicHttpUrl,
  redactUrlCredentials,
  UnsafeOutboundUrlError,
} from "@oxagen/config/public-url";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { withTenantDb, schema } from "@oxagen/database";
import type { CapabilityContext } from "../types";
import { healthcheck, type McpToolDescriptor } from "../dispatch/mcp-client";
import { captureToolSnapshots } from "../runtime/mcp-snapshots";
import { encryptMcpAuthConfig } from "../runtime/mcp-server-auth-crypto";
import { steeringWriter, type OpenedSteeringPr } from "../runtime/steering-pr";
import type {
  AgentMcpRegisterInput,
  AgentMcpRegisterOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.register";

export type { AgentMcpRegisterInput, AgentMcpRegisterOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.mcp" },
});

// ── SSRF protection ───────────────────────────────────────────────────────────
// The endpointUrl is attacker-influenceable (an authenticated org admin supplies
// it) and we connect to it with configured bearer/header auth secrets attached.
// The guard itself lives in @oxagen/config/public-url because a second caller
// arrived — an organisation's own OpenAI-compatible model endpoint (ADR-053 §2)
// — and the inet_aton normalisation is too subtle to keep in two copies.
//
// `requireTls` is deliberately NOT set here: this registration predates the
// guard and admits http: endpoints, and turning that off is a behaviour change
// for existing rows rather than a refactor.
const REFUSING_MCP = "Refusing to register MCP server";

/**
 * Refuse a stdio command URI that carries userinfo. A stdio endpoint such as
 * `stdio://linear` names a local command, not a network address, so the
 * public-address guard does not apply. The URI is still stored and read back
 * in the clear, so a username or password in it is refused, and the refusal
 * quotes the address with its userinfo redacted.
 */
function assertNoUrlCredentials(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeOutboundUrlError(
      `${REFUSING_MCP}: invalid URL "${redactUrlCredentials(raw)}"`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UnsafeOutboundUrlError(
      `${REFUSING_MCP}: "${redactUrlCredentials(raw)}" must not carry a username or password; send the credential in the request, not in the URL`,
    );
  }
}

export async function agentMcpRegisterHandler(
  input: AgentMcpRegisterInput,
  ctx: CapabilityContext,
): Promise<AgentMcpRegisterOutput> {
  // The contract grants org Owner and Admin and the workspace Owner. checkIAM
  // allows every caller in an org below Enterprise, so the handler asks for
  // the role itself, as delete_mcp_server does. Before this check any member
  // could add a server whose tools reach every agent in the workspace.
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin"], workspace: ["Owner"] },
  );

  // Validate the endpoint for every transport, before the probe and before
  // the insert (#3720). The streamable-http probe below connects with auth
  // secrets attached, so that address must be a public http(s) URL. A stdio
  // endpoint is a command URI with no network address to check, but it is
  // still stored and shown, so it must not carry a username or password.
  if (input.transportType === "streamable-http") {
    assertPublicHttpUrl(input.endpointUrl, { refusing: REFUSING_MCP });
  } else {
    assertNoUrlCredentials(input.endpointUrl);
  }

  // Once the workspace's tools live in its steering repo, a remote server is
  // added through a steering PR (M13, #4478). The row is written as a
  // proposed, disabled row that holds the secret and the tool snapshots. The
  // first publish after the PR merges takes it over and turns it on. A stdio
  // server has no server folder form and stays a direct row.
  const writer =
    input.transportType === "streamable-http"
      ? await steeringWriter({ orgId: ctx.orgId, workspaceId: ctx.workspaceId })
      : null;

  // Run the health check before insert so we persist the live tool list
  // alongside the row — the chat surface lists external tools without a
  // second roundtrip. The probe also returns full per-tool JSONSchema
  // descriptors so we can snapshot them for replay durability.
  const probe: {
    status: "healthy" | "degraded" | "unreachable";
    discoveredTools: string[];
    descriptors: McpToolDescriptor[];
  } =
    input.transportType === "streamable-http"
      ? await healthcheck({
          endpointUrl: input.endpointUrl,
          authStrategy: input.authStrategy,
          authConfig: input.authConfig,
        })
      : { status: "degraded", discoveredTools: [], descriptors: [] };

  // Envelope-encrypt any secret material before it ever reaches the DB.
  // authStrategy "none" carries no secrets, so encryptMcpAuthConfig
  // stores `{}`; bearer/header auth REQUIRES AUTH_TOKEN_ENCRYPTION_KEY to be
  // configured and throws rather than persisting plaintext.
  const encryptedAuthConfig = await encryptMcpAuthConfig(input.authConfig);

  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.mcpServers)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        name: input.name,
        transportType: input.transportType,
        endpointUrl: input.endpointUrl,
        authStrategy: input.authStrategy,
        authConfig: encryptedAuthConfig,
        healthStatus: probe.status,
        lastHealthcheckAt: new Date(),
        discoveredTools: probe.discoveredTools as object,
        createdById: ctx.userId,
        ...(writer === null ? {} : { origin: "proposed", enabled: false }),
      })
      .returning({
        id: schema.mcpServers.id,
        publicId: schema.mcpServers.publicId,
      }),
  );
  if (!row) throw new Error("mcp_servers insert failed");

  // Snapshot each discovered tool descriptor. Failure-isolated: a
  // snapshot write must never fail registration of an otherwise-healthy server.
  if (probe.descriptors.length > 0) {
    await captureToolSnapshots({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      mcpServerId: row.id,
      descriptors: probe.descriptors,
      createdById: ctx.userId,
    }).catch(() => {
      /* swallow — server is registered; snapshots can be re-captured on re-enable */
    });
  }

  const output = {
    mcpServerId: row.publicId,
    healthStatus: probe.status,
    discoveredTools: probe.discoveredTools,
  };
  if (writer === null) return output;

  let pr: OpenedSteeringPr;
  try {
    pr = await writer.addServer({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      serverId: row.id,
      actorUserId: ctx.userId,
    });
  } catch (error) {
    // No steering PR opened, so the proposed row has nothing to wait for.
    // A failed delete is logged, and the caller still gets the writer's error,
    // which says why the server was not added.
    await withTenantDb((tx) =>
      tx
        .update(schema.mcpServers)
        .set({ deletedAt: new Date(), deletedById: ctx.userId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.mcpServers.id, row.id),
            eq(schema.mcpServers.workspaceId, ctx.workspaceId),
          ),
        ),
    ).catch((deleteError: unknown) => {
      logger.error(
        { err: deleteError, serverId: row.id, workspaceId: ctx.workspaceId },
        "register_mcp_server: the steering PR did not open and the proposed row was not deleted",
      );
    });
    throw error;
  }
  return { ...output, steeringPr: { number: pr.number, url: pr.url } };
}
