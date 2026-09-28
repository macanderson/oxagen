// run.ts: the run one MCP request belongs to (lane M15; mcp-studio-spec,
// Call path).
//
// A wrapped agent's MCP connection authenticates with its host's gateway
// key. The key's scope names the host it was minted for, the host names the
// runtime it enrolled as, and the session header names the tacho session.
// The runtime and the session's harness pick the agent/v1 file the run
// belongs to. A request with no gateway key, or whose host is revoked or has
// no runtime, belongs to no run and is served no tool.
import type { CapabilityContext } from "@oxagen/oxagen/types";
import type { ServedRun } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The host a gateway key was minted for, in the fields the served tools read. */
export interface ServedHost {
  /** tacho.hosts.id. */
  id: string;
  /** tacho.hosts.public_id: tch_... */
  publicId: string;
  /** The runtime's slug. Null when the host bound no runtime. */
  runtime: string | null;
}

/** The tacho session a request names, in the fields the served tools read. */
export interface ServedSession {
  /** tacho.sessions.public_id: tse_... */
  publicId: string;
  harness: string;
  operatorRole: string | null;
}

/** Where the resolver reads from. Production binds Postgres. */
export interface RunSources {
  /** The host the key's scope names, when the key is a gateway key. */
  host(ctx: { orgId: string; workspaceId: string; apiKeyId: string }): Promise<ServedHost | null>;
  /** The session on that host with this session uuid. */
  session(ctx: { orgId: string; workspaceId: string }, host: ServedHost, sessionUuid: string): Promise<ServedSession | null>;
}

/** The run a request belongs to, or null when it belongs to none. */
export async function resolveServedRun(ctx: CapabilityContext, sources: RunSources): Promise<ServedRun | null> {
  if (ctx.apiKeyId === null) return null;
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const host = await sources.host({ ...scope, apiKeyId: ctx.apiKeyId });
  if (host === null || host.runtime === null) return null;
  const sessionUuid = ctx.gatewaySessionUuid ?? null;
  const session = sessionUuid !== null && UUID.test(sessionUuid) ? await sources.session(scope, host, sessionUuid) : null;
  return {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    requestId: ctx.requestId,
    sessionId: session === null ? null : sessionUuid,
    runtime: host.runtime,
    harness: session?.harness ?? null,
    ...(session?.operatorRole == null ? {} : { operatorRole: session.operatorRole }),
    machine: host.publicId,
    runPublicId: session?.publicId ?? null,
  };
}
