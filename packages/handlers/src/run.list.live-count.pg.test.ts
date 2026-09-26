// The workspace's live count (list_runs `liveRuns`, Fleet's Live runs tile)
// against a real Postgres. The unit tests check the count's SQL as text; this
// runs it. A running root session is counted when its host polled within
// HOST_POLL_WINDOW_MS, or when it names no host. A session whose host went
// quiet or was revoked, a sealed session, a subagent chain, and a session in
// another workspace are not. Runs wherever DATABASE_URL points at a migrated
// database (CI's `test` job migrates Postgres with Atlas first); a local run
// without one is skipped, not red. Every row it writes is removed in afterAll.
import { HOST_POLL_WINDOW_MS } from "@oxagen/oxagen/contracts/run.list";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresLiveRunCount } from "./run.list";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("list_runs live count against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const now = new Date();
  const hostIds = {
    polling: crypto.randomUUID(),
    quiet: crypto.randomUUID(),
    revoked: crypto.randomUUID(),
  };

  const host = (
    key: keyof typeof hostIds,
    n: number,
    over: { status: string; lastSeenAt: Date; revokedAt?: Date },
  ) => ({
    id: hostIds[key],
    publicId: `tch_${tag}0000000000000${n}`,
    orgId,
    workspaceId,
    agentKey: `live.core.bot-${key}-${tag}`,
    apiKeyId: crypto.randomUUID(),
    hostname: `${key}.local`,
    hostnameDigest: "sha256:0",
    platform: "darwin",
    osUser: "dev",
    osUserDigest: "sha256:0",
    devicePublicKey: `pk-${key}`,
    deviceKeyFingerprint: `fp-${key}`,
    enrollmentClaims: {},
    enrollmentSignature: "sig",
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    mode: "observe",
    ...over,
  });

  const session = (
    n: number,
    over: {
      hostId: string | null;
      outcome?: string;
      workspaceId?: string;
      parentSessionUuid?: string;
    },
  ) => {
    const sessionUuid = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      publicId: `tse_${tag}0000000000000${n}`,
      orgId,
      workspaceId,
      sessionUuid,
      harnessSessionId: `sess-${n}-${tag}`,
      agentKey: `live.core.bot-${tag}`,
      rootSessionUuid: over.parentSessionUuid ?? sessionUuid,
      runtime: "claude-code",
      harness: "claude-code",
      outcome: "running",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      lastEventAt: new Date(now.getTime() - 60_000),
      ...over,
    };
  };

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Live count ${tag}`,
        slug: `live-count-${tag}`,
        namespace: `l${tag.slice(0, 5)}`,
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
          name: "Other",
          slug: "other",
          namespace: "other",
        },
      ]);
      await tx.insert(schema.tachoHosts).values([
        host("polling", 1, { status: "active", lastSeenAt: now }),
        host("quiet", 2, {
          status: "active",
          lastSeenAt: new Date(now.getTime() - HOST_POLL_WINDOW_MS - 60_000),
        }),
        host("revoked", 3, {
          status: "revoked",
          lastSeenAt: now,
          revokedAt: now,
        }),
      ]);
      const parent = session(1, { hostId: hostIds.polling });
      await tx.insert(schema.tachoSessions).values([
        // Counted: a host that polled a moment ago, and no host at all.
        parent,
        session(2, { hostId: null }),
        // Not counted: the rows below read stale, sealed, or elsewhere.
        session(3, { hostId: hostIds.quiet }),
        session(4, { hostId: hostIds.revoked }),
        session(5, { hostId: hostIds.polling, outcome: "completed" }),
        session(6, {
          hostId: hostIds.polling,
          parentSessionUuid: parent.sessionUuid,
        }),
        session(7, {
          hostId: hostIds.polling,
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
        .delete(schema.tachoHosts)
        .where(eq(schema.tachoHosts.orgId, orgId));
      await tx
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.orgId, orgId));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
    });
    await closeDatabase();
  });

  it("counts the running root sessions whose host polled in the window or that name no host", async () => {
    const count = (withoutWitnessRuns: boolean) =>
      runInTenantScope({ orgId, workspaceId }, () =>
        postgresLiveRunCount(
          { orgId, workspaceId },
          { withoutWitnessRuns },
          now,
        ),
      );
    expect(await count(false)).toBe(2);
    // An API-key caller's count also leaves witness runs out; none are here.
    expect(await count(true)).toBe(2);
  });

  it("counts a quiet host's session when read at an instant inside its poll window", async () => {
    // The same rows read five minutes ago: the quiet host had polled within
    // the window of that instant, so its session read live then.
    const earlier = new Date(now.getTime() - HOST_POLL_WINDOW_MS);
    const count = await runInTenantScope({ orgId, workspaceId }, () =>
      postgresLiveRunCount(
        { orgId, workspaceId },
        { withoutWitnessRuns: false },
        earlier,
      ),
    );
    expect(count).toBe(3);
  });
});
