// #3835: paused and compacted are facts beside a run's status (ADR-190).
import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  createRunListHandler,
  ledgerAllSealsQuery,
  ledgerSealQuery,
} from "../run.list";
import {
  ctx,
  ledgerRun,
  memoryStores,
  SCOPE,
  seal,
  tachoSession,
} from "../run.test-support";
import { compactedField, compactedProbe } from "./run-list-status";

const RUN_A = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const RUN_B = "0192d4a8-7c1e-7a00-8000-0000000000a2";
const db = drizzle.mock({ schema });

describe("compactedField", () => {
  it("reads what the latest seal says for an ended run", () => {
    expect(compactedField("sealed", { compacted: true })).toEqual({
      compacted: true,
    });
    expect(compactedField("halted", { compacted: false })).toEqual({
      compacted: false,
    });
  });

  it("reads false for an open run and an ended run with no seal", () => {
    expect(compactedField("live", { compacted: true })).toEqual({
      compacted: false,
    });
    expect(compactedField("sealed", null)).toEqual({ compacted: false });
  });

  it("leaves the field out when the seal read did not ask (negative)", () => {
    expect(compactedField("sealed", {})).toEqual({});
  });
});

describe("compactedProbe", () => {
  it("asks for an archive segment and no V2 frame of the attempt left", () => {
    const { sql } = db
      .select({ compacted: compactedProbe() })
      .from(schema.agentRunAttemptSeals)
      .toSQL();
    expect(sql).toMatch(/"archive_segment_ref" is not null and not exists/);
    expect(sql).toMatch(
      /"agent_run_events"\."attempt_id" = "agent"\."agent_run_attempt_seals"\."attempt_id" and "agent"\."agent_run_events"\."event_record_version" = 2\)/,
    );
  });

  // The seal reads carry the probe once the run.list.ts wiring lands.
  it("is a column of the latest-seal read and the every-seal read", () => {
    for (const q of [
      ledgerSealQuery(db, SCOPE, [RUN_A]).toSQL(),
      ledgerAllSealsQuery(db, SCOPE, RUN_A).toSQL(),
    ]) {
      expect(q.sql).toMatch(
        /\("agent"\."agent_run_attempt_seals"\."archive_segment_ref" is not null and not exists \(select 1 from "agent"\."agent_run_events"/,
      );
      // A one-table select writes columns bare. A bare `attempt_id` in the
      // subquery would compare the event with itself and never read
      // compacted, so both sides carry their table.
      expect(q.sql).toContain(
        '"agent"."agent_run_events"."attempt_id" = "agent"."agent_run_attempt_seals"."attempt_id"',
      );
      expect(q.sql).not.toContain('"attempt_id" = "attempt_id"');
    }
  });
});

describe("list_runs: paused and compacted", () => {
  it("reads a compacted sealed ledger run as sealed and compacted", async () => {
    const stores = memoryStores(
      [
        ledgerRun({
          publicId: "arun_compacted",
          runId: RUN_A,
          seal: seal(RUN_A, { compacted: true }),
        }),
      ],
      [],
    );
    const [run] = (await createRunListHandler(stores)({ limit: 50 }, ctx()))
      .runs;
    expect(run).toMatchObject({ status: "sealed", compacted: true });
  });

  it("reads a run whose latest attempt still has hot frames as not compacted", async () => {
    // An earlier attempt was compacted; the latest seal is the one a row
    // answers for, and its frames are still in the log.
    const stores = memoryStores(
      [
        ledgerRun({
          publicId: "arun_half",
          runId: RUN_B,
          seal: seal(RUN_B, { compacted: false }),
        }),
      ],
      [],
    );
    const [run] = (await createRunListHandler(stores)({ limit: 50 }, ctx()))
      .runs;
    expect(run).toMatchObject({ status: "sealed", compacted: false });
  });

  it("reads a paused wrapped run as live and paused, and a resumed one as live", async () => {
    const stores = memoryStores(
      [],
      [
        tachoSession({
          publicId: "tse_paused",
          session: {
            outcome: "running",
            sealedAt: null,
            paused: true,
            startedAt: new Date("2026-09-11T09:00:00.000Z"),
          },
        }),
        tachoSession({
          publicId: "tse_resumed",
          session: {
            id: "0192d4a8-7c1e-7000-8000-00000000c0df",
            sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c0df",
            outcome: "running",
            sealedAt: null,
            paused: false,
            startedAt: new Date("2026-09-11T08:00:00.000Z"),
          },
        }),
      ],
    );
    const runs = (await createRunListHandler(stores)({ limit: 50 }, ctx()))
      .runs;
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(byId.tse_paused).toMatchObject({
      status: "live",
      ingressPaused: true,
    });
    expect(byId.tse_resumed).toMatchObject({
      status: "live",
      ingressPaused: false,
    });
    // A wrapped session's store records no recording compaction.
    expect(byId.tse_paused).not.toHaveProperty("compacted");
  });

  it("never widens the status past its three words", async () => {
    const stores = memoryStores(
      [
        ledgerRun({
          publicId: "arun_compacted",
          runId: RUN_A,
          seal: seal(RUN_A, { compacted: true }),
        }),
      ],
      [
        tachoSession({
          publicId: "tse_paused",
          session: { outcome: "running", sealedAt: null, paused: true },
        }),
      ],
    );
    const runs = (await createRunListHandler(stores)({ limit: 50 }, ctx()))
      .runs;
    for (const run of runs)
      expect(["live", "sealed", "halted"]).toContain(run.status);
  });
});
