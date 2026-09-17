import { z } from "zod";
import { registerCapability } from "../registry";

/** What the minted credential could reach (MC spec §6.8). */
export const credentialGrantScopeSchema = z.object({
  /** The server the credential was presented to. */
  endpointUrl: z.string(),
  /** `oauth` or `secret` — the stored credential's kind. */
  authKind: z.enum(["oauth", "secret"]),
  /**
   * How far the broker narrowed the credential for this use. `none` is the
   * stored credential used server-side for this connection only, never
   * handed to the agent (spec §6.8, last row).
   */
  downscope: z.enum([
    "token_exchange",
    "session_policy",
    "restricted_key",
    "none",
  ]),
});

export const credentialGrantItemSchema = z.object({
  /** `mcgr_…` */
  id: z.string(),
  /** `mcrd_…` — the connection (stored credential) the grant drew on. */
  connectionId: z.string(),
  /** `mcs_…` — the tool server it was presented to. */
  serverId: z.string(),
  serverName: z.string(),
  /** The governed run it served; null for a turn outside a run. */
  runId: z.string().nullable(),
  scope: credentialGrantScopeSchema,
  providerTokenId: z.string().nullable(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  /** `revoked` when revoked, `expired` past its TTL, else `active`. */
  status: z.enum(["active", "expired", "revoked"]),
});

export const credentialGrantList = registerCapability({
  name: "list_credential_grants",
  domain: "credential",
  description:
    "List the credential broker's grants for the workspace: every credential put to use for a tool server on behalf of a run, with the connection, the scope it could reach, its TTL and whether it is still live. Newest first, cursor-paged; never returns secret material.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: {},
  },
  input: z.object({
    /** Only grants drawn on this `mcrd_…` connection. */
    connectionId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  }),
  output: z.object({
    items: z.array(credentialGrantItemSchema),
    nextCursor: z.string().nullable(),
  }),
});

export type CredentialGrantListInput = z.output<
  typeof credentialGrantList.input
>;
export type CredentialGrantListOutput = z.output<
  typeof credentialGrantList.output
>;
export type CredentialGrantItem = z.output<typeof credentialGrantItemSchema>;
export type CredentialGrantScope = z.output<typeof credentialGrantScopeSchema>;
