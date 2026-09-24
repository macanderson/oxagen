/**
 * MCP capability-context resolution.
 *
 * Real per-request identity is resolved from the inbound Authorization header.
 * Only API keys are accepted:
 *   - API key `ox_<base64url(32 bytes)>` -> resolveApiKey -> org / workspace
 *     scope. (`resolveApiKey` indexes on the leading 12 characters, which is
 *     a fixed-width window, not "the characters before the first underscore"
 *     — see API_KEY_PREFIX_LENGTH in @oxagen/auth.)
 *
 * Session tokens (Better Auth opaque tokens -- no underscore) are rejected at
 * the edge with `invalid_token`. Session tokens carry no org/workspace scope;
 * accepting them would produce orgId:"" which fails closed in the kernel but
 * gives a confusing error. MCP clients must always authenticate with API keys.
 *
 * An orgId of "" (empty string) is never a valid scope, from either path.
 * The API-key path also rejects a resolved orgId/workspaceId that is empty,
 * so a bad scope is caught here instead of failing later, deeper in the
 * kernel.
 *
 * Token classification is a cheap pre-filter, not the authority: an API key
 * always contains an underscore (its `ox_` prefix), while a Better Auth
 * session token is a UUID (see `generateId` in packages/auth/src/auth.ts) and
 * so contains only hex digits and hyphens. A token that passes the underscore
 * check is still verified by `resolveApiKey`, which re-checks the full `ox_`
 * prefix and the hashed secret before returning any scope.
 *
 * SECURITY: tenant identity (orgId / workspaceId / userId / apiKeyId) is NEVER
 * read from client-controlled identity headers (`x-oxagen-org-id` & friends).
 * It is derived solely from the validated credential. Two headers are read and
 * neither is a security boundary: `x-request-id`, a trace-correlation id that
 * falls back to a fresh UUID when absent, and `x-tacho-gateway-session` and
 * `x-tacho-gateway-genesis`, the Tacho daemon chain a local MCP gateway is
 * serving and that chain's genesis hash (#3221).
 *
 * The second is worth being explicit about, because it is a header that ends
 * up in a durable record. It names the CALLER'S OWN chain and nothing else —
 * it cannot widen a scope, select an org, workspace or host, or reach any
 * authorisation decision. `machineKeyDenial` records it only when the key it
 * arrived with has scope purpose `tacho_gateway_v1`, and files it against the
 * host that key is bound to; on every other credential it is carried and never
 * read. So the value is attested by whoever holds the gateway credential, which
 * is the daemon, which is exactly the party whose gateway use is being
 * recorded.
 *
 * `buildContext` is the single auth entrypoint for xmcp tools: each tool calls
 * `await buildContext(headers())`. It throws `McpUnauthorizedError` on any auth
 * failure so the tool invocation fails closed (xmcp surfaces it as an error).
 */
import { requireEnv } from "@oxagen/config/env";
import { extractTrustedClientIp } from "@oxagen/oxagen/client-ip";
import type { CapabilityContext } from "@oxagen/oxagen";
import { resolveApiKey } from "@oxagen/auth";
// Through `@oxagen/oxagen`, which re-exports the leaf package's wire
// constants, rather than adding `@oxagen/tacho` to this app's dependencies —
// the header name is the contract, and it is still spelled in exactly one
// place.
import {
  TACHO_GATEWAY_GENESIS_HEADER,
  TACHO_GATEWAY_SESSION_HEADER,
} from "@oxagen/oxagen/tacho/schemas";
import { emitSecurityEvent } from "@oxagen/database/security";

/** xmcp's headers() helper returns this shape (array when a header repeats). */
type HttpHeaders = Record<string, string | string[] | undefined>;

/** Typed reasons an MCP request fails authentication. */
export type McpAuthFailure =
  | "unauthenticated"
  | "invalid_token"
  | "expired_token"
  /** The key is valid but its workspace is archived (ADR-105). */
  | "workspace_archived"
  /**
   * The key is valid but its organization requires SSO and the key's creator
   * has not signed in through one of its providers (ADR-145).
   */
  | "sso_required";

/**
 * What a person reads for a refusal whose reason code alone does not say what
 * to do. The API answers the same refusal with the same sentence.
 */
const MCP_AUTH_FAILURE_DETAIL: Partial<Record<McpAuthFailure, string>> = {
  sso_required:
    "This organization requires single sign-on. The person who created this key must sign in through SSO.",
};

/** Thrown when an MCP request carries no valid principal. Fails closed. */
export class McpUnauthorizedError extends Error {
  readonly reason: McpAuthFailure;
  constructor(reason: McpAuthFailure) {
    const detail = MCP_AUTH_FAILURE_DETAIL[reason];
    super(
      detail
        ? `MCP request unauthorized: ${reason}. ${detail}`
        : `MCP request unauthorized: ${reason}`,
    );
    this.name = "McpUnauthorizedError";
    this.reason = reason;
  }
}

/** First value of a (possibly repeated) header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Extracts a raw Bearer token from an Authorization header value.
 *
 * @param authHeader - The raw Authorization header (e.g. "Bearer abc123").
 * @returns The token string, or null when the header is absent or malformed.
 */
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * The Tacho daemon chain a local MCP gateway call is being served for.
 *
 * Bounded and character-checked before it is carried anywhere, because it is
 * written to a durable evidence row and is not trusted to be sane merely
 * because of the credential it arrived with. Anything outside the bound reads
 * as absent, which leaves the session on the host's own enforcement tier: the
 * same answer as a host that has never used the gateway.
 *
 * What the daemon actually sends is `hostRecorder.sessionUuid` — a v5 UUID
 * derived as `uuidv5(NS_TACHO_SESSION, "<host enrollment id>/tachod-<ulid>")`
 * (`packages/tacho/src/ids.ts`), NOT the literal `tachod-<ulid>` chain id the
 * daemon knows it by. The two are easy to confuse and this comment used to say
 * the wrong one.
 *
 * The check below is deliberately a bound and a character class rather than a
 * uuid pattern. A value that is not a session uuid can never match anything —
 * ingest looks it up against `tacho.sessions.session_uuid` — so pinning the
 * shape here would buy no safety, and it would turn any later change to how the
 * daemon derives its chain uuid into the tier silently vanishing rather than a
 * visible mismatch.
 */
function extractGatewaySession(hdrs: HttpHeaders): string | null {
  const raw = firstHeader(hdrs[TACHO_GATEWAY_SESSION_HEADER])?.trim();
  if (raw === undefined || raw.length === 0 || raw.length > 128) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(raw) ? raw : null;
}

/**
 * The genesis hash of the daemon chain a gateway call is being served for.
 *
 * Accepted only in the shape every Tacho chain hash has — `sha256:` and 64
 * lowercase hex — for the same reason the chain id is bounded: it is written
 * to a durable evidence row and compared against one. Anything else reads as
 * absent, which leaves the session on the host's own enforcement tier.
 */
function extractGatewayGenesis(hdrs: HttpHeaders): string | null {
  const raw = firstHeader(hdrs[TACHO_GATEWAY_GENESIS_HEADER])?.trim();
  if (raw === undefined) return null;
  return /^sha256:[0-9a-f]{64}$/.test(raw) ? raw : null;
}

export type McpContextResolution =
  | { ok: true; ctx: CapabilityContext }
  | { ok: false; reason: McpAuthFailure };

/**
 * Whether the edge-written `x-oxagen-client-ip` header is believed, resolved
 * from the validated env once and memoized. Off by
 * default: the header is only trustworthy once the Caddy config that SETS it is
 * deployed, and that ships through a different pipeline than this code. See
 * packages/oxagen/src/client-ip.ts.
 */
let cachedTrustEdgeHeader: boolean | null = null;
function trustEdgeHeader(): boolean {
  if (cachedTrustEdgeHeader !== null) return cachedTrustEdgeHeader;
  cachedTrustEdgeHeader = requireEnv([
    "TRUST_EDGE_CLIENT_IP_HEADER",
  ] as const).TRUST_EDGE_CLIENT_IP_HEADER;
  return cachedTrustEdgeHeader;
}

/**
 * The proxies this deployment trusts, by identity rather than by count.
 * Memoized on the same terms as the flag above. This is the only thing that
 * can attribute an address off Vercel once the edge header is out of the
 * picture — counting hops was deleted in #3205.
 */
let cachedTrustedProxyCidrs: string[] | null = null;
function trustedProxyCidrs(): string[] {
  if (cachedTrustedProxyCidrs !== null) return cachedTrustedProxyCidrs;
  cachedTrustedProxyCidrs = requireEnv(["TRUSTED_PROXY_CIDRS"] as const)
    .TRUSTED_PROXY_CIDRS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return cachedTrustedProxyCidrs;
}

/** Test seam: drop the memoized proxy config so a case can set a different env. */
export function __resetTrustedProxyHopsForTests(): void {
  cachedTrustEdgeHeader = null;
  cachedTrustedProxyCidrs = null;
}

/**
 * The client address this surface is willing to authorize on, through the one
 * shared derivation (`@oxagen/oxagen/client-ip`, which carries the reasoning
 * about which headers are believed in which deployment shape).
 *
 * This took the LEFTMOST x-forwarded-for entry and then fell back to
 * x-real-ip. Behind the ALB the leftmost entry is whatever the caller typed
 * into the header, and nothing in front of this process sets x-real-ip at all
 * — so an MCP client could prefix an allowlisted address and satisfy an
 * IP-scoped mandate. The old comment called the headers spoofable and used
 * them anyway, which is the shape of the bug rather than a mitigation of it.
 *
 * SECURITY: authorization signal for IAM ip_ranges, never authentication.
 */
function extractClientIp(hdrs: HttpHeaders): string | null {
  return extractTrustedClientIp((name) => firstHeader(hdrs[name]), {
    trustedProxyCidrs: trustedProxyCidrs(),
    trustEdgeHeader: trustEdgeHeader(),
    onVercel: process.env.VERCEL === "1",
  });
}

/**
 * Resolves a CapabilityContext from the Authorization header of an MCP
 * request. Returns a typed result (never throws for auth failures) so a
 * non-throwing caller can translate to 401.
 *
 * @param authHeader - Raw value of the Authorization HTTP header.
 * @param requestId  - Trace-correlation id to stamp onto the context.
 * @param clientIp   - Client IP extracted from x-forwarded-for / x-real-ip.
 */
export async function resolveMcpContext(
  authHeader: string | undefined,
  requestId: string,
  clientIp: string | null = null,
  gatewaySessionUuid: string | null = null,
  gatewayChainGenesisHash: string | null = null,
): Promise<McpContextResolution> {
  const token = extractBearerToken(authHeader);
  if (!token) return { ok: false, reason: "unauthenticated" };

  // Cheap pre-filter: API keys carry an `ox_` prefix, so they always contain
  // an underscore. Better Auth session tokens are UUIDs (hex + hyphens only),
  // so they never do — they are rejected below without a DB round-trip.
  // resolveApiKey re-validates the prefix authoritatively.
  const isApiKey = token.includes("_");

  if (isApiKey) {
    const resolution = await resolveApiKey(token);
    if (!resolution.ok) {
      const reason: McpAuthFailure =
        resolution.kind === "expired"
          ? "expired_token"
          : resolution.kind === "workspace_archived"
            ? "workspace_archived"
            : resolution.kind === "sso_required"
              ? "sso_required"
              : "invalid_token";
      return { ok: false, reason };
    }

    // An API key must resolve to a non-empty org/workspace scope.
    // resolveApiKey() should never return ok:true with an empty orgId, but
    // if a data bug ever produced one, runInTenantScope's uuid guard would
    // still fail closed deep in the kernel — after a security event already
    // logged the request as a success. Reject the empty scope here instead,
    // so it never reaches the kernel or the audit log as a success.
    if (!resolution.orgId || !resolution.workspaceId) {
      return { ok: false, reason: "invalid_token" };
    }

    // SOC2 audit: record machine-credential usage. Fires once per MCP tool
    // invocation (buildContext runs per tool call) — the correct semantic for
    // an "api_key.used" access-log event. Fire-and-forget: an audit-pipeline
    // hiccup must never fail-closed a legitimately authenticated request.
    // `actorUserId` is the resolver's answer, not a constant: a CLI session
    // key acts for the person who approved `oxagen login` and every other key
    // acts for nobody. Hard-coding null recorded a person's call as belonging
    // to nobody while the access decision downstream was made against that
    // same person — an audit record that disagrees with the decision it is
    // supposed to evidence. ip is the resolved client IP.
    emitSecurityEvent({
      eventType: "api_key.used",
      actorUserId: resolution.userId,
      orgId: resolution.orgId,
      workspaceId: resolution.workspaceId,
      capability: null,
      outcome: "success",
      ip: clientIp,
      userAgent: null,
      requestId,
    });

    // The principal is the resolver's, not null. `resolveApiKey` resolves a
    // CLI session key (`cli_session_v1`) to the person who approved
    // `oxagen login`, re-checking their org and workspace membership on every
    // call, and resolves every other key to `userId: null` — so this widens
    // nothing except the one case it is for. Discarding it made one credential
    // authorize as two different principals depending on hostname: on
    // `api.oxagen.sh` `assertCallerRole` read the person's real role, and here
    // it short-circuited on `!ctx.userId` and, at the non-enterprise tier
    // where it is the only role gate, let a demoted member keep invoking
    // Owner/Admin-only capabilities.
    return {
      ok: true,
      ctx: {
        orgId: resolution.orgId,
        workspaceId: resolution.workspaceId,
        userId: resolution.userId,
        apiKeyId: resolution.apiKeyId,
        requestId,
        surface: "mcp",
        messageId: null,
        clientIp,
        gatewaySessionUuid,
        gatewayChainGenesisHash,
      },
    };
  }

  // Session token path -- MCP requires an API key to carry a fully-resolved
  // org/workspace scope. Session tokens (Better Auth opaque tokens) only
  // provide a userId; they carry no org/workspace context at all. Emitting
  // an empty orgId ("") would cause the kernel's runInTenantScope to throw
  // TenantScopeError (fail-closed), but that gives a confusing generic
  // denial. Reject here at the edge with invalid_token so the caller gets a
  // clear 401 rather than a cryptic 500/deny downstream.
  //
  // MCP clients authenticate with API keys (org+workspace scope baked into
  // the key). Browser sessions (app surface) use a different transport (the
  // /api/v1/chat/stream SSE route) where the session cookie is resolved
  // server-side with full tenant context. There is no legitimate MCP use
  // case for session-token auth.
  return { ok: false, reason: "invalid_token" };
}

/**
 * Build a CapabilityContext for an xmcp tool invocation from request headers.
 *
 * The single auth entrypoint for tools. Resolves real identity from the
 * validated Authorization credential and throws `McpUnauthorizedError`
 * (fail closed) when the request carries no valid principal.
 */
export async function buildContext(
  hdrs: HttpHeaders,
): Promise<CapabilityContext> {
  const authHeader = firstHeader(hdrs["authorization"]);
  const requestId = firstHeader(hdrs["x-request-id"]) ?? crypto.randomUUID();
  const clientIp = extractClientIp(hdrs);
  const gatewaySessionUuid = extractGatewaySession(hdrs);
  const gatewayChainGenesisHash = extractGatewayGenesis(hdrs);

  const resolution = await resolveMcpContext(
    authHeader,
    requestId,
    clientIp,
    gatewaySessionUuid,
    gatewayChainGenesisHash,
  );
  if (!resolution.ok) throw new McpUnauthorizedError(resolution.reason);
  return resolution.ctx;
}
