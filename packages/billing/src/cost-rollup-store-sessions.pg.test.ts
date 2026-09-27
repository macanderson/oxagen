// A wrapped run's rollup reads its own chains (#4103). `tacho_events` sorts
// by (org_id, workspace_id, session_uuid, seq), so the frame reads name the
// run's sessions, and `rebuildRunTotals` loads that list from
// `tacho.sessions`: the root first, then each subagent session under it in
// the run's own workspace. A session in another workspace that names the
// same root stays out. Runs wherever DATABASE_URL points at a migrated
// database (CI's `test` job); a local run without one is skipped, not red.
// ClickHouse is a fake that records what each read was asked for.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { readModelCallFrames, readTachoToolCallFrames } = vi.hoisted(() => {
  /** One priced proxy call as the frame read returns it (#4493). */
  const frame = (at: string, tools: number, steering: number) => ({
    at,
    model: "claude-sonnet-5",
    provider: "anthropic",
    inputUncached: 10,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 5,
    reasoning: 0,
    serverToolRequests: 0,
    reportedCostMicros: null,
    basis: "client_attested" as const,
    toolDefinitionTokens: tools,
    contextFrameTokens: null,
    steeringTokens: steering,
  });
  return {
    readModelCallFrames: vi.fn(async () => [
      frame("2001-09-01T00:00:01.000Z", 12_000, 500),
      frame("2001-09-01T00:00:02.000Z", 400, 400),
    ]),
    readTachoToolCallFrames: vi.fn(async () => []),
  };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  readModelCallFrames,
  readTachoToolCallFrames,
}));

import { rebuildRunTotals } from "./cost-rollup-store";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("a wrapped run's session list against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const elsewhere = crypto.randomUUID();
  const sessions = schema.tachoSessions;
  const publicId = (name: string) =>
    `tse_${tag}${name.padEnd(14, "0").slice(0, 14)}`;
  const uuids = {
    root: crypto.randomUUID(),
    child: crypto.randomUUID(),
    stranger: crypto.randomUUID(),
  };
  const at = new Date("2001-09-01T00:00:00.000Z");

  const session = (
    name: keyof typeof uuids,
    workspaceId: string,
    parent: string | null,
  ) => ({
    publicId: publicId(name),
    orgId: scope.orgId,
    workspaceId,
    sessionUuid: uuids[name],
    harnessSessionId: `sess-${name}-${tag}`,
    agentKey: `acme.core.${tag}`,
    rootSessionUuid: uuids.root,
    parentSessionUuid: parent,
    runtime: "claude-code",
    harness: "claude-code",
    startedAt: at,
    lastEventAt: at,
    sealedAt: at,
  });

  beforeAll(async () => {
    await withSystemDb((tx) =>
      tx
        .insert(sessions)
        .values([
          session("root", scope.workspaceId, null),
          session("child", scope.workspaceId, uuids.root),
          // Another workspace's host stamped this run's root on its session.
          session("stranger", elsewhere, uuids.root),
        ]),
    );
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.runTotals)
        .where(eq(schema.runTotals.orgId, scope.orgId));
      await tx.delete(sessions).where(eq(sessions.orgId, scope.orgId));
    });
    await closeDatabase();
  });

  it("names the root and its own subagent chains, and no other workspace's", async () => {
    const record = await rebuildRunTotals(publicId("root"));
    expect(record?.runId).toBe(publicId("root"));

    const run = {
      kind: "tacho",
      rootSessionUuid: uuids.root,
      sessionUuids: [uuids.root, uuids.child],
    };
    expect(readModelCallFrames).toHaveBeenCalledWith({ ...scope, run });
    expect(readTachoToolCallFrames).toHaveBeenCalledWith({
      ...scope,
      rootSessionUuid: uuids.root,
      sessionUuids: [uuids.root, uuids.child],
    });
  });

  it("stores the sources summed over its priced calls, with an unmeasured one as null (#4493)", async () => {
    await rebuildRunTotals(publicId("root"));
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          toolDefinitionTokens: schema.runTotals.toolDefinitionTokens,
          contextFrameTokens: schema.runTotals.contextFrameTokens,
          steeringTokens: schema.runTotals.steeringTokens,
        })
        .from(schema.runTotals)
        .where(eq(schema.runTotals.runId, publicId("root"))),
    );
    expect(rows).toEqual([
      {
        toolDefinitionTokens: 12_400,
        contextFrameTokens: null,
        steeringTokens: 900,
      },
    ]);
  });
});
