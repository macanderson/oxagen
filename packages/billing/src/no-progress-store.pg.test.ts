// The no-progress store against a real Postgres (#4490): the limit reads from
// `workspace.no_progress_policy`, with the default for a workspace that has no
// row, and `cost.no_progress_hits` keeps one row per loop whose count only
// rises. Runs wherever DATABASE_URL points at a
// migrated database, as CI's `test` job does. A local run without one is
// skipped. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  readNoProgressLimit,
  readRecordedLoops,
  loopKeyOf,
  writeNoProgressHits,
  type NoProgressHit,
  type NoProgressRun,
} from "./no-progress-store";

const enabled = Boolean(process.env.DATABASE_URL);
const policy = schema.noProgressPolicy;
const hits = schema.noProgressHits;

describe.skipIf(!enabled)("the no-progress store against Postgres", () => {
  const run: NoProgressRun = {
    runId: "tse_0000000000000000004490",
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sealed: false,
  };
  const hit: NoProgressHit = {
    tool: "Bash",
    inputDigest: "sha256:poll",
    outputDigest: "sha256:pending",
    loop: 1,
    repeats: 20,
    atCall: 20,
    limitRepeats: 20,
    mode: "enforced",
    outcome: "paused",
    pauseBlock: null,
  };

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(hits).where(eq(hits.workspaceId, run.workspaceId));
      await tx.delete(policy).where(eq(policy.workspaceId, run.workspaceId));
    });
    await closeDatabase();
  });

  it("reads the default for a workspace with no row, and none for a row with no count", async () => {
    expect(await readNoProgressLimit(run)).toEqual({
      repeats: 20,
      mode: "observe",
    });
    await withSystemDb((tx) =>
      tx.insert(policy).values({
        orgId: run.orgId,
        workspaceId: run.workspaceId,
      }),
    );
    expect(await readNoProgressLimit(run)).toBeNull();
  });

  it("reads the count and the mode, observe by default", async () => {
    await withSystemDb((tx) =>
      tx
        .update(policy)
        .set({ repeats: 20 })
        .where(eq(policy.workspaceId, run.workspaceId)),
    );
    expect(await readNoProgressLimit(run)).toEqual({
      repeats: 20,
      mode: "observe",
    });
  });

  it("refuses a count below 2", async () => {
    await expect(
      withSystemDb((tx) =>
        tx
          .update(policy)
          .set({ repeats: 1 })
          .where(eq(policy.workspaceId, run.workspaceId)),
      ),
    ).rejects.toThrow();
  });

  it("writes a loop once, then only raises its count", async () => {
    const first = new Date("2026-09-26T12:00:00.000Z");
    const later = new Date("2026-09-26T12:02:00.000Z");
    await writeNoProgressHits(run, [hit], first);
    await writeNoProgressHits(
      run,
      [{ ...hit, repeats: 31, atCall: 25, outcome: "would_pause" }],
      later,
    );
    await writeNoProgressHits(run, [{ ...hit, repeats: 24 }], later);

    const rows = await withSystemDb((tx) =>
      tx.select().from(hits).where(eq(hits.workspaceId, run.workspaceId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: run.runId,
      loop: 1,
      repeats: 31,
      atCall: 20,
      limitRepeats: 20,
      mode: "enforced",
      outcome: "paused",
      pauseBlock: null,
      detectedAt: first,
      updatedAt: later,
    });
    expect(await readRecordedLoops(run)).toEqual(new Set([loopKeyOf(hit)]));
  });

  it("refuses paused under an observe limit", async () => {
    await expect(
      writeNoProgressHits(
        run,
        [{ ...hit, loop: 2, mode: "observe", outcome: "paused" }],
        new Date(),
      ),
    ).rejects.toThrow();
  });

  it("keeps the reason an enforced limit could not pause the run", async () => {
    await writeNoProgressHits(
      run,
      [
        {
          ...hit,
          loop: 3,
          outcome: "would_pause",
          pauseBlock: "host_offline",
        },
      ],
      new Date(),
    );
    const rows = await withSystemDb((tx) =>
      tx.select().from(hits).where(eq(hits.workspaceId, run.workspaceId)),
    );
    expect(rows.find((r) => r.loop === 3)?.pauseBlock).toBe("host_offline");
  });

  it("refuses a reason on a hit that paused the run", async () => {
    await expect(
      writeNoProgressHits(
        run,
        [{ ...hit, loop: 4, outcome: "paused", pauseBlock: "host_offline" }],
        new Date(),
      ),
    ).rejects.toThrow();
  });

  it("refuses a reason under an observe limit", async () => {
    await expect(
      writeNoProgressHits(
        run,
        [
          {
            ...hit,
            loop: 5,
            mode: "observe",
            outcome: "would_pause",
            pauseBlock: "no_host",
          },
        ],
        new Date(),
      ),
    ).rejects.toThrow();
  });
});
