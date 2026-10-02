/**
 * A workspace's creator is its Owner in IAM (#5182), against a real Postgres.
 *
 * Permission checks read `iam.principal_role_assignments`. Workspace creation
 * used to write only `workspace.workspace_users`, so every
 * `workspace: ["Owner"]` clause refused the creator once their org role was
 * gone. This file runs the real code and reads the real rows:
 *
 *   1. `create_org`'s order on one system transaction: `bootstrapOrgIAM`,
 *      then `bootstrapWorkspace`. The first workspace's creator holds the
 *      workspace Owner role on it.
 *   2. The real `create_workspace` handler, called from an org-only scope as
 *      the app and the API call it. The new workspace's creator holds the
 *      same role on it, and on no other workspace.
 *   3. The issue's reproduction: the creator's org role drops to member. The
 *      role gate admits them on their own workspace and refuses them on a
 *      workspace another person created.
 *   4. `get_operator_ranking` admits that workspace Owner, through its
 *      handler on every tier and through the kernel's IAM check in an
 *      Enterprise org.
 *
 * The three workspace seeders (the built-in agent, the default MCP registry,
 * the default environment) are stubbed: they write no IAM row, and each has
 * its own tests. So is the audit write the kernel's IAM check makes, because
 * this job runs no ClickHouse, and the security event `create_workspace`
 * records after its commit.
 *
 * CI: rls-integration job, "SCIM deprovision proof" step, which runs every
 * file in this directory. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/handlers exec vitest run --config vitest.integration.config.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertAuditEvent: vi.fn(async () => undefined),
    latestAuditChainHash: vi.fn(async () => ""),
    captureError: vi.fn(),
  };
});
vi.mock("@oxagen/database/security", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@oxagen/database/security")>();
  return { ...real, emitSecurityEventAsync: vi.fn(async () => undefined) };
});
vi.mock("../src/workspace-agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workspace-agents")>()),
  bootstrapWorkspaceAgents: vi.fn(async () => undefined),
}));
vi.mock("../src/workspace-registry-seed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workspace-registry-seed")>()),
  seedWorkspaceDefaultRegistry: vi.fn(async () => "mreg_stub"),
}));
vi.mock("../src/workspace-environment-seed", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/workspace-environment-seed")
  >()),
  seedWorkspaceDefaultEnvironment: vi.fn(async () => "env_stub"),
}));

import { withSystemDb } from "@oxagen/database";
import { checkIAM } from "@oxagen/iam/check-iam";
import { assertOrgRole } from "@oxagen/iam/org-role";
// The barrel registers every contract, so bootstrapOrgIAM seeds each grant
// the contracts declare, and each default effect below is the declared one.
import {
  type CapabilityContext,
  getCapability,
  ORG_ONLY_WORKSPACE_ID,
} from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { bootstrapOrgIAM, provisionMemberPrincipal } from "../src/iam-provision";
import {
  createOperatorRankingHandler,
  type OperatorRankingDeps,
} from "../src/spend.operator_ranking";
import { bootstrapWorkspace } from "../src/workspace-bootstrap";
import { createWorkspaceCreateHandler } from "../src/workspace.create";

/** Rows from one statement through the system seam, which bypasses RLS. */
async function q(statement: SQL): Promise<Record<string, unknown>[]> {
  const rows = await withSystemDb((tx) => tx.execute(statement));
  return rows as unknown as Record<string, unknown>[];
}

const RUN = randomBytes(3).toString("hex");
const ORG = randomUUID();
/** Creates the org and its first workspace, then loses the org Owner role. */
const ANA = randomUUID();
/** An org Admin who creates a workspace of her own. */
const BEA = randomUUID();
const RANKING = "get_operator_ranking";

/** Filled in as the org and its workspaces are created. */
const ids = {
  firstWorkspace: "",
  anaWorkspace: "",
  beaWorkspace: "",
  anaPrincipal: "",
  beaPrincipal: "",
};

function ctxFor(
  userId: string,
  workspaceId: string,
): CapabilityContext {
  return {
    orgId: ORG,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: `req_${RUN}`,
    surface: "api",
    messageId: null,
  };
}

/** Every live assignment in the org, as (principal, role name, scope, workspace). */
async function assignments() {
  const rows = await q(sql`
    SELECT pra.principal_id, r.name AS role, r.scope_kind, pra.workspace_id,
           pra.assigned_by, pra.created_by_id
    FROM iam.principal_role_assignments AS pra
    JOIN iam.roles AS r ON r.id = pra.role_id
    WHERE pra.org_id = ${ORG} AND pra.deleted_at IS NULL
  `);
  return rows as Array<{
    principal_id: string;
    role: string;
    scope_kind: string;
    workspace_id: string | null;
    assigned_by: string | null;
    created_by_id: string | null;
  }>;
}

/** The internal id of the workspace with this slug in the org. */
async function workspaceId(slug: string): Promise<string> {
  const [row] = await q(sql`
    SELECT id FROM workspace.workspaces WHERE org_id = ${ORG} AND slug = ${slug}
  `);
  if (!row) throw new Error(`no workspace ${slug}`);
  return row["id"] as string;
}

/** The real create_workspace handler, from an org-only scope. */
async function createWorkspace(userId: string, slug: string): Promise<string> {
  const handler = createWorkspaceCreateHandler({
    requestProvision: async () => undefined,
  });
  await runInTenantScope({ orgId: ORG, workspaceId: ORG_ONLY_WORKSPACE_ID }, () =>
    handler({ name: slug, slug }, ctxFor(userId, ORG_ONLY_WORKSPACE_ID)),
  );
  return workspaceId(slug);
}

/** The ranking handler with the gate real and every read empty. */
function rankingHandler() {
  const deps = {
    readClaims: vi.fn(async () => []),
    readOperatorSpend: vi.fn(async () => ({ rows: [], partial: new Set<string | null>() })),
    readOperatorFacts: vi.fn(async () => new Map()),
    readPolicy: vi.fn(async () => ({ pseudonyms: false, salt: null })),
    readRuns: vi.fn(async () => []),
    priceSegments: vi.fn(async () => new Map()),
    readOrders: vi.fn(async () => []),
  } satisfies OperatorRankingDeps;
  return { deps, handler: createOperatorRankingHandler(deps) };
}

/** The kernel's IAM answer for `userId` calling the ranking in a workspace, in an Enterprise org. */
async function kernelDecides(userId: string, workspace: string) {
  const contract = getCapability(RANKING);
  if (!contract) throw new Error(`${RANKING} is not registered`);
  const ctx: CapabilityContext = {
    ...ctxFor(userId, workspace),
    planTier: "enterprise",
  };
  const { result } = await runInTenantScope(
    { orgId: ORG, workspaceId: workspace },
    () =>
      checkIAM({
        capability: RANKING,
        ctx,
        defaultEffect: contract.defaultEffect,
        rawInputJson: "{}",
      }),
  );
  return { outcome: result.outcome, rule: result.trace.decidedBy.rule };
}

beforeAll(async () => {
  for (const [id, name] of [
    [ANA, "ana"],
    [BEA, "bea"],
  ] as const) {
    await q(sql`
      INSERT INTO auth.users (id, public_id, email, status, email_verified)
      VALUES (${id}, ${`usr_${RUN}${name}`}, ${`${name}-${RUN}@owner.test`}, 'active', true)
    `);
  }

  // create_org's writes, in its order, on one system transaction.
  const first = await withSystemDb(async (tx) => {
    await tx.execute(sql`
      INSERT INTO org.organizations (id, public_id, name, slug, namespace, plan_type, status, type, created_by_id, updated_by_id)
      VALUES (${ORG}, ${`own_org_${RUN}`}, 'Owner Org', ${`own-org-${RUN}`}, ${`o${RUN.slice(0, 5)}`}, 'free', 'active', 'business', ${ANA}, ${ANA})
    `);
    await tx.execute(sql`
      INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
      VALUES (${`oru_${RUN}ana`}, ${ORG}, ${ANA}, 'owner', now())
    `);
    await bootstrapOrgIAM({ orgId: ORG, ownerUserId: ANA, actorUserId: ANA, tx });
    return bootstrapWorkspace({
      tx,
      orgId: ORG,
      userId: ANA,
      name: "Default",
      slug: `default-${RUN}`,
    });
  });
  ids.firstWorkspace = first.id;

  // Bea joins as an org Admin, the way an accepted invite and a role change
  // leave her: a principal with no role, then the org Admin role.
  await withSystemDb(async (tx) => {
    await tx.execute(sql`
      INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
      VALUES (${`oru_${RUN}bea`}, ${ORG}, ${BEA}, 'admin', now())
    `);
    ids.beaPrincipal = await provisionMemberPrincipal({
      orgId: ORG,
      userId: BEA,
      actorUserId: ANA,
      tx,
    });
  });
  await q(sql`
    INSERT INTO iam.principal_role_assignments (public_id, principal_id, role_id, org_id, workspace_id)
    SELECT ${`pra_${RUN}beaadmin`}, ${ids.beaPrincipal}, r.id, ${ORG}, NULL
    FROM iam.roles AS r
    WHERE r.org_id = ${ORG} AND r.scope_kind = 'org' AND r.name = 'Admin'
  `);
  const [ana] = await q(sql`
    SELECT id FROM iam.principals
    WHERE org_id = ${ORG} AND parent_user_id = ${ANA} AND kind = 'human'
  `);
  ids.anaPrincipal = ana?.["id"] as string;
});

describe("#5182: a workspace's creator holds the workspace Owner role in IAM", () => {
  it("create_org gives the first workspace's creator the Owner role on it", async () => {
    const onFirst = (await assignments()).filter(
      (a) => a.workspace_id === ids.firstWorkspace,
    );
    expect(onFirst).toEqual([
      {
        principal_id: ids.anaPrincipal,
        role: "Owner",
        scope_kind: "workspace",
        workspace_id: ids.firstWorkspace,
        assigned_by: ANA,
        created_by_id: ANA,
      },
    ]);
  });

  it("create_workspace gives its creator the Owner role on the new workspace and on no other", async () => {
    ids.anaWorkspace = await createWorkspace(ANA, `ana-${RUN}`);
    ids.beaWorkspace = await createWorkspace(BEA, `bea-${RUN}`);

    const scoped = (await assignments()).filter((a) => a.workspace_id !== null);
    const held = (principal: string) =>
      scoped
        .filter((a) => a.principal_id === principal)
        .map((a) => `${a.scope_kind}:${a.role}:${a.workspace_id}`)
        .sort();
    expect(held(ids.anaPrincipal)).toEqual(
      [
        `workspace:Owner:${ids.firstWorkspace}`,
        `workspace:Owner:${ids.anaWorkspace}`,
      ].sort(),
    );
    expect(held(ids.beaPrincipal)).toEqual([
      `workspace:Owner:${ids.beaWorkspace}`,
    ]);
    const bea = scoped.find((a) => a.workspace_id === ids.beaWorkspace);
    expect(bea?.assigned_by).toBe(BEA);
  });

  it("admits a creator whose org role is member on their workspace, and refuses them on another", async () => {
    // The reproduction: Ana's org role drops to member.
    await q(sql`
      UPDATE iam.principal_role_assignments SET deleted_at = now()
      WHERE principal_id = ${ids.anaPrincipal} AND workspace_id IS NULL
    `);
    await q(sql`
      UPDATE org.org_users SET role = 'member'
      WHERE org_id = ${ORG} AND user_id = ${ANA}
    `);
    const [membership] = await q(sql`
      SELECT role FROM workspace.workspace_users
      WHERE workspace_id = ${ids.anaWorkspace} AND user_id = ${ANA}
    `);
    expect(membership?.["role"]).toBe("owner");

    const gate = (workspace: string, workspaceRoles?: string[]) =>
      runInTenantScope({ orgId: ORG, workspaceId: workspace }, () =>
        assertOrgRole(
          { orgId: ORG, workspaceId: workspace, userId: ANA },
          {
            org: ["Owner", "Admin"],
            ...(workspaceRoles ? { workspace: workspaceRoles } : {}),
          },
        ),
      );

    await expect(gate(ids.anaWorkspace, ["Owner"])).resolves.toBe("Owner");
    await expect(gate(ids.firstWorkspace, ["Owner"])).resolves.toBe("Owner");
    // Bea's workspace: Ana holds no role there.
    await expect(gate(ids.beaWorkspace, ["Owner"])).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    // The Owner role is held on the workspace, not across the org.
    await expect(gate(ids.anaWorkspace)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
  });

  it("get_operator_ranking admits a workspace Owner on their workspace and refuses them on another", async () => {
    const own = rankingHandler();
    const out = await runInTenantScope(
      { orgId: ORG, workspaceId: ids.anaWorkspace },
      () =>
        own.handler(
          { period: { from: "2026-09-01", to: "2026-09-30" } },
          ctxFor(ANA, ids.anaWorkspace),
        ),
    );
    expect(out.operators).toEqual([]);
    expect(own.deps.readClaims).toHaveBeenCalledTimes(1);

    const other = rankingHandler();
    await expect(
      runInTenantScope({ orgId: ORG, workspaceId: ids.beaWorkspace }, () =>
        other.handler(
          { period: { from: "2026-09-01", to: "2026-09-30" } },
          ctxFor(ANA, ids.beaWorkspace),
        ),
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(other.deps.readClaims).not.toHaveBeenCalled();
  });

  it("the kernel admits that workspace Owner to the ranking in an Enterprise org, on their workspace only", async () => {
    await expect(kernelDecides(ANA, ids.anaWorkspace)).resolves.toEqual({
      outcome: "allow",
      rule: "7:role_grant",
    });
    await expect(kernelDecides(ANA, ids.beaWorkspace)).resolves.toEqual({
      outcome: "deny",
      rule: "8:default",
    });
  });
});
