// Contract test against a real Postgres: seeds a throwaway organization with a
// member in two workspaces, a pending and an expired invitation, a live and a
// revoked API key and an agent principal, reads them back through the store the
// live organization adapter uses, settles every row through its view model, and
// removes what it wrote. Opt-in, because unit runs have no database:
//
//   MC_LIVE_PG=1 DATABASE_URL=postgres://oxagen:…@localhost:5433/oxagen \
//     pnpm --filter @oxagen/app exec vitest run src/data/adapters/live/org.pg.test.ts
//
// The agent-tool reads (get_org_settings, list_workspaces, get_data_plane,
// get_model_credential) are proven by their own handler tests in packages/; this
// file proves the tenant-scoped queries that have no agent tool behind them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiKey,
  Count,
  Day,
  Invitation,
  Member,
  PublicId,
  Workspace,
} from "@/data/contracts";

const enabled = process.env.MC_LIVE_PG === "1";

describe.skipIf(!enabled)(
  "live organization store against Postgres",
  async () => {
    const { schema, withSystemDb } = await import("@oxagen/database");
    const { eq, inArray } = await import("drizzle-orm");
    const { postgresOrgStore } = await import("./org");
    const { settle, toApiKey, toInvitation, toMember, toWorkspace } =
      await import("./mappers/org");

    const tag = Date.now().toString(36).slice(-5);
    const orgId = crypto.randomUUID();
    const wsA = crypto.randomUUID();
    const wsB = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const viewerId = crypto.randomUUID();
    const NOW = new Date();
    const inAWeek = new Date(NOW.getTime() + 7 * 86_400_000);
    const lastWeek = new Date(NOW.getTime() - 7 * 86_400_000);
    const seenAt = new Date(NOW.getTime() - 3_600_000);
    let ownerPublicId = "";

    const widenedApiKey = ApiKey.extend({
      principal: z.string().nullable(),
      grants: z.array(z.string()).min(1).nullable(),
      uses30d: Count.nullable(),
      expiresOn: Day.nullable(),
      createdById: PublicId.nullable(),
    });
    const widenedWorkspace = Workspace.extend({
      mainRepo: z.string().nullable(),
      productionBranch: z.string().nullable(),
      linkedRepos: z.array(z.string()).nullable(),
    });

    beforeAll(async () => {
      console.info(
        `seeding organization rows into ${String(process.env.DATABASE_URL).replace(/:[^:@/]+@/, ":***@")}`,
      );
      await withSystemDb(async (tx) => {
        await tx.insert(schema.organizations).values({
          id: orgId,
          name: `MC live ${tag}`,
          slug: `mc-live-${tag}`,
          namespace: `m${tag}`,
          planType: "free",
          status: "active",
        });
        const [owner] = await tx
          .insert(schema.users)
          .values([
            {
              id: ownerId,
              email: `owner-${tag}@mc-live.test`,
              status: "active",
              twoFactorEnabled: true,
            },
            {
              id: viewerId,
              email: `viewer-${tag}@mc-live.test`,
              status: "active",
            },
          ])
          .returning({ publicId: schema.users.publicId });
        ownerPublicId = owner?.publicId ?? "";
        await tx.insert(schema.orgUsers).values([
          { orgId, userId: ownerId, role: "Owner", joinedAt: lastWeek },
          { orgId, userId: viewerId, role: "viewer", joinedAt: NOW },
        ]);
        await tx.insert(schema.workspaces).values([
          {
            id: wsA,
            orgId,
            name: "Core Platform",
            slug: "core-platform",
            namespace: "core",
          },
          {
            id: wsB,
            orgId,
            name: "Zeta Lab",
            slug: "zeta-lab",
            namespace: "zeta",
          },
        ]);
        await tx.insert(schema.workspaceUsers).values([
          {
            workspaceId: wsA,
            userId: ownerId,
            role: "owner",
            joinedAt: lastWeek,
          },
          { workspaceId: wsB, userId: ownerId, role: "Viewer", joinedAt: NOW },
        ]);
        await tx.insert(schema.sessions).values({
          id: `mc-live-${tag}`,
          userId: ownerId,
          token: `mc-live-token-${tag}`,
          expiresAt: inAWeek,
          updatedAt: seenAt,
        });
        await tx.insert(schema.invitations).values([
          {
            orgId,
            email: `pending-${tag}@mc-live.test`,
            role: "Member",
            status: "pending",
            invitedByUserId: ownerId,
            expiresAt: inAWeek,
          },
          {
            orgId,
            email: `stale-${tag}@mc-live.test`,
            role: "Member",
            status: "pending",
            invitedByUserId: ownerId,
            expiresAt: lastWeek,
          },
        ]);
        await tx.insert(schema.apiKeys).values([
          {
            orgId,
            workspaceId: wsA,
            keyPrefix: `oxk_mc_${tag}a`,
            keyHash: "not-a-real-hash",
            name: "ci-deployer",
            scope: {},
            createdByUserId: ownerId,
            lastUsedAt: seenAt,
          },
          {
            orgId,
            workspaceId: wsB,
            keyPrefix: `oxk_mc_${tag}b`,
            keyHash: "not-a-real-hash",
            name: "revoked",
            scope: {},
            deletedAt: NOW,
          },
        ]);
        await tx.insert(schema.principals).values([
          {
            orgId,
            workspaceId: wsA,
            kind: "agent",
            displayName: "release-manager",
          },
          {
            orgId,
            workspaceId: wsA,
            kind: "agent",
            displayName: "gone",
            status: "deleted",
          },
          {
            orgId,
            workspaceId: wsA,
            kind: "human",
            displayName: "Owner",
            parentUserId: ownerId,
          },
        ]);
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.principals)
          .where(eq(schema.principals.orgId, orgId));
        await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
        await tx
          .delete(schema.invitations)
          .where(eq(schema.invitations.orgId, orgId));
        await tx
          .delete(schema.sessions)
          .where(eq(schema.sessions.userId, ownerId));
        await tx
          .delete(schema.workspaceUsers)
          .where(inArray(schema.workspaceUsers.workspaceId, [wsA, wsB]));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.orgId, orgId));
        await tx
          .delete(schema.orgUsers)
          .where(eq(schema.orgUsers.orgId, orgId));
        await tx
          .delete(schema.orgBillingSettings)
          .where(eq(schema.orgBillingSettings.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
        await tx
          .delete(schema.users)
          .where(inArray(schema.users.id, [ownerId, viewerId]));
      });
    });

    it("reads the roster with workspace roles from each workspace and the last session", async () => {
      const settled = settle(
        Member,
        (await postgresOrgStore.members(orgId)).map(toMember),
      );
      expect(settled).toEqual({
        kind: "ok",
        value: [
          {
            personId: ownerPublicId,
            role: "owner",
            workspaces: [
              { slug: "core-platform", role: "owner" },
              { slug: "zeta-lab", role: "viewer" },
            ],
            allWorkspaces: false,
            status: "active",
            lastActiveAt: seenAt.toISOString(),
            mfa: ["totp"],
            sso: null,
          },
          expect.objectContaining({
            role: "viewer",
            workspaces: [],
            lastActiveAt: null,
            mfa: [],
          }),
        ],
      });
    });

    it("reads only the pending invitation that has not expired", async () => {
      const settled = settle(
        Invitation,
        (await postgresOrgStore.invitations(orgId, NOW)).map(toInvitation),
      );
      expect(settled).toEqual({
        kind: "ok",
        value: [
          {
            email: `pending-${tag}@mc-live.test`,
            role: { scope: "org", role: "member" },
            invitedById: ownerPublicId,
            sentOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            expiresOn: inAWeek.toISOString().slice(0, 10),
          },
        ],
      });
    });

    it("reads live API keys across workspaces, prefix only", async () => {
      const drafts = (await postgresOrgStore.apiKeys(orgId)).map((k) =>
        toApiKey(k, NOW),
      );
      expect(settle(ApiKey, drafts)).toMatchObject({ kind: "unrecorded" });
      expect(widenedApiKey.array().parse(drafts)).toEqual([
        {
          name: "ci-deployer",
          maskedKey: `oxk_mc_${tag}a…`,
          principal: null,
          grants: null,
          createdById: ownerPublicId,
          lastUsedAt: seenAt.toISOString(),
          uses30d: null,
          expiresOn: null,
          status: "ok",
        },
      ]);
    });

    it("counts live agents and names the workspace owner", async () => {
      const facts = await postgresOrgStore.workspaceFacts(orgId, [wsA, wsB]);
      expect(facts.get(wsA)).toEqual({ agentCount: 1, ownerPublicId });
      expect(facts.get(wsB)).toEqual({ agentCount: 0, ownerPublicId: null });
      const draft = toWorkspace({
        workspace: { slug: "core-platform", name: "Core Platform" },
        agentCount: facts.get(wsA)?.agentCount ?? null,
        ownerPublicId: facts.get(wsA)?.ownerPublicId ?? null,
      });
      expect(widenedWorkspace.parse(draft)).toMatchObject({
        agentCount: 1,
        ownerId: ownerPublicId,
      });
    });

    it("resolves the plan tier and the assistant cap and spend", async () => {
      await expect(postgresOrgStore.planTier(orgId)).resolves.toBe("free");
      const spend = await postgresOrgStore.assistantSpend(orgId);
      expect(spend.spentCents).toBe(0n);
      expect(spend.capCents === null || Number.isInteger(spend.capCents)).toBe(
        true,
      );
    });
  },
);
