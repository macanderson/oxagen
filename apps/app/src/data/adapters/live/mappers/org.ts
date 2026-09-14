// Row mappers for the live organization adapter (Batch 3, lane A8).
//
// Each mapper turns what a store records into a *draft* of a view model. A field
// no store records today, or a stored value the spec vocabulary has no word for
// (a `clickhouse` data plane, a `build` plan tier), is left `null` in the draft:
// the mapper never fills it with a default, a zero or a guessed enum. `settle`
// then parses the drafts through the view-model schema. When every rejection
// sits on a field the mapper left null, the read is "not recorded yet"; when a
// value the mapper produced is rejected, that is a mapping defect and the read
// is an error. Once a contract accepts one of these fields as nullable, the
// same draft parses and the page shows the recorded rest of the row.
//
// Column-level notes, per view model, live beside each mapper.
import type { schema } from "@oxagen/database";
import type { z } from "zod";
import {
  type ApiKey,
  type DataPlane,
  type Invitation,
  type Member,
  type ModelFunding,
  type Money,
  OrgRole,
  type Organization,
  type Workspace,
  WorkspaceRole,
} from "@/data/contracts";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];
type UserRow = Row<typeof schema.users>;
type OrgUserRow = Row<typeof schema.orgUsers>;
type WorkspaceRow = Row<typeof schema.workspaces>;
type WorkspaceUserRow = Row<typeof schema.workspaceUsers>;
type InvitationRow = Row<typeof schema.invitations>;
type ApiKeyRow = Row<typeof schema.apiKeys>;

/** A view model with some fields widened to `null`: what the stores left unsaid. */
type Draft<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

// ---- Scalars -----------------------------------------------------------------

/** A timestamp as the view model's Instant (UTC, `Z`). */
export function instant(at: Date): string {
  return at.toISOString();
}

/** A timestamp as the view model's Day (the UTC calendar date). */
export function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The stored role, lowercased (both casings are written); null outside the spec's six. */
export function orgRoleOf(stored: string): OrgRole | null {
  const parsed = OrgRole.safeParse(stored.toLowerCase());
  return parsed.success ? parsed.data : null;
}

/** The stored workspace role, lowercased; null outside owner/member/viewer. */
export function workspaceRoleOf(stored: string): WorkspaceRole | null {
  const parsed = WorkspaceRole.safeParse(stored.toLowerCase());
  return parsed.success ? parsed.data : null;
}

const MICROS_PER_CENT = 10_000n;

/**
 * Billing credits as Money. A credit is one US cent (`billing.credit_ledger.delta_cents`,
 * `org_billing_settings.assistant_spend_cap_cents`). No basis is claimed: a
 * credit debit is what was billed, not a figure observed at the gateway.
 */
export function creditsAsMoney(cents: bigint | number): Money {
  return {
    micros: (BigInt(cents) * MICROS_PER_CENT).toString(),
    currency: "USD",
  };
}

// ---- Organization ------------------------------------------------------------

/**
 * `get_org_settings` (org.organizations.name, .slug) and the plan tier
 * `resolveOrgTier` settles (an entitled billing.subscriptions tier, else
 * organizations.plan_type). Not recorded: display and billing currency,
 * deployment mode, region, governance mode (App. A.3 puts it on workspaces) and
 * the attester key.
 */
export type OrganizationSource = {
  settings: { name: string; slug: string };
  /** `free | build | scale | enterprise` today. */
  tier: string;
};

export type OrganizationDraft = Draft<
  Organization,
  | "plan"
  | "displayCurrency"
  | "billingCurrency"
  | "deploymentMode"
  | "region"
  | "governanceMode"
  | "attesterKeyId"
>;

const PLAN_OF_TIER: Readonly<Record<string, Organization["plan"]>> = {
  free: "free",
  enterprise: "enterprise",
  // `build` and `scale` have no word in the spec's free/team/enterprise.
};

export function toOrganization(src: OrganizationSource): OrganizationDraft {
  return {
    slug: src.settings.slug,
    name: src.settings.name,
    plan: PLAN_OF_TIER[src.tier] ?? null,
    displayCurrency: null,
    billingCurrency: null,
    deploymentMode: null,
    region: null,
    governanceMode: null,
    attesterKeyId: null,
  };
}

// ---- Members -----------------------------------------------------------------

/**
 * One `org.org_users` row with its `auth.users` row, the person's
 * `workspace.workspace_users` memberships in this organization's workspaces, and
 * the latest `auth.sessions.updated_at` (Better Auth touches it on refresh).
 */
export type MemberSource = {
  membership: Pick<OrgUserRow, "role" | "joinedAt">;
  user: Pick<UserRow, "publicId" | "twoFactorEnabled">;
  workspaces: ReadonlyArray<{
    slug: WorkspaceRow["slug"];
    role: WorkspaceUserRow["role"];
  }>;
  lastSessionAt: Date | null;
};

export type MemberDraft = Omit<Member, "role" | "workspaces"> & {
  role: Member["role"] | null;
  workspaces: Array<{ slug: string; role: WorkspaceRole | null }>;
};

/**
 *   personId       auth.users.public_id (`usr_…`)
 *   role           lower(org.org_users.role)
 *   workspaces     workspace.workspace_users ⨝ workspace.workspaces (slug, lower(role))
 *   allWorkspaces  false: a workspace opens only to its workspace_users rows,
 *                  whatever the org role (server/viewer-resolution.ts)
 *   status         `active`: an org_users row is a joined member; an
 *                  invitation lives in org.invitations and a removal deletes the row
 *   lastActiveAt   max(auth.sessions.updated_at), null with no session on record
 *   mfa            `totp` when auth.users.two_factor_enabled; no passkey store exists
 *   sso            null: no SSO connection store exists, so no member signs in through one
 */
export function toMember(src: MemberSource): MemberDraft {
  return {
    personId: src.user.publicId,
    role: orgRoleOf(src.membership.role),
    workspaces: [...src.workspaces]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((w) => ({ slug: w.slug, role: workspaceRoleOf(w.role) })),
    allWorkspaces: false,
    status: "active",
    lastActiveAt: src.lastSessionAt ? instant(src.lastSessionAt) : null,
    mfa: src.user.twoFactorEnabled ? ["totp"] : [],
    sso: null,
  };
}

// ---- Invitations -------------------------------------------------------------

/** A pending, unexpired `org.invitations` row and its inviter's public id. */
export type InvitationSource = {
  invitation: Pick<InvitationRow, "email" | "role" | "createdAt" | "expiresAt">;
  inviterPublicId: UserRow["publicId"] | null;
};

export type InvitationDraft = Omit<
  Invitation,
  "role" | "invitedById" | "expiresOn"
> & {
  role: { scope: "org"; role: OrgRole | null };
  invitedById: string | null;
  expiresOn: string | null;
};

/**
 *   email        org.invitations.email
 *   role         { scope: org, role: lower(invitations.role) }. Every writer
 *                (add_org_member, send_workspace_invite) stores an org role and
 *                no workspace, so a workspace-scoped invitation is not recorded.
 *   invitedById  auth.users.public_id of invitations.invited_by_user_id
 *   sentOn       invitations.created_at (UTC day)
 *   expiresOn    invitations.expires_at (UTC day); null on a row written without one
 */
export function toInvitation(src: InvitationSource): InvitationDraft {
  const { invitation } = src;
  return {
    email: invitation.email,
    role: { scope: "org", role: orgRoleOf(invitation.role) },
    invitedById: src.inviterPublicId,
    sentOn: day(invitation.createdAt),
    expiresOn: invitation.expiresAt ? day(invitation.expiresAt) : null,
  };
}

// ---- Workspaces --------------------------------------------------------------

/** One `list_workspaces` item plus what the workspace's own scope records. */
export type WorkspaceSource = {
  workspace: { slug: string; name: string };
  /** `iam.principals` of kind agent, not deleted, in the workspace; null when not read. */
  agentCount: number | null;
  /** auth.users.public_id of the earliest workspace_users `owner`; null with none. */
  ownerPublicId: string | null;
};

export type WorkspaceDraft = Draft<
  Workspace,
  "mainRepo" | "productionBranch" | "linkedRepos" | "agentCount" | "ownerId"
>;

/**
 *   slug, name        list_workspaces (workspace.workspaces)
 *   agentCount        count(iam.principals) kind = agent, status <> deleted
 *   ownerId           the earliest workspace_users owner's auth.users.public_id
 *   mainRepo,
 *   productionBranch,
 *   linkedRepos       not recorded: ingestion.repository_bindings carries the
 *                     provider name and configured default ref, but no main or
 *                     linked role and no customer-confirmed production branch
 */
export function toWorkspace(src: WorkspaceSource): WorkspaceDraft {
  return {
    slug: src.workspace.slug,
    name: src.workspace.name,
    mainRepo: null,
    productionBranch: null,
    linkedRepos: null,
    agentCount: src.agentCount,
    ownerId: src.ownerPublicId,
  };
}

// ---- API keys ----------------------------------------------------------------

/**
 * A live `auth.api_keys` row. `key_hash` is deliberately absent from the type:
 * the store never selects it, and a mapper cannot leak what it never receives.
 */
export type ApiKeySource = {
  key: Pick<ApiKeyRow, "name" | "keyPrefix" | "lastUsedAt" | "expiresAt">;
  creatorPublicId: UserRow["publicId"] | null;
};

export type ApiKeyDraft = Draft<
  ApiKey,
  "principal" | "grants" | "createdById" | "uses30d" | "expiresOn"
>;

/** A key within this many days of its expiry reads `expiring`. */
export const API_KEY_EXPIRING_WITHIN_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * `expiring` when an expiry falls within the window (an expired key reads
 * `expiring` too until it is revoked), else `unused` when the key was never
 * presented, else `ok`.
 */
export function apiKeyStatus(
  key: Pick<ApiKeyRow, "lastUsedAt" | "expiresAt">,
  now: Date,
): ApiKey["status"] {
  if (
    key.expiresAt &&
    key.expiresAt.getTime() - now.getTime() <=
      API_KEY_EXPIRING_WITHIN_DAYS * DAY_MS
  )
    return "expiring";
  return key.lastUsedAt ? "ok" : "unused";
}

/**
 *   name        auth.api_keys.name
 *   maskedKey   api_keys.key_prefix + "…": only the prefix is stored, never the key
 *   principal   not recorded: a key authorizes as its creator; no principal column
 *   grants      not recorded: api_keys.scope is reserved (`{}`), no grant list
 *   createdById auth.users.public_id of api_keys.created_by_user_id
 *   lastUsedAt  api_keys.last_used_at
 *   uses30d     not recorded: no per-key use counter exists
 *   expiresOn   api_keys.expires_at (UTC day); null for a key without an expiry
 *   status      derived from expires_at and last_used_at (apiKeyStatus)
 */
export function toApiKey(src: ApiKeySource, now: Date): ApiKeyDraft {
  const { key } = src;
  return {
    name: key.name,
    maskedKey: `${key.keyPrefix}…`,
    principal: null,
    grants: null,
    createdById: src.creatorPublicId,
    lastUsedAt: key.lastUsedAt ? instant(key.lastUsedAt) : null,
    uses30d: null,
    expiresOn: key.expiresAt ? day(key.expiresAt) : null,
    status: apiKeyStatus(key, now),
  };
}

// ---- Data planes -------------------------------------------------------------

/** The redacted binding `get_data_plane` returns (org.data_planes, ADR-042). */
export type DataPlaneSource = {
  kind: "postgres" | "neo4j" | "clickhouse";
  mode: "shared" | "dedicated";
  status: "active" | "degraded" | "disabled";
};

export type DataPlaneDraft = Draft<
  DataPlane,
  "store" | "status" | "region" | "isolation"
>;

const STORE_OF_KIND: Readonly<Record<string, DataPlane["store"]>> = {
  postgres: "postgres",
  neo4j: "neo4j",
  // `clickhouse` has no word in the spec's postgres/neo4j/objects.
};
const STATUS_OF_PLANE: Readonly<Record<string, DataPlane["status"]>> = {
  active: "active",
  degraded: "degraded",
  // `disabled` has no word in the spec's active/degraded/rotating.
};

/**
 *   store      data_planes.kind (postgres, neo4j); clickhouse has no spec word
 *   mode       data_planes.mode
 *   status     data_planes.status (active, degraded); disabled has no spec word
 *   region,
 *   isolation  not recorded on a binding
 */
export function toDataPlane(src: DataPlaneSource): DataPlaneDraft {
  return {
    store: STORE_OF_KIND[src.kind] ?? null,
    mode: src.mode,
    status: STATUS_OF_PLANE[src.status] ?? null,
    region: null,
    isolation: null,
  };
}

// ---- Model funding -----------------------------------------------------------

export type ModelFundingSource = {
  /** The redacted view `get_model_credential` returns (org.model_credentials, ADR-053). */
  credential: { configured: boolean; status: "active" | "disabled" | null };
  /** org_billing_settings.assistant_spend_cap_cents; null means no cap. */
  capCents: number | null;
  /** consume_assistant_tokens credit debits since the start of the UTC month. */
  spentCents: bigint;
};

export type ModelFundingDraft = Draft<ModelFunding, "monthlyCap" | "routes">;

/**
 *   source          customer_key while a model credential is stored and active,
 *                   else platform: the rule resolveModelFundingSource applies
 *                   (a disabled row is answered as the platform key)
 *   monthlyCap      billing.org_billing_settings.assistant_spend_cap_cents; null
 *                   (no cap) has no Money to show
 *   usedThisMonth   assistantSpendThisMonth (billing.credit_ledger)
 *   routes          not recorded per organization: the tier table is code
 *                   (fast/balanced/precise), workspace.routing_policy holds the
 *                   market-router mode and thresholds, not routes
 */
export function toModelFunding(src: ModelFundingSource): ModelFundingDraft {
  const ownKey =
    src.credential.configured && src.credential.status === "active";
  return {
    source: ownKey ? "customer_key" : "platform",
    monthlyCap: src.capCents === null ? null : creditsAsMoney(src.capCents),
    usedThisMonth: creditsAsMoney(src.spentCents),
    routes: null,
  };
}

// ---- Settle ------------------------------------------------------------------

export type Settled<T> =
  | { kind: "ok"; value: T[] }
  /** Every rejection is a field the mapper left null: not recorded yet. */
  | { kind: "unrecorded"; paths: string[] }
  /** The schema rejected a value the mapper produced: a mapping defect. */
  | { kind: "mismatch"; paths: string[] };

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path
    .filter((k) => typeof k !== "number")
    .map(String)
    .join(".");
}

const sortedUnique = (paths: string[]) => [...new Set(paths)].sort();

/** Parse every draft through `view`, and say why when any fails. */
export function settle<T>(
  view: z.ZodType<T>,
  drafts: readonly unknown[],
): Settled<T> {
  const value: T[] = [];
  const unrecorded: string[] = [];
  const wrong: string[] = [];
  for (const draft of drafts) {
    const parsed = view.safeParse(draft);
    if (parsed.success) {
      value.push(parsed.data);
      continue;
    }
    for (const issue of parsed.error.issues) {
      const bucket = valueAt(draft, issue.path) === null ? unrecorded : wrong;
      bucket.push(fieldPath(issue.path));
    }
  }
  if (wrong.length > 0) return { kind: "mismatch", paths: sortedUnique(wrong) };
  if (unrecorded.length > 0)
    return { kind: "unrecorded", paths: sortedUnique(unrecorded) };
  return { kind: "ok", value };
}
