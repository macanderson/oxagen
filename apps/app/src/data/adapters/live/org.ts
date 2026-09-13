// The live organization adapter (Batch 3, lane A8).
//
// Contract-first: a read that exists as an agent tool goes through the kernel
// as the signed-in person, so the contract's handler, output schema and IAM
// apply. The rest reads Postgres inside the organization's tenant scope
// (runInTenantScope → withTenantDb, so RLS and the explicit org predicates both
// hold). Every read maps rows to drafts and settles them through the view model
// (./mappers/org.ts): a field today's stores do not record makes the read
// `not_backed`, never a fabricated value.
//
//   organization  get_org_settings + resolveOrgTier
//   members       org.org_users ⨝ auth.users, workspace.workspace_users per
//                 workspace scope, max(auth.sessions.updated_at)
//   invitations   org.invitations (pending, unexpired) ⨝ auth.users
//   workspaces    get_org_settings → list_workspaces, plus iam.principals and
//                 workspace_users per workspace scope
//   apiKeys       auth.api_keys per workspace scope (key_hash never selected)
//   dataPlanes    get_data_plane for postgres, neo4j and clickhouse
//   modelFunding  get_model_credential + org_billing_settings cap + credit ledger
//
// No read contract exists for members, invitations or API keys, so those three
// are tenant-scoped queries. `workspace.routing_policy` is not read: it holds
// the market router's mode and thresholds, and no view-model field maps to it.
//
// Access. The kernel's IAM check is skipped for organizations below the
// enterprise tier (packages/billing/src/tier.ts), so this adapter gates every
// read itself on the viewer's organization role, and still maps a kernel denial
// to `denied`: members and workspaces' names for any member; the roster,
// invitations, keys, data planes and funding for owners and admins (the roles
// the matching write contracts grant).
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import { orgDataPlaneGet } from "@oxagen/oxagen/contracts/org.data_plane.get";
import { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import { orgSettingsRead } from "@oxagen/oxagen/contracts/org.settings.read";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  max,
  ne,
  or,
} from "drizzle-orm";
import type { z } from "zod";
import { notBackedFor } from "@/data/backing";
import {
  ApiKey,
  DataPlane,
  Invitation,
  Member,
  ModelFunding,
  Organization,
  Workspace,
} from "@/data/contracts";
import { denied, type Read, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { MethodName, OrgReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID, type Scope } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";
import { getSession } from "@/server/session";
import { liveTenancyLookups } from "@/server/tenancy-lookups";
import {
  type ApiKeySource,
  type InvitationSource,
  type MemberSource,
  settle,
  toApiKey,
  toDataPlane,
  toInvitation,
  toMember,
  toModelFunding,
  toOrganization,
  toWorkspace,
} from "./mappers/org";

const ORGANIZATION = PAGE_FAILURES.organization;

/** The mapper produced a value the view model rejects: a defect, not an outage. */
export const ORG_RECORD_UNMAPPABLE = "org_record_unmappable";

/** Kernel codes that mean "this person may not read this", not "the store failed". */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
  "surface_denied",
  "capability_not_installed",
]);

export function isCapabilityDenial(error: unknown): boolean {
  return error instanceof CapabilityError && DENIAL_CODES.has(error.code);
}

/** Who may read a slice: any member, or owners and admins. */
export type OrgAccess = "member" | "admin";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** The guard every read passes: a member role, and for `admin` an owner or admin one. */
export function allows(access: OrgAccess, orgRole: string | null): boolean {
  if (orgRole === null) return false;
  return access === "member" || ADMIN_ROLES.has(orgRole.toLowerCase());
}

/** What one workspace's own scope records for the Organization page. */
export type WorkspaceFacts = {
  agentCount: number | null;
  ownerPublicId: string | null;
};

/** The tenant-scoped reads with no agent tool behind them. */
export type OrgStore = {
  planTier: (orgId: string) => Promise<string>;
  members: (orgId: string) => Promise<MemberSource[]>;
  invitations: (orgId: string, now: Date) => Promise<InvitationSource[]>;
  apiKeys: (orgId: string) => Promise<ApiKeySource[]>;
  workspaceFacts: (
    orgId: string,
    workspaceIds: readonly string[],
  ) => Promise<Map<string, WorkspaceFacts>>;
  assistantSpend: (
    orgId: string,
  ) => Promise<{ capCents: number | null; spentCents: bigint }>;
};

export type OrgInvoke = <I, O>(call: {
  scope: Scope;
  userId: string;
  contract: ToolContract<I, O>;
  input: NoInfer<I>;
}) => Promise<O>;

/** The view-model schemas reads settle through (injectable so a test can widen one). */
export type OrgViews = {
  Organization: z.ZodType<Organization>;
  Member: z.ZodType<Member>;
  Invitation: z.ZodType<Invitation>;
  Workspace: z.ZodType<Workspace>;
  ApiKey: z.ZodType<ApiKey>;
  DataPlane: z.ZodType<DataPlane>;
  ModelFunding: z.ZodType<ModelFunding>;
};

export type OrgLiveDeps = {
  /** The signed-in person's user id; null without a session. */
  principal: () => Promise<string | null>;
  /** The person's organization role, lowercase; null for a non-member. */
  orgRole: (orgId: string, userId: string) => Promise<string | null>;
  /** Invoke a read agent tool as `userId`; the result is parsed by the contract's output schema. */
  invoke: OrgInvoke;
  store: OrgStore;
  /** Where a failed or unmappable read is reported; the page gets a state. */
  report: (error: unknown, context: string) => void;
  now: () => Date;
  views?: OrgViews;
};

const DATA_PLANE_KINDS = ["postgres", "neo4j", "clickhouse"] as const;

type OrgMethod = MethodName<"org">;
type ReadContext = { scope: Scope; userId: string };

export function createLiveOrg(deps: OrgLiveDeps): OrgReadPort {
  const views: OrgViews = deps.views ?? {
    Organization,
    Member,
    Invitation,
    Workspace,
    ApiKey,
    DataPlane,
    ModelFunding,
  };

  async function readAll<T>(
    method: OrgMethod,
    access: OrgAccess,
    scope: Scope,
    view: z.ZodType<T>,
    load: (ctx: ReadContext) => Promise<unknown[]>,
  ): Promise<Read<T[]>> {
    // Organization pages run under the organization-only sentinel; a workspace
    // scope names the same organization, and org-level rows ignore it.
    const orgScope: Scope = {
      orgId: scope.orgId,
      workspaceId: ORG_ONLY_WORKSPACE_ID,
    };
    const userId = await deps.principal();
    if (userId === null) return denied(ORGANIZATION.permission);
    let drafts: unknown[];
    try {
      if (!allows(access, await deps.orgRole(scope.orgId, userId)))
        return denied(ORGANIZATION.permission);
      drafts = await load({ scope: orgScope, userId });
    } catch (error) {
      if (isCapabilityDenial(error)) return denied(ORGANIZATION.permission);
      deps.report(error, `org.${method} read failed`);
      return readError(ORGANIZATION.error.code, ORGANIZATION.error.status);
    }
    const settled = settle(view, drafts);
    switch (settled.kind) {
      case "ok":
        return readOk(settled.value);
      case "unrecorded":
        return notBackedFor("org", method);
      case "mismatch":
        deps.report(
          new Error(
            `org.${method}: view model rejects mapped fields ${settled.paths.join(", ")}`,
          ),
          `org.${method} unmappable`,
        );
        return readError(ORG_RECORD_UNMAPPABLE, 500);
    }
  }

  async function readOne<T>(
    method: OrgMethod,
    access: OrgAccess,
    scope: Scope,
    view: z.ZodType<T>,
    load: (ctx: ReadContext) => Promise<unknown>,
  ): Promise<Read<T>> {
    const res = await readAll(method, access, scope, view, async (ctx) => [
      await load(ctx),
    ]);
    if (!res.ok) return res;
    const [value] = res.value;
    return value === undefined
      ? readError(ORG_RECORD_UNMAPPABLE, 500)
      : readOk(value);
  }

  return {
    organization: (scope) =>
      readOne(
        "organization",
        "member",
        scope,
        views.Organization,
        async (ctx) => {
          const [settings, tier] = await Promise.all([
            deps.invoke({ ...ctx, contract: orgSettingsRead, input: {} }),
            deps.store.planTier(ctx.scope.orgId),
          ]);
          return toOrganization({ settings, tier });
        },
      ),

    members: (scope) =>
      readAll("members", "admin", scope, views.Member, async (ctx) =>
        (await deps.store.members(ctx.scope.orgId)).map(toMember),
      ),

    invitations: (scope) =>
      readAll("invitations", "admin", scope, views.Invitation, async (ctx) =>
        (await deps.store.invitations(ctx.scope.orgId, deps.now())).map(
          toInvitation,
        ),
      ),

    workspaces: (scope) =>
      readAll("workspaces", "member", scope, views.Workspace, async (ctx) => {
        const settings = await deps.invoke({
          ...ctx,
          contract: orgSettingsRead,
          input: {},
        });
        const { workspaces } = await deps.invoke({
          ...ctx,
          contract: workspaceList,
          input: { orgSlug: settings.slug },
        });
        const facts = await deps.store.workspaceFacts(
          ctx.scope.orgId,
          workspaces.map((w) => w.id),
        );
        return workspaces.map((workspace) =>
          toWorkspace({
            workspace,
            // A workspace the scoped reads did not see is never counted as zero agents.
            agentCount: facts.get(workspace.id)?.agentCount ?? null,
            ownerPublicId: facts.get(workspace.id)?.ownerPublicId ?? null,
          }),
        );
      }),

    apiKeys: (scope) =>
      readAll("apiKeys", "admin", scope, views.ApiKey, async (ctx) => {
        const now = deps.now();
        return (await deps.store.apiKeys(ctx.scope.orgId)).map((key) =>
          toApiKey(key, now),
        );
      }),

    dataPlanes: (scope) =>
      readAll("dataPlanes", "admin", scope, views.DataPlane, async (ctx) => {
        const bindings = await Promise.all(
          DATA_PLANE_KINDS.map((kind) =>
            deps.invoke({ ...ctx, contract: orgDataPlaneGet, input: { kind } }),
          ),
        );
        return bindings.map(toDataPlane);
      }),

    modelFunding: (scope) =>
      readOne(
        "modelFunding",
        "admin",
        scope,
        views.ModelFunding,
        async (ctx) => {
          const [credential, spend] = await Promise.all([
            deps.invoke({ ...ctx, contract: orgModelCredentialGet, input: {} }),
            deps.store.assistantSpend(ctx.scope.orgId),
          ]);
          return toModelFunding({ credential, ...spend });
        },
      ),
  };
}

// ---- Production I/O ------------------------------------------------------------

const orgOnly = (orgId: string): Scope => ({
  orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
});

/** Run `fn` in each workspace's own tenant scope (workspace_only and standard RLS). */
function perWorkspace<T>(
  orgId: string,
  workspaceIds: readonly string[],
  fn: (workspaceId: string) => Promise<T>,
): Promise<Array<{ workspaceId: string; value: T }>> {
  return Promise.all(
    workspaceIds.map(async (workspaceId) => ({
      workspaceId,
      value: await runInTenantScope({ orgId, workspaceId }, () =>
        fn(workspaceId),
      ),
    })),
  );
}

async function workspaceIdsOf(orgId: string): Promise<string[]> {
  const rows = await runInTenantScope(orgOnly(orgId), () =>
    withTenantDb((tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.orgId, orgId))
        .orderBy(asc(schema.workspaces.slug)),
    ),
  );
  return rows.map((r) => r.id);
}

/** workspace_users ⨝ workspaces ⨝ users for one workspace, earliest joiner first. */
function workspaceMembers(workspaceId: string) {
  const wu = schema.workspaceUsers;
  return withTenantDb((tx) =>
    tx
      .select({
        userId: wu.userId,
        role: wu.role,
        slug: schema.workspaces.slug,
        publicId: schema.users.publicId,
      })
      .from(wu)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, wu.workspaceId))
      .innerJoin(schema.users, eq(schema.users.id, wu.userId))
      .where(eq(wu.workspaceId, workspaceId))
      .orderBy(asc(wu.joinedAt)),
  );
}

export const postgresOrgStore: OrgStore = {
  async planTier(orgId) {
    const { resolveOrgTier } = await import("@oxagen/billing");
    return runInTenantScope(orgOnly(orgId), () => resolveOrgTier(orgId));
  },

  async members(orgId) {
    const ou = schema.orgUsers;
    const people = await runInTenantScope(orgOnly(orgId), () =>
      withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            userId: ou.userId,
            role: ou.role,
            joinedAt: ou.joinedAt,
            publicId: schema.users.publicId,
            twoFactorEnabled: schema.users.twoFactorEnabled,
          })
          .from(ou)
          .innerJoin(schema.users, eq(schema.users.id, ou.userId))
          .where(and(eq(ou.orgId, orgId), isNull(schema.users.deletedAt)))
          .orderBy(asc(ou.joinedAt));
        const userIds = rows.map((r) => r.userId);
        const sessions =
          userIds.length === 0
            ? []
            : await tx
                .select({
                  userId: schema.sessions.userId,
                  at: max(schema.sessions.updatedAt),
                })
                .from(schema.sessions)
                .where(inArray(schema.sessions.userId, userIds))
                .groupBy(schema.sessions.userId);
        return { rows, sessions };
      }),
    );
    const memberships = await perWorkspace(
      orgId,
      await workspaceIdsOf(orgId),
      workspaceMembers,
    );
    const lastSession = new Map(
      people.sessions.map((s) => [s.userId, s.at] as const),
    );
    return people.rows.map((row) => ({
      membership: { role: row.role, joinedAt: row.joinedAt },
      user: { publicId: row.publicId, twoFactorEnabled: row.twoFactorEnabled },
      workspaces: memberships.flatMap(({ value }) =>
        value
          .filter((m) => m.userId === row.userId)
          .map((m) => ({ slug: m.slug, role: m.role })),
      ),
      lastSessionAt: lastSession.get(row.userId) ?? null,
    }));
  },

  async invitations(orgId, now) {
    const inv = schema.invitations;
    const rows = await runInTenantScope(orgOnly(orgId), () =>
      withTenantDb((tx) =>
        tx
          .select({
            email: inv.email,
            role: inv.role,
            createdAt: inv.createdAt,
            expiresAt: inv.expiresAt,
            inviterPublicId: schema.users.publicId,
          })
          .from(inv)
          .leftJoin(schema.users, eq(schema.users.id, inv.invitedByUserId))
          .where(
            and(
              eq(inv.orgId, orgId),
              eq(inv.status, "pending"),
              or(isNull(inv.expiresAt), gt(inv.expiresAt, now)),
            ),
          )
          .orderBy(desc(inv.createdAt)),
      ),
    );
    return rows.map(({ inviterPublicId, ...invitation }) => ({
      invitation,
      inviterPublicId,
    }));
  },

  async apiKeys(orgId) {
    const k = schema.apiKeys;
    const perWs = await perWorkspace(
      orgId,
      await workspaceIdsOf(orgId),
      (workspaceId) =>
        withTenantDb((tx) =>
          tx
            // key_hash is never selected.
            .select({
              name: k.name,
              keyPrefix: k.keyPrefix,
              lastUsedAt: k.lastUsedAt,
              expiresAt: k.expiresAt,
              creatorPublicId: schema.users.publicId,
            })
            .from(k)
            .leftJoin(schema.users, eq(schema.users.id, k.createdByUserId))
            .where(
              and(
                eq(k.orgId, orgId),
                eq(k.workspaceId, workspaceId),
                isNull(k.deletedAt),
              ),
            )
            .orderBy(desc(k.createdAt)),
        ),
    );
    return perWs.flatMap(({ value }) =>
      value.map(({ creatorPublicId, ...key }) => ({ key, creatorPublicId })),
    );
  },

  async workspaceFacts(orgId, workspaceIds) {
    const p = schema.principals;
    const perWs = await perWorkspace(
      orgId,
      workspaceIds,
      async (workspaceId) => {
        const [agents, members] = await Promise.all([
          withTenantDb((tx) =>
            tx
              .select({ n: count() })
              .from(p)
              .where(
                and(
                  eq(p.orgId, orgId),
                  eq(p.workspaceId, workspaceId),
                  eq(p.kind, "agent"),
                  ne(p.status, "deleted"),
                ),
              ),
          ),
          workspaceMembers(workspaceId),
        ]);
        const owner = members.find((m) => m.role.toLowerCase() === "owner");
        return {
          agentCount: agents[0]?.n ?? null,
          ownerPublicId: owner?.publicId ?? null,
        };
      },
    );
    return new Map(perWs.map(({ workspaceId, value }) => [workspaceId, value]));
  },

  async assistantSpend(orgId) {
    const { assistantSpendThisMonth, getOrgBillingSettings } = await import(
      "@oxagen/billing"
    );
    // getOrgBillingSettings writes the default settings row when none exists,
    // exactly as the turn gate does, so the cap read is the cap enforced.
    return runInTenantScope(orgOnly(orgId), async () => {
      const [settings, spentCents] = await Promise.all([
        getOrgBillingSettings(orgId),
        assistantSpendThisMonth(orgId),
      ]);
      return { capCents: settings.assistantSpendCapCents, spentCents };
    });
  },
};

let handlersRegistered: Promise<unknown> | null = null;

/** A read agent tool through the kernel, as `userId`, parsed by its contract. */
export const kernelOrgInvoke: OrgInvoke = async ({
  scope,
  userId,
  contract,
  input,
}) => {
  // The handler registry must load before the first invoke(), or the kernel
  // finds no handler (the rule src/server/invoke.ts follows).
  handlersRegistered ??= import("@oxagen/handlers/register");
  await handlersRegistered;
  if (!getCapability(contract.name)) throw new ToolNotRegistered(contract.name);
  const ctx: CapabilityContext = {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };
  const raw = await runInTenantScope(scope, () =>
    invoke(contract.name, input, ctx),
  );
  const parsed = contract.output.safeParse(raw);
  if (!parsed.success)
    throw new ContractOutputMismatch(contract.name, parsed.error.issues);
  return parsed.data;
};

export async function reportToTelemetry(
  error: unknown,
  context: string,
): Promise<void> {
  try {
    const { captureError } = await import("@oxagen/telemetry");
    captureError({ error, source: "app", severity: "error", context });
  } catch {
    // Error capture must never become a new failure inside a read.
  }
}

export const liveOrgDeps: OrgLiveDeps = {
  async principal() {
    return (await getSession())?.user.id ?? null;
  },
  orgRole: (orgId, userId) => liveTenancyLookups.orgRole(orgId, userId),
  invoke: kernelOrgInvoke,
  store: postgresOrgStore,
  report: (error, context) => void reportToTelemetry(error, context),
  now: () => new Date(),
};

export const liveOrg: OrgReadPort = createLiveOrg(liveOrgDeps);
