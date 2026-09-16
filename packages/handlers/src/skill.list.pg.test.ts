// list_skills against a real Postgres, on a tier-free org: the role gate
// reads real role rows (an Owner reads, a Billing member is refused, an API
// key acts as its creator, a key with no creator is refused); another
// workspace's sessions are never counted; a null inventory counts as not
// reported while an empty one counts as reported with no names; a name listed
// twice in one inventory counts that session once; and the window includes
// its start and excludes its end. Runs wherever DATABASE_URL points at a
// migrated database — CI's `test` job migrates Postgres with Atlas before
// `turbo run build test:unit`; a local run without one is skipped, not red.
// Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { skillList } from "@oxagen/oxagen/contracts/skill.list";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { createSkillListHandler, postgresSkillQueries } from "./skill.list";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("list_skills against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const billingId = crypto.randomUUID();
  const keys = {
    owner: crypto.randomUUID(),
    billing: crypto.randomUUID(),
    orphan: crypto.randomUUID(),
  };
  const NOW = new Date("2026-09-15T12:00:00.000Z");
  const handler = createSkillListHandler({
    queries: postgresSkillQueries,
    now: () => NOW,
  });

  const call = (over: Partial<CapabilityContext>, input: unknown = {}) => {
    const ctx: CapabilityContext = {
      orgId,
      workspaceId,
      userId: ownerId,
      apiKeyId: null,
      requestId: `req-${tag}`,
      surface: "api",
      messageId: null,
      ...over,
    };
    return runInTenantScope({ orgId, workspaceId: ctx.workspaceId }, () =>
      handler(skillList.input.parse(input), ctx),
    );
  };

  let seq = 0;
  const session = (over: {
    startedAt: string;
    skills: unknown;
    harness?: string;
    workspaceId?: string;
  }) => {
    seq += 1;
    const sessionUuid = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      publicId: `tse_${tag}${String(seq).padStart(14, "0")}`,
      orgId,
      workspaceId: over.workspaceId ?? workspaceId,
      sessionUuid,
      harnessSessionId: `sess-${seq}-${tag}`,
      agentKey: `skills.core.bot-${tag}`,
      rootSessionUuid: sessionUuid,
      runtime: "claude-code",
      harness: over.harness ?? "claude-code",
      skillsAvailable: over.skills,
      startedAt: new Date(over.startedAt),
      lastEventAt: new Date(over.startedAt),
    };
  };

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        {
          id: ownerId,
          email: `skills-owner-${tag}@handlers.test`,
          status: "active",
        },
        {
          id: billingId,
          email: `skills-billing-${tag}@handlers.test`,
          status: "active",
        },
      ]);
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Skills ${tag}`,
        slug: `skills-${tag}`,
        namespace: `s${tag.slice(0, 5)}`,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values([
        {
          id: workspaceId,
          orgId,
          name: "Core",
          slug: "core",
          namespace: "core",
        },
        {
          id: otherWorkspaceId,
          orgId,
          name: "Edge",
          slug: "edge",
          namespace: "edge",
        },
      ]);
      for (const [userId, roleName] of [
        [ownerId, "Owner"],
        [billingId, "Billing"],
      ] as const) {
        const [principal] = await tx
          .insert(schema.principals)
          .values({
            orgId,
            kind: "human",
            displayName: roleName,
            status: "active",
            parentUserId: userId,
          })
          .returning({ id: schema.principals.id });
        const [role] = await tx
          .insert(schema.roles)
          .values({ orgId, scopeKind: "org", name: roleName })
          .returning({ id: schema.roles.id });
        if (!principal || !role)
          throw new Error("fixture insert returned no row");
        await tx.insert(schema.principalRoleAssignments).values({
          principalId: principal.id,
          roleId: role.id,
          orgId,
        });
      }
      await tx.insert(schema.apiKeys).values(
        (
          [
            ["owner", ownerId],
            ["billing", billingId],
            ["orphan", null],
          ] as const
        ).map(([name, createdByUserId]) => ({
          id: keys[name],
          orgId,
          workspaceId,
          keyPrefix: `oxk_${tag}_${name}`,
          keyHash: `hash-${tag}-${name}`,
          name: `skills ${name} ${tag}`,
          scope: {},
          createdByUserId,
        })),
      );
      await tx.insert(schema.tachoSessions).values([
        session({
          startedAt: "2026-09-10T09:00:00.000Z",
          skills: ["release-notes", "triage"],
        }),
        session({
          startedAt: "2026-09-12T09:00:00.000Z",
          harness: "codex",
          skills: ["release-notes", "release-notes"],
        }),
        session({ startedAt: "2026-09-13T09:00:00.000Z", skills: [] }),
        session({ startedAt: "2026-09-15T09:00:00.000Z", skills: null }),
        // The window's first instant is inside it; its last is not.
        session({
          startedAt: "2026-08-16T12:00:00.000Z",
          skills: ["edge-from"],
        }),
        session({ startedAt: "2026-09-15T12:00:00.000Z", skills: ["edge-to"] }),
        session({ startedAt: "2026-08-01T09:00:00.000Z", skills: ["old"] }),
        session({
          startedAt: "2026-09-11T09:00:00.000Z",
          skills: ["other-workspace"],
          workspaceId: otherWorkspaceId,
        }),
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.tachoSessions)
        .where(eq(schema.tachoSessions.orgId, orgId));
      await tx
        .delete(schema.apiKeys)
        .where(inArray(schema.apiKeys.id, Object.values(keys)));
      await tx
        .delete(schema.principalRoleAssignments)
        .where(eq(schema.principalRoleAssignments.orgId, orgId));
      await tx
        .delete(schema.principals)
        .where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
      await tx
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.orgId, orgId));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      await tx
        .delete(schema.users)
        .where(inArray(schema.users.id, [ownerId, billingId]));
    });
    await closeDatabase();
  });

  it("counts this workspace's sessions in the window, a null inventory as not reported and an empty one as reported", async () => {
    const out = await call({});
    expect(out.window).toEqual({
      from: "2026-08-16T12:00:00.000Z",
      to: "2026-09-15T12:00:00.000Z",
    });
    expect(out.sessions).toBe(5);
    expect(out.reportedSessions).toBe(4);
    expect(out.notReportedSessions).toBe(1);
    expect(out.nextCursor).toBeNull();
    expect(out.skills).toEqual([
      {
        name: "edge-from",
        sessions: 1,
        harnesses: ["claude-code"],
        firstSeenAt: "2026-08-16T12:00:00.000Z",
        lastSeenAt: "2026-08-16T12:00:00.000Z",
      },
      {
        name: "release-notes",
        sessions: 2,
        harnesses: ["claude-code", "codex"],
        firstSeenAt: "2026-09-10T09:00:00.000Z",
        lastSeenAt: "2026-09-12T09:00:00.000Z",
      },
      {
        name: "triage",
        sessions: 1,
        harnesses: ["claude-code"],
        firstSeenAt: "2026-09-10T09:00:00.000Z",
        lastSeenAt: "2026-09-10T09:00:00.000Z",
      },
    ]);
    expect(skillList.output.parse(out)).toEqual(out);
  });

  it("never counts another workspace's sessions (negative)", async () => {
    const out = await call({ workspaceId: otherWorkspaceId });
    expect(out.sessions).toBe(1);
    expect(out.skills.map((s) => s.name)).toEqual(["other-workspace"]);
    const own = await call({});
    expect(own.skills.map((s) => s.name)).not.toContain("other-workspace");
  });

  it("answers a null reported count, never a zero, for a window whose only session reported no inventory", async () => {
    const out = await call({}, { windowDays: 1 });
    expect(out.sessions).toBe(1);
    expect(out.reportedSessions).toBeNull();
    expect(out.notReportedSessions).toBe(1);
    expect(out.skills).toEqual([]);
  });

  it("refuses an org member without a listed role (negative)", async () => {
    await expect(call({ userId: billingId })).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
  });

  it("lets an API key act as a creator who holds the role", async () => {
    const out = await call({ userId: null, apiKeyId: keys.owner });
    expect(out.sessions).toBe(5);
  });

  it("refuses an API key whose creator lacks the role (negative)", async () => {
    await expect(
      call({ userId: null, apiKeyId: keys.billing }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
  });

  it("refuses an API key with no creator (negative)", async () => {
    await expect(
      call({ userId: null, apiKeyId: keys.orphan }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
  });
});
