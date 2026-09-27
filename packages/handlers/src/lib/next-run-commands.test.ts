// A steer held for an agent's next run (#2953): which runs take it, the mode
// each resolves to, and the Stella refusal, against a transaction fake that
// records each UPDATE. The same path against a real Postgres, through the
// host's poll and acknowledgement, is in `tacho.command.pg.test.ts`.
import { schema, type Tx } from "@oxagen/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { BUNDLE_FEATURE_STEER_NEXT_STEP } from "../tacho.command.dispatch";
import { type NextRun, readdressNextRunCommands } from "./next-run-commands";

const dialect = new PgDialect();
const NOW = new Date("2026-09-21T10:00:00.000Z");
const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

type Update = { table: unknown; values: Record<string, unknown> };

/** A transaction that records each UPDATE and answers `taken` rows. */
function recordingTx(taken = 1) {
  const updates: Update[] = [];
  const tx = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        const rows = Array.from({ length: taken }, (_, i) => ({
          id: `c${i}`,
        }));
        return {
          where: () =>
            Object.assign(Promise.resolve([]), {
              returning: async () => rows,
            }),
        };
      },
    }),
  };
  return { tx: tx as unknown as Tx, updates };
}

function run(over: Partial<NextRun> = {}): NextRun {
  return {
    id: "s1",
    publicId: "tse_0123456789abcdefghjkmn",
    sessionUuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
    harnessSessionId: "sess-1",
    hostId: "11111111-1111-4111-8111-111111111111",
    runtime: "claude-code",
    enforcementTier: "harness",
    ...over,
  };
}

/** The params a CASE binds, in order: each requested mode, then its answer. */
const caseParams = (value: unknown) =>
  dialect.sqlToQuery(value as SQL).params;

describe("readdressNextRunCommands", () => {
  it("moves the agent's held commands to the run with its host, session and session uuid", async () => {
    const { tx, updates } = recordingTx(2);
    const taken = await readdressNextRunCommands(tx, {
      scope: SCOPE,
      agentKey: "acme.core.release-bot",
      run: run(),
      hostFeatures: [],
      now: NOW,
    });
    expect(taken).toBe(2);
    expect(updates).toHaveLength(2);
    // First the rows past their expiry, which no host's poll would sweep.
    expect(updates[0]?.table).toBe(schema.tachoControlCommands);
    expect(updates[0]?.values).toEqual({ outcome: "expired", updatedAt: NOW });
    const moved = updates[1]?.values ?? {};
    expect(moved).toMatchObject({
      targetKind: "run",
      targetId: "tse_0123456789abcdefghjkmn",
      hostId: "11111111-1111-4111-8111-111111111111",
      sessionId: "s1",
      updatedAt: NOW,
    });
    expect(caseParams(moved["payload"])).toEqual([
      JSON.stringify({ session_uuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b" }),
    ]);
    expect(moved["outcome"]).toBeUndefined();
  });

  it("resolves each requested mode against the run the way dispatch resolves a run in flight", async () => {
    const plain = recordingTx();
    await readdressNextRunCommands(plain.tx, {
      scope: SCOPE,
      agentKey: "acme.core.release-bot",
      run: run(),
      hostFeatures: [],
      now: NOW,
    });
    // A host with no step carrier delivers every steer at the turn boundary.
    const plainSet = plain.updates[1]?.values ?? {};
    expect(caseParams(plainSet["deliveryMode"])).toEqual([
      "next_step",
      "turn_boundary",
      "interrupt",
      "turn_boundary",
      "turn_boundary",
      "turn_boundary",
    ]);
    expect(caseParams(plainSet["degradedReason"])).toEqual([
      "next_step",
      "no_step_carrier",
      "interrupt",
      "no_step_carrier",
      "turn_boundary",
      null,
    ]);
    const routed = recordingTx();
    await readdressNextRunCommands(routed.tx, {
      scope: SCOPE,
      agentKey: "acme.core.release-bot",
      run: run({ enforcementTier: "gateway" }),
      hostFeatures: [BUNDLE_FEATURE_STEER_NEXT_STEP],
      now: NOW,
    });
    // A gateway run whose host carries a step steer can take an interrupt.
    expect(caseParams(routed.updates[1]?.values["deliveryMode"])).toEqual([
      "next_step",
      "next_step",
      "interrupt",
      "interrupt",
      "turn_boundary",
      "turn_boundary",
    ]);
  });

  it("records a Stella run's steer as failed, since Stella reads steering only at its start (negative)", async () => {
    const { tx, updates } = recordingTx();
    await readdressNextRunCommands(tx, {
      scope: SCOPE,
      agentKey: "acme.core.release-bot",
      run: run({ runtime: "stella" }),
      hostFeatures: [],
      now: NOW,
    });
    expect(updates[1]?.values).toMatchObject({
      targetKind: "run",
      targetId: "tse_0123456789abcdefghjkmn",
      outcome: "failed",
      outcomeDetail: "no_prompt_carrier",
    });
    expect(updates[1]?.values["deliveryMode"]).toBeUndefined();
  });

  it("gives nothing to the daemon's own chain or to a host with no agent key (negative)", async () => {
    for (const args of [
      {
        agentKey: "acme.core.release-bot",
        run: run({ harnessSessionId: "tachod-01K5" }),
      },
      { agentKey: null, run: run() },
    ]) {
      const { tx, updates } = recordingTx();
      const taken = await readdressNextRunCommands(tx, {
        scope: SCOPE,
        hostFeatures: [],
        now: NOW,
        ...args,
      });
      expect(taken).toBe(0);
      expect(updates).toEqual([]);
    }
  });
});
