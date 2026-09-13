// The Organization page: the org itself, people, invitations, workspaces,
// model funding, the data plane and API keys (spec §14, App. A.2–A.4).
import { z } from "zod";
import {
  Count,
  Currency,
  Day,
  Instant,
  Money,
  OrgRole,
  PublicId,
  Slug,
  WorkspaceRole,
} from "./common";

export const GovernanceMode = z.enum(["solo", "team", "regulated"]);
export type GovernanceMode = z.infer<typeof GovernanceMode>;

export const Organization = z.object({
  slug: Slug,
  name: z.string(),
  plan: z.enum(["free", "team", "enterprise"]),
  displayCurrency: Currency,
  billingCurrency: Currency,
  deploymentMode: z.enum(["cloud", "self_hosted"]),
  region: z.string(),
  governanceMode: GovernanceMode,
  /** The key that signs receipts and seals. */
  attesterKeyId: z.string(),
});
export type Organization = z.infer<typeof Organization>;

export const MfaFactor = z.enum(["passkey", "totp"]);
export type MfaFactor = z.infer<typeof MfaFactor>;

export const Member = z.object({
  personId: PublicId,
  role: OrgRole,
  /** Workspaces this member holds a role in; empty with `allWorkspaces` for org-wide roles. */
  workspaces: z.array(z.object({ slug: Slug, role: WorkspaceRole })),
  allWorkspaces: z.boolean(),
  status: z.enum(["invited", "active", "removed"]),
  lastActiveAt: Instant.nullable(),
  mfa: z.array(MfaFactor),
  sso: z.string().nullable(),
});
export type Member = z.infer<typeof Member>;

export const Invitation = z.object({
  email: z.email(),
  /** An org role, or a workspace role with its workspace. */
  role: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("org"), role: OrgRole }),
    z.object({
      scope: z.literal("workspace"),
      role: WorkspaceRole,
      workspaceSlug: Slug,
    }),
  ]),
  invitedById: PublicId,
  sentOn: Day,
  expiresOn: Day,
});
export type Invitation = z.infer<typeof Invitation>;

export const Workspace = z.object({
  slug: Slug,
  name: z.string(),
  mainRepo: z.string(),
  productionBranch: z.string(),
  linkedRepos: z.array(z.string()),
  agentCount: Count,
  ownerId: PublicId,
});
export type Workspace = z.infer<typeof Workspace>;

export const ApiKey = z.object({
  name: z.string(),
  /** The visible prefix and suffix; the secret is never returned. */
  maskedKey: z.string(),
  principal: z.string(),
  grants: z.array(z.string()).min(1),
  createdById: PublicId,
  lastUsedAt: Instant.nullable(),
  uses30d: Count,
  expiresOn: Day,
  status: z.enum(["ok", "expiring", "unused"]),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** `org.data_planes` (ADR-042). */
export const DataPlane = z.object({
  store: z.enum(["postgres", "neo4j", "objects"]),
  mode: z.enum(["shared", "dedicated"]),
  status: z.enum(["active", "degraded", "rotating"]),
  region: z.string(),
  isolation: z.string(),
});
export type DataPlane = z.infer<typeof DataPlane>;

export const RouteTier = z.enum(["complex", "light", "embed", "rerank"]);
export type RouteTier = z.infer<typeof RouteTier>;

/** `org.organizations.funding_source` + `model_routes` (spec §4.5). */
export const ModelFunding = z.object({
  source: z.enum(["platform", "customer_key"]),
  monthlyCap: Money,
  usedThisMonth: Money,
  routes: z.array(
    z.object({
      tier: RouteTier,
      route: z.string(),
      resolvesTo: z.string(),
      fallback: z.string().nullable(),
    }),
  ),
});
export type ModelFunding = z.infer<typeof ModelFunding>;
