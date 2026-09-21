// list_skills against a real Postgres, on a tier-free org: the role gate
// reads real role rows (an Owner reads, a Billing member is refused, an API
// key acts as its creator, a key with no creator is refused); another
// workspace's sessions are never counted; a null inventory counts as not
// reported while an empty one counts as reported with no names; a name listed
// twice in one inventory counts that session once; the window includes its
// start and excludes its end; a session with an empty harness label neither
// fails the read nor gets dropped; and a skill's harness list is capped with
// its true distinct count carried past the cap (ADR-104, #3103). Runs
// wherever DATABASE_URL points at a migrated database — CI's `test` job
// migrates Postgres with Atlas before `turbo run build test:unit`; a local
// run without one is skipped, not red. Every row it writes is removed in
// afterAll.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  SKILL_HARNESS_CAP,
  skillList,
} from "@oxagen/oxagen/contracts/skill.list";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { createSkillListHandler, postgresSkillQueries } from "./skill.list";

const concurrent = vi.hoisted(() => ({
  afterInventoryRead: null as (() => Promise<void>) | null,
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb: typeof real.withTenantDb = async (fn) => {
    const value = await real.withTenantDb(fn);
    const record = value as unknown as { totals?: unknown };
    const isInventory =
      record?.totals !== undefined ||
      (Array.isArray(value) &&
        value[0] !== null &&
        typeof value[0] === "object" &&
        "sessions" in value[0] &&
        "reported" in value[0]);
    if (isInventory && concurrent.afterInventoryRead) {
      const commit = concurrent.afterInventoryRead;
      concurrent.afterInventoryRead = null;
      await commit();
    }
    return value;
  };
  return { ...real, withTenantDb, withOrgDb: real.withOrgDb };
});

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
        ).map(([name, createdById]) => ({
          id: keys[name],
          orgId,
          workspaceId,
          keyPrefix: `oxk_${tag}_${name}`,
          keyHash: `hash-${tag}-${name}`,
          name: `skills ${name} ${tag}`,
          scope: {},
          createdById,
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
        // Harness aggregation fixtures (#3103), dated outside the default
        // 30-day window so they don't perturb the counts above; read directly
        // against a matching window in the dedicated test below.
        session({
          startedAt: "2026-07-01T09:00:00.000Z",
          harness: "",
          skills: ["quiet-harness"],
        }),
        session({
          startedAt: "2026-07-01T09:05:00.000Z",
          harness: "claude-code\ncodex",
          skills: ["loud-harness"],
        }),
        ...Array.from({ length: SKILL_HARNESS_CAP + 1 }, (_, i) =>
          session({
            startedAt: "2026-07-01T09:10:00.000Z",
            harness: `harness-${String(i + 1).padStart(2, "0")}`,
            skills: ["many-harness"],
          }),
        ),
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
        harnessCount: 1,
        firstSeenAt: "2026-08-16T12:00:00.000Z",
        lastSeenAt: "2026-08-16T12:00:00.000Z",
      },
      {
        name: "release-notes",
        sessions: 2,
        harnesses: ["claude-code", "codex"],
        harnessCount: 2,
        firstSeenAt: "2026-09-10T09:00:00.000Z",
        lastSeenAt: "2026-09-12T09:00:00.000Z",
      },
      {
        name: "triage",
        sessions: 1,
        harnesses: ["claude-code"],
        harnessCount: 1,
        firstSeenAt: "2026-09-10T09:00:00.000Z",
        lastSeenAt: "2026-09-10T09:00:00.000Z",
      },
    ]);
    expect(skillList.output.parse(out)).toEqual(out);
  });

  it("keeps counts and rows together when ingestion commits after the first inventory read", async () => {
    const window = {
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-02T00:00:00Z"),
    };
    const late = session({
      startedAt: "2026-06-01T12:00:00Z",
      skills: ["late-arrival"],
    });
    concurrent.afterInventoryRead = async () => {
      await withSystemDb((tx) => tx.insert(schema.tachoSessions).values(late));
    };
    const cursor = Buffer.from(
      JSON.stringify([window.from.toISOString(), window.to.toISOString(), "a"]),
    ).toString("base64url");
    try {
      const before = await call({}, { cursor });
      expect(before.sessions).toBe(0);
      expect(before.skills).toEqual([]);
      const after = await call({}, { cursor });
      expect(after.sessions).toBe(1);
      expect(after.skills).toHaveLength(1);
      expect(after.skills[0]?.name).toBe("late-arrival");
    } finally {
      concurrent.afterInventoryRead = null;
      await withSystemDb((tx) =>
        tx
          .delete(schema.tachoSessions)
          .where(eq(schema.tachoSessions.id, late.id)),
      );
    }
  });

  it("keeps a session with an empty or newline-bearing harness label, and caps a skill's harness list while carrying its true count (#3103)", async () => {
    const window = {
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-02T00:00:00.000Z"),
    };
    const { rows } = await runInTenantScope({ orgId, workspaceId }, () =>
      postgresSkillQueries.read({ orgId, workspaceId }, window, {
        after: null,
        limit: 100,
      }),
    );
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

    // An empty harness label round-trips whole, never fails the read.
    expect(byName["quiet-harness"]?.harnesses).toEqual([""]);
    expect(byName["quiet-harness"]?.harnessCount).toBe(1);

    // A harness label containing a newline is never re-split into invented labels.
    expect(byName["loud-harness"]?.harnesses).toEqual(["claude-code\ncodex"]);
    expect(byName["loud-harness"]?.harnessCount).toBe(1);

    // A skill with more than SKILL_HARNESS_CAP distinct harnesses is capped in
    // the returned list; harnessCount still carries the true distinct count.
    expect(byName["many-harness"]?.harnesses).toEqual(
      Array.from(
        { length: SKILL_HARNESS_CAP },
        (_, i) => `harness-${String(i + 1).padStart(2, "0")}`,
      ),
    );
    expect(byName["many-harness"]?.harnessCount).toBe(SKILL_HARNESS_CAP + 1);
    expect(byName["many-harness"]?.sessions).toBe(SKILL_HARNESS_CAP + 1);
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
