// The control plane's idle close against a real Postgres (#3980): the scan
// finds a run only once every chain of it has been silent past the cutoff,
// the close writes the columns ingest's reopen undoes, and a close that lost
// a race to a batch writes nothing. Runs wherever DATABASE_URL points at a
// migrated database (CI's `test` job); a local run without one is skipped,
// not red. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeIdleSession,
  idleCutoff,
  listIdleSessions,
} from "./tacho-idle-close";

const enabled = Boolean(process.env.DATABASE_URL);
const sessions = schema.tachoSessions;

describe.skipIf(!enabled)("the idle close against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const now = new Date();
  const cutoff = idleCutoff(now);
  const longAgo = new Date(now.getTime() - 20 * 60 * 60 * 1000);
  const recently = new Date(now.getTime() - 60 * 60 * 1000);
  const head = `sha256:${"a".repeat(64)}`;

  const uuids = {
    quietRoot: crypto.randomUUID(),
    quietChild: crypto.randomUUID(),
    busyRoot: crypto.randomUUID(),
    busyChild: crypto.randomUUID(),
    liveRoot: crypto.randomUUID(),
    racedRoot: crypto.randomUUID(),
    headRoot: crypto.randomUUID(),
    silenceRoot: crypto.randomUUID(),
    hostRoot: crypto.randomUUID(),
    siblingRoot: crypto.randomUUID(),
    siblingChild: crypto.randomUUID(),
  };
  const publicId = (name: keyof typeof uuids) =>
    `tse_${tag}${name.toLowerCase().padEnd(14, "0").slice(0, 14)}`;

  const row = (
    name: keyof typeof uuids,
    over: {
      root?: keyof typeof uuids;
      lastEventAt: Date;
      sealedAt?: Date;
    },
  ) => ({
    publicId: publicId(name),
    orgId,
    workspaceId,
    sessionUuid: uuids[name],
    harnessSessionId: `sess-${name}-${tag}`,
    agentKey: `idle.core.bot-${tag}`,
    rootSessionUuid: uuids[over.root ?? name],
    parentSessionUuid: over.root ? uuids[over.root] : null,
    runtime: "claude-code",
    harness: "claude-code",
    startedAt: new Date(over.lastEventAt.getTime() - 60_000),
    lastEventAt: over.lastEventAt,
    sealedAt: over.sealedAt ?? null,
    seqCount: 7,
    lastHash: head,
    numToolCalls: 1,
    toolBodyFrames: 1,
    contentFrames: 2,
    bodyFrames: 2,
  });

  const read = (name: keyof typeof uuids) =>
    withSystemDb((tx) =>
      tx
        .select()
        .from(sessions)
        .where(eq(sessions.sessionUuid, uuids[name]))
        .limit(1),
    ).then((rows) => rows[0]);

  beforeAll(async () => {
    await withSystemDb((tx) =>
      tx.insert(sessions).values([
        // A run gone quiet: its root and its subagent both.
        row("quietRoot", { lastEventAt: longAgo }),
        row("quietChild", { root: "quietRoot", lastEventAt: longAgo }),
        // A root that has said nothing while its subagent still works.
        row("busyRoot", { lastEventAt: longAgo }),
        row("busyChild", { root: "busyRoot", lastEventAt: recently }),
        // A run that reported an hour ago.
        row("liveRoot", { lastEventAt: recently }),
        row("racedRoot", { lastEventAt: longAgo }),
        row("headRoot", { lastEventAt: longAgo }),
        row("silenceRoot", { lastEventAt: longAgo }),
        row("hostRoot", { lastEventAt: longAgo }),
        row("siblingRoot", { lastEventAt: longAgo }),
        row("siblingChild", { root: "siblingRoot", lastEventAt: longAgo }),
      ]),
    );
  });

  afterAll(async () => {
    await withSystemDb((tx) =>
      tx
        .delete(sessions)
        .where(inArray(sessions.sessionUuid, Object.values(uuids))),
    );
    await closeDatabase();
  });

  const ours = async () =>
    (await listIdleSessions({ cutoff, limit: 10_000 })).filter(
      (session) => session.orgId === orgId,
    );

  it("finds a run only once every chain of it has gone quiet", async () => {
    const found = (await ours()).map((session) => session.publicId).sort();
    expect(found).toEqual(
      [
        publicId("quietChild"),
        publicId("quietRoot"),
        publicId("racedRoot"),
        publicId("headRoot"),
        publicId("silenceRoot"),
        publicId("hostRoot"),
        publicId("siblingRoot"),
        publicId("siblingChild"),
      ].sort(),
    );
  });

  it("closes a quiet run as the control plane's, ending it at its last event", async () => {
    const root = (await ours()).find(
      (session) => session.publicId === publicId("quietRoot"),
    )!;
    const closed = await closeIdleSession(root, cutoff, now);
    expect(closed).toEqual({
      publicId: publicId("quietRoot"),
      orgId,
      workspaceId,
      isRoot: true,
    });
    const after = await read("quietRoot");
    expect(after).toMatchObject({
      sealSource: "idle_timeout",
      outcome: "unknown",
      finalHash: head,
      unobservedTail: true,
      completenessGaps: ["unobserved_tail"],
      replayGrade: "inspect",
    });
    expect(after?.sealedAt).toEqual(now);
    expect(after?.endedAt).toEqual(longAgo);
    // Closed, so the next scan passes it by.
    expect((await ours()).map((session) => session.publicId)).not.toContain(
      publicId("quietRoot"),
    );
  });

  it("writes nothing for a session a batch reached after the scan (negative)", async () => {
    const raced = (await ours()).find(
      (session) => session.publicId === publicId("racedRoot"),
    )!;
    // A batch lands between the scan and the close: its head moves on.
    await withSystemDb((tx) =>
      tx
        .update(sessions)
        .set({ seqCount: 9, lastEventAt: new Date() })
        .where(eq(sessions.sessionUuid, uuids.racedRoot)),
    );
    expect(await closeIdleSession(raced, cutoff, now)).toBeNull();
    const after = await read("racedRoot");
    expect(after?.sealedAt).toBeNull();
    expect(after?.outcome).toBe("running");
  });

  const scanned = async (name: keyof typeof uuids) =>
    (await ours()).find((session) => session.publicId === publicId(name))!;

  it("gives way to a head that moved, even with the silence intact (negative)", async () => {
    const found = await scanned("headRoot");
    await withSystemDb((tx) =>
      tx
        .update(sessions)
        .set({ seqCount: 8 })
        .where(eq(sessions.sessionUuid, uuids.headRoot)),
    );
    expect(await closeIdleSession(found, cutoff, now)).toBeNull();
    expect((await read("headRoot"))?.sealedAt).toBeNull();
  });

  it("gives way to a new event, even with the head unmoved (negative)", async () => {
    const found = await scanned("silenceRoot");
    await withSystemDb((tx) =>
      tx
        .update(sessions)
        .set({ lastEventAt: new Date() })
        .where(eq(sessions.sessionUuid, uuids.silenceRoot)),
    );
    expect(await closeIdleSession(found, cutoff, now)).toBeNull();
    expect((await read("silenceRoot"))?.sealedAt).toBeNull();
  });

  it("never overwrites a seal the host sent after the scan (negative)", async () => {
    const found = await scanned("hostRoot");
    const hostSeal = new Date(now.getTime() - 60_000);
    await withSystemDb((tx) =>
      tx
        .update(sessions)
        .set({
          sealedAt: hostSeal,
          sealSource: "agent_stop",
          outcome: "completed",
        })
        .where(eq(sessions.sessionUuid, uuids.hostRoot)),
    );
    expect(await closeIdleSession(found, cutoff, now)).toBeNull();
    expect(await read("hostRoot")).toMatchObject({
      sealSource: "agent_stop",
      outcome: "completed",
    });
  });

  it("keeps a root open when its subagent reported between the scan and the close (negative)", async () => {
    const found = await scanned("siblingRoot");
    await withSystemDb((tx) =>
      tx
        .update(sessions)
        .set({ lastEventAt: new Date(), seqCount: 8 })
        .where(eq(sessions.sessionUuid, uuids.siblingChild)),
    );
    expect(await closeIdleSession(found, cutoff, now)).toBeNull();
    expect((await read("siblingRoot"))?.sealedAt).toBeNull();
  });
});
