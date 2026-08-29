import { withTenantDb, schema } from "@oxagen/database";
import type { CapabilityContext } from "../types";
import { healthcheck, type McpToolDescriptor } from "../dispatch/mcp-client";
import { captureToolSnapshots } from "../runtime/mcp-snapshots";
import { encryptMcpAuthConfig } from "../runtime/mcp-server-auth-crypto";
import type {
  AgentMcpRegisterInput,
  AgentMcpRegisterOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.register";

export type { AgentMcpRegisterInput, AgentMcpRegisterOutput };

// ── SSRF protection ───────────────────────────────────────────────────────────
// The endpointUrl is attacker-influenceable (an authenticated org admin supplies
// it) and we connect to it with configured bearer/header auth secrets attached.
// Without this guard a caller could point the server at internal-only hosts
// (loopback, RFC1918, link-local incl. the 169.254.169.254 cloud-metadata IP)
// and exfiltrate credentials / probe the internal network. We reject any URL
// that does not resolve to a publicly routable http(s) host.
function assertPublicHttpUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Refusing to register MCP server: invalid endpoint URL "${raw}"`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing to register MCP server: scheme "${parsed.protocol}" is not allowed`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal") {
    throw new Error(
      `Refusing to register MCP server: hostname "${host}" is not allowed`,
    );
  }
  if (host.startsWith("[")) {
    const ipv6 = host.slice(1, -1);
    if (isPrivateIPv6(ipv6)) {
      throw new Error(
        `Refusing to register MCP server: IPv6 address "${ipv6}" is in a non-routable range`,
      );
    }
    return;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIPv4(host)) {
    throw new Error(
      `Refusing to register MCP server: IPv4 address "${host}" is in a non-routable range`,
    );
  }
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? -1 : n;
  });
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 — unspecified
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 (incl. 169.254.169.254 IMDS)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true; // loopback
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true; // fc00::/7 unique-local
  return false;
}

export async function agentMcpRegisterHandler(
  input: AgentMcpRegisterInput,
  ctx: CapabilityContext,
): Promise<AgentMcpRegisterOutput> {
  // SSRF guard: validate the endpoint before any outbound connection that
  // carries auth secrets (the streamable-http probe below).
  if (input.transportType === "streamable-http") {
    assertPublicHttpUrl(input.endpointUrl);
  }

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
        createdByUserId: ctx.userId,
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
      createdByUserId: ctx.userId,
    }).catch(() => {
      /* swallow — server is registered; snapshots can be re-captured on re-enable */
    });
  }

  return {
    mcpServerId: row.publicId,
    healthStatus: probe.status,
    discoveredTools: probe.discoveredTools,
  };
}
