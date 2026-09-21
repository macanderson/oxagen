import { schema } from "@oxagen/database";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  addCompactedRollup,
  createRunListHandler,
  decodeRunCursor,
  ledgerCompactedRollupQuery,
  encodeRunCursor,
  ledgerPageQuery,
  ledgerRollupQuery,
  ledgerSealQuery,
  tachoPageQuery,
  tachoSessionQuery,
  ledgerIdentityQuery,
  ledgerRunOutcome,
  ledgerRunStatus,
  tachoRunOutcome,
  tachoRunStatus,
} from "./run.list";
import {
  ctx,
  ledgerRun,
  memoryStores,
  OTHER_WORKSPACE,
  SCOPE,
  rollupCostRow,
  seal,
  tachoSession,
} from "./run.test-support";

const RUN_A = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const RUN_B = "0192d4a8-7c1e-7a00-8000-0000000000a2";
const at = (iso: string) => new Date(iso);

function handlerOver(
  ledger: Parameters<typeof memoryStores>[0],
  tacho: Parameters<typeof memoryStores>[1],
) {
  const stores = memoryStores(ledger, tacho);
  return { stores, list: createRunListHandler(stores) };
}

describe("list_runs", () => {
  it("merges ledger runs and root wrapped sessions newest first, in the caller's workspace only", async () => {
    const { list } = handlerOver(
      [
        ledgerRun({
          publicId: "arun_a",
          runId: RUN_A,
          run: {
            runId: RUN_A,
            publicId: "arun_a",
            status: "running",
            createdAt: at("2026-09-11T10:00:00.000Z"),
            startedAt: at("2026-09-11T10:30:00.000Z"),
            name: null,
            summary: null,
            summaryGeneratedAt: null,
            summaryModel: null,
          },
        }),
        ledgerRun({ publicId: "arun_x", runId: RUN_B, scope: OTHER_WORKSPACE }),
      ],
      [
        tachoSession({
          publicId: "tse_b",
          session: { startedAt: at("2026-09-11T10:15:00.000Z") },
        }),
        tachoSession({
          publicId: "tse_c",
          session: { startedAt: at("2026-09-11T10:45:00.000Z") },
        }),
        tachoSession({ publicId: "tse_child", child: true }),
        tachoSession({ publicId: "tse_other", scope: OTHER_WORKSPACE }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(runList.output.parse(out)).toEqual(out);
    expect(out.runs.map((r) => [r.id, r.source])).toEqual([
      ["tse_c", "tacho"],
      ["arun_a", "ledger"],
      ["tse_b", "tacho"],
    ]);
    expect(out.nextCursor).toBeNull();
  });

  it("never lists the in-app agent's turns, and lists every other surface (negative)", async () => {
    const { list } = handlerOver(
      [
        ledgerRun({ publicId: "arun_external", runId: RUN_A }),
        ledgerRun({
          publicId: "arun_assistant_app",
          runId: "0192d4a8-7c1e-7a00-8000-0000000000a3",
          surface: "chat",
          run: {
            runId: "0192d4a8-7c1e-7a00-8000-0000000000a3",
            publicId: "arun_assistant_app",
            status: "completed",
            createdAt: at("2026-09-11T12:00:00.000Z"),
            startedAt: at("2026-09-11T12:00:01.000Z"),
            name: null,
            summary: null,
            summaryGeneratedAt: null,
            summaryModel: null,
          },
        }),
        ledgerRun({
          publicId: "arun_assistant_api",
          runId: "0192d4a8-7c1e-7a00-8000-0000000000a4",
          surface: "api-chat",
          run: {
            runId: "0192d4a8-7c1e-7a00-8000-0000000000a4",
            publicId: "arun_assistant_api",
            status: "completed",
            createdAt: at("2026-09-11T12:30:00.000Z"),
            startedAt: at("2026-09-11T12:30:01.000Z"),
            name: null,
            summary: null,
            summaryGeneratedAt: null,
            summaryModel: null,
          },
        }),
        ledgerRun({
          publicId: "arun_a2a",
          runId: RUN_B,
          surface: "a2a",
          run: {
            runId: RUN_B,
            publicId: "arun_a2a",
            status: "completed",
            createdAt: at("2026-09-11T13:00:00.000Z"),
            startedAt: at("2026-09-11T13:00:01.000Z"),
            name: null,
            summary: null,
            summaryGeneratedAt: null,
            summaryModel: null,
          },
        }),
      ],
      [],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(out.runs.map((r) => r.id)).toEqual(["arun_a2a", "arun_external"]);
  });

  it("costs a run from its rollup row with the basis the row recorded, and leaves an unrolled one null", async () => {
    const { list, stores } = handlerOver(
      [
        ledgerRun({
          publicId: "arun_rolled",
          runId: RUN_A,
          cost: rollupCostRow(),
        }),
        ledgerRun({
          publicId: "arun_unrolled",
          runId: RUN_B,
          run: {
            runId: RUN_B,
            publicId: "arun_unrolled",
            status: "completed",
            createdAt: at("2026-09-11T11:00:00.000Z"),
            startedAt: null,
            name: null,
            summary: null,
            summaryGeneratedAt: null,
            summaryModel: null,
          },
        }),
      ],
      [
        tachoSession({ publicId: "tse_unrolled" }),
        tachoSession({
          publicId: "tse_attested",
          session: { startedAt: at("2026-09-11T09:01:00.000Z") },
          cost: rollupCostRow({
            costMicros: 97_937n,
            costBasis: "client_attested",
          }),
        }),
        tachoSession({
          publicId: "tse_estimated",
          session: { startedAt: at("2026-09-11T09:02:00.000Z") },
          cost: rollupCostRow({ costMicros: 50n, costBasis: "estimated" }),
        }),
        tachoSession({
          publicId: "tse_other",
          scope: OTHER_WORKSPACE,
          cost: rollupCostRow(),
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(runList.output.parse(out)).toEqual(out);
    const cost = Object.fromEntries(out.runs.map((r) => [r.id, r.cost]));
    expect(cost["arun_rolled"]).toEqual({
      micros: "12500",
      currency: "USD",
      basis: "gateway_observed",
    });
    expect(cost["arun_unrolled"]).toBeNull();
    expect(cost["tse_unrolled"]).toBeNull();
    expect(cost["tse_attested"]).toEqual({
      micros: "97937",
      currency: "USD",
      basis: "client_attested",
    });
    expect(cost["tse_estimated"]).toEqual({
      micros: "50",
      currency: "USD",
      basis: "estimated",
    });
    expect(cost["tse_other"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('"micros":"0"');
    // One rollup read for the page, over exactly the runs on it.
    expect(stores.rollupCalls).toEqual([
      [
        "arun_unrolled",
        "arun_rolled",
        "tse_estimated",
        "tse_attested",
        "tse_unrolled",
      ],
    ]);
    // A run with no started_at is placed by its created_at.
    expect(out.runs[0]?.startedAt).toBe("2026-09-11T11:00:00.000Z");
  });

  it("leaves the operator and the agent key null when the row recorded neither", async () => {
    const { list } = handlerOver(
      [
        ledgerRun({
          publicId: "arun_anon",
          runId: RUN_A,
          identity: {
            orgNamespace: "acme",
            workspaceNamespace: null,
            agentSlug: "reviewer",
            operatorPublicId: null,
            operatorKind: null,
            operatorUserName: null,
            goal: null,
          },
        }),
      ],
      [
        tachoSession({
          publicId: "tse_anon",
          operatorPublicId: null,
          operatorKind: null,
          operatorUserName: null,
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    const byId = Object.fromEntries(out.runs.map((r) => [r.id, r]));
    expect(byId["arun_anon"]).toMatchObject({
      operatorId: null,
      agentKey: null,
      taskRef: null,
    });
    expect(byId["tse_anon"]).toMatchObject({
      operatorId: null,
      agentKey: "acme.core.cc-laptop",
    });
  });

  it("folds counts from the event log, hides turns behind an encrypted model call, and seals from the seal table", async () => {
    const { list } = handlerOver(
      [
        ledgerRun({
          publicId: "arun_open",
          runId: RUN_A,
          rollup: {
            frames: 9,
            modelCalls: 3,
            toolCalls: 4,
            turnIndexes: 2,
            opaqueModelCalls: 1,
          },
        }),
        ledgerRun({
          publicId: "arun_done",
          runId: RUN_B,
          run: {
            runId: RUN_B,
            publicId: "arun_done",
            status: "cancelled",
            createdAt: at("2026-09-11T08:00:00.000Z"),
            startedAt: at("2026-09-11T08:00:00.000Z"),
            name: null,
            summary: null,
            summaryGeneratedAt: null,
            summaryModel: null,
          },
          rollup: {
            frames: 2,
            modelCalls: 1,
            toolCalls: 0,
            turnIndexes: 1,
            opaqueModelCalls: 0,
          },
          seal: seal(RUN_B, {
            sealedAt: at("2026-09-11T08:10:00.000Z"),
            replayGrade: "inspect",
          }),
        }),
      ],
      [],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(
      out.runs.map((r) => [
        r.id,
        r.status,
        r.turns,
        r.steps,
        r.frames,
        r.sealedAt,
        r.replayGrade,
      ]),
    ).toEqual([
      ["arun_open", "sealed", null, 7, 9, null, null],
      ["arun_done", "halted", 1, 1, 2, "2026-09-11T08:10:00.000Z", "inspect"],
    ]);
  });

  it("renders the recorded grade and never a word outside the ladder; a live run has none", async () => {
    const { list } = handlerOver(
      [
        ledgerRun({
          publicId: "arun_broken",
          runId: RUN_A,
          seal: seal(RUN_A, { replayGrade: "replay" }),
        }),
        ledgerRun({
          publicId: "arun_ungraded",
          runId: RUN_B,
          seal: seal(RUN_B, { replayGrade: null }),
        }),
      ],
      [
        tachoSession({
          publicId: "tse_fork",
          session: { replayGrade: "fork" },
        }),
        tachoSession({
          publicId: "tse_live",
          session: {
            outcome: "running",
            sealedAt: null,
            replayGrade: null,
            startedAt: at("2026-09-11T09:01:00.000Z"),
          },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    const byId = Object.fromEntries(out.runs.map((r) => [r.id, r.replayGrade]));
    expect(byId).toEqual({
      arun_broken: null,
      arun_ungraded: null,
      tse_fork: "fork",
      tse_live: null,
    });
  });

  it("carries the generated summary only when its three columns were set together", async () => {
    const generatedAt = at("2026-09-11T10:07:00.000Z");
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_named",
          session: {
            name: "Review PR 42",
            summary: "Reviewed the PR and left two comments.",
            summaryGeneratedAt: generatedAt,
            summaryModel: "anthropic/claude-haiku-4.5",
          },
        }),
        tachoSession({
          publicId: "tse_bare",
          session: { startedAt: at("2026-09-11T09:01:00.000Z") },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    const byId = Object.fromEntries(out.runs.map((r) => [r.id, r]));
    expect(byId["tse_named"]).toMatchObject({
      name: "Review PR 42",
      summary: {
        text: "Reviewed the PR and left two comments.",
        generatedAt: "2026-09-11T10:07:00.000Z",
        model: "anthropic/claude-haiku-4.5",
      },
    });
    expect(byId["tse_bare"]).toMatchObject({ name: null, summary: null });
  });

  it("answers a live run with no seal, and a run with no events as zero of each", async () => {
    const { list } = handlerOver(
      [
        ledgerRun({
          publicId: "arun_live",
          runId: RUN_A,
          run: {
            runId: RUN_A,
            publicId: "arun_live",
            status: "pending",
            createdAt: at("2026-09-11T10:00:00.000Z"),
            startedAt: null,
            name: null,
            summary: null,
            summaryGeneratedAt: null,
            summaryModel: null,
          },
          seal: seal(RUN_A, { sealedAt: at("2026-09-11T08:10:00.000Z") }),
        }),
      ],
      [
        tachoSession({
          publicId: "tse_live",
          session: { outcome: "running", sealedAt: null },
        }),
        tachoSession({
          publicId: "tse_halted",
          session: {
            outcome: "aborted",
            startedAt: at("2026-09-11T09:01:00.000Z"),
          },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    const byId = Object.fromEntries(out.runs.map((r) => [r.id, r]));
    expect(byId["arun_live"]).toMatchObject({
      status: "live",
      sealedAt: null,
      turns: 0,
      steps: 0,
      frames: 0,
    });
    expect(byId["tse_live"]).toMatchObject({ status: "live", sealedAt: null });
    expect(byId["tse_halted"]).toMatchObject({ status: "halted" });
  });

  it("pages across both stores from the cursor with no duplicate and no gap", async () => {
    const ledger = [0, 1, 2].map((i) =>
      ledgerRun({
        publicId: `arun_${i}`,
        runId: `0192d4a8-7c1e-7a00-8000-0000000000b${i}`,
        run: {
          runId: `0192d4a8-7c1e-7a00-8000-0000000000b${i}`,
          publicId: `arun_${i}`,
          status: "completed",
          createdAt: at("2026-09-11T10:00:00.000Z"),
          // Two ledger runs share an instant with a tacho session: the tie
          // breaks on the public id.
          startedAt: at(`2026-09-11T10:0${i}:00.000Z`),
          name: null,
          summary: null,
          summaryGeneratedAt: null,
          summaryModel: null,
        },
      }),
    );
    const tacho = [0, 1, 2].map((i) =>
      tachoSession({
        publicId: `tse_${i}`,
        session: { startedAt: at(`2026-09-11T10:0${i}:00.000Z`) },
      }),
    );
    const { list } = handlerOver(ledger, tacho);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await list(
        { limit: 2, ...(cursor ? { cursor } : {}) },
        ctx(),
      );
      expect(out.runs.length).toBeLessThanOrEqual(2);
      seen.push(...out.runs.map((r) => r.id));
      cursor = out.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual([
      "tse_2",
      "arun_2",
      "tse_1",
      "arun_1",
      "tse_0",
      "arun_0",
    ]);
    expect(new Set(seen).size).toBe(6);
  });

  it("pages on when one store alone overflows the limit and the other is empty", async () => {
    // Three rows in one store, limit 2: the merge holds exactly `limit` items,
    // so only the store's own overflow can say a second page exists.
    const ledger = [0, 1, 2].map((i) =>
      ledgerRun({
        publicId: `arun_${i}`,
        runId: `0192d4a8-7c1e-7a00-8000-0000000000b${i}`,
        run: {
          runId: `0192d4a8-7c1e-7a00-8000-0000000000b${i}`,
          publicId: `arun_${i}`,
          status: "completed",
          createdAt: at("2026-09-11T10:00:00.000Z"),
          startedAt: at(`2026-09-11T10:0${i}:00.000Z`),
          name: null,
          summary: null,
          summaryGeneratedAt: null,
          summaryModel: null,
        },
      }),
    );
    const tacho = [0, 1, 2].map((i) =>
      tachoSession({
        publicId: `tse_${i}`,
        session: { startedAt: at(`2026-09-11T10:0${i}:00.000Z`) },
      }),
    );
    const cases = [
      { stores: handlerOver(ledger, []), ids: ["arun_2", "arun_1", "arun_0"] },
      { stores: handlerOver([], tacho), ids: ["tse_2", "tse_1", "tse_0"] },
    ];
    for (const { stores, ids } of cases) {
      const first = await stores.list({ limit: 2 }, ctx());
      expect(first.runs.map((r) => r.id)).toEqual(ids.slice(0, 2));
      expect(first.nextCursor).not.toBeNull();
      const second = await stores.list(
        { limit: 2, cursor: first.nextCursor as string },
        ctx(),
      );
      expect(second.runs.map((r) => r.id)).toEqual(ids.slice(2));
      expect(second.nextCursor).toBeNull();
    }
  });

  it("refuses a cursor it did not write as invalid_input (negative)", async () => {
    const { list } = handlerOver([], []);
    for (const cursor of [
      "garbage",
      encodeRunCursor({ at: "yesterday", id: "arun_a" }),
      Buffer.from('["2026-09-11T10:00:00.000Z","run_1"]').toString("base64url"),
    ]) {
      const attempt = list({ limit: 50, cursor }, ctx());
      await expect(attempt).rejects.toBeInstanceOf(CapabilityError);
      await expect(attempt).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("round-trips its own cursor", () => {
    const cursor = {
      at: "2026-09-11T10:00:00.000Z",
      id: "tse_4q8r1t6v3x5z0b2d7h2k9m",
    };
    expect(decodeRunCursor(encodeRunCursor(cursor))).toEqual(cursor);
  });
});

describe("list_runs queries name the tenant", () => {
  const db = drizzle.mock({ schema });
  const page = { cursor: null, limit: 50, withoutWitnessRuns: false };
  const RUN = "0192d4a8-7c1e-7a00-8000-0000000000a1";
  const cases = [
    ["ledgerPageQuery", ledgerPageQuery(db, SCOPE, page).toSQL()],
    ["ledgerIdentityQuery", ledgerIdentityQuery(db, SCOPE, RUN).toSQL()],
    ["ledgerRollupQuery", ledgerRollupQuery(db, SCOPE, [RUN]).toSQL()],
    [
      "ledgerCompactedRollupQuery",
      ledgerCompactedRollupQuery(db, SCOPE, [RUN]).toSQL(),
    ],
    ["ledgerSealQuery", ledgerSealQuery(db, SCOPE, [RUN]).toSQL()],
    ["tachoPageQuery", tachoPageQuery(db, SCOPE, page).toSQL()],
    ["tachoSessionQuery", tachoSessionQuery(db, SCOPE, "tse_a").toSQL()],
  ] as const;

  it.each(cases)("%s filters on org_id and workspace_id", (_name, query) => {
    expect(query.sql).toMatch(/"org_id" = \$\d+/);
    expect(query.sql).toMatch(/"workspace_id" = \$\d+/);
    expect(query.params).toContain(SCOPE.orgId);
    expect(query.params).toContain(SCOPE.workspaceId);
  });

  it("leaves witness runs out of both pages only when the page asks", () => {
    const hidden = { ...page, withoutWitnessRuns: true };
    for (const query of [
      ledgerPageQuery(db, SCOPE, hidden).toSQL(),
      tachoPageQuery(db, SCOPE, hidden).toSQL(),
    ])
      expect(query.sql).toMatch(
        /not exists \(select 1 from "evidence"\."verdicts" where "evidence"\."verdicts"\."org_id" = .*"evidence"\."verdicts"\."witness_run_id" = /,
      );
    for (const query of [
      ledgerPageQuery(db, SCOPE, page).toSQL(),
      tachoPageQuery(db, SCOPE, page).toSQL(),
    ])
      expect(query.sql).not.toMatch(/"evidence"\."verdicts"/);
  });

  it("counts both spellings of a model call and a tool call", () => {
    // The in-app assistant writes `model.engine_call_completed` and
    // `tool.engine_call_completed`; this query matched only
    // `model.call_completed` / `tool.call_completed`, so a real run listed
    // zero model calls, zero tool calls and zero turns beside a climbing
    // frame count.
    const query = ledgerRollupQuery(db, SCOPE, [RUN]).toSQL();
    for (const type of [
      "model.call_completed",
      "model.engine_call_completed",
      "tool.call_completed",
      "tool.engine_call_completed",
    ])
      expect(query.params).toContain(type);
    // Bound, never interpolated: an event type reaches Postgres as a
    // parameter like every other value this query sends.
    expect(query.sql).not.toContain("model.engine_call_completed");
  });

  it("a different scope binds different tenant ids (negative)", () => {
    const query = ledgerPageQuery(db, OTHER_WORKSPACE, page).toSQL();
    expect(query.params).not.toContain(SCOPE.workspaceId);
    expect(query.params).toContain(OTHER_WORKSPACE.workspaceId);
  });

  it("reads the latest seal per run, and the compacted rollup only from seals with a segment and no hot rows", () => {
    const latest = ledgerSealQuery(db, SCOPE, [RUN]).toSQL();
    expect(latest.sql).toMatch(
      /select distinct on \("agent"\."agent_run_attempt_seals"\."run_id"\)/i,
    );
    expect(latest.sql).toMatch(
      /order by "agent"\."agent_run_attempt_seals"\."run_id", "agent"\."agent_run_attempt_seals"\."sealed_at" desc/i,
    );
    const compacted = ledgerCompactedRollupQuery(db, SCOPE, [RUN]).toSQL();
    expect(compacted.sql).toMatch(/"archive_segment_ref" is not null/);
    expect(compacted.sql).toMatch(
      /not exists \(select 1 from "agent"\."agent_run_events"/,
    );
  });

  it("adds a compacted rollup to the hot one, frame for frame, and hides turns an encrypted call hid", () => {
    const hot = {
      frames: 2,
      modelCalls: 1,
      toolCalls: 1,
      turnIndexes: 1,
      opaqueModelCalls: 0,
    };
    expect(addCompactedRollup(hot, undefined)).toBe(hot);
    expect(addCompactedRollup(undefined, undefined)).toBeUndefined();
    expect(
      addCompactedRollup(hot, {
        frames: 5,
        modelCalls: 2,
        toolCalls: 2,
        turns: 2,
        opaqueTurns: false,
      }),
    ).toEqual({
      frames: 7,
      modelCalls: 3,
      toolCalls: 3,
      turnIndexes: 3,
      opaqueModelCalls: 0,
    });
    expect(
      addCompactedRollup(undefined, {
        frames: 5,
        modelCalls: 2,
        toolCalls: 2,
        turns: 0,
        opaqueTurns: true,
      }),
    ).toEqual({
      frames: 5,
      modelCalls: 2,
      toolCalls: 2,
      turnIndexes: 0,
      opaqueModelCalls: 1,
    });
  });

  it("lists V2 ledger runs and root sessions only", () => {
    const ledger = ledgerPageQuery(db, SCOPE, page).toSQL();
    expect(ledger.sql).toMatch(/"spec_version" = \$\d+/);
    expect(ledger.params).toContain(2);
    expect(ledgerIdentityQuery(db, SCOPE, RUN).toSQL().params).toContain(2);
    expect(tachoPageQuery(db, SCOPE, page).toSQL().sql).toMatch(
      /"parent_session_uuid" is null/,
    );
    expect(tachoSessionQuery(db, SCOPE, "tse_a").toSQL().sql).toMatch(
      /"parent_session_uuid" is null/,
    );
  });

  it("keeps the in-app agent's surfaces out of the page and leaves get_run's identity read open to them", () => {
    const ledger = ledgerPageQuery(db, SCOPE, page).toSQL();
    expect(ledger.sql).toMatch(/"surface" not in \(\$\d+, \$\d+\)/);
    expect(ledger.params).toEqual(expect.arrayContaining(["chat", "api-chat"]));
    const identity = ledgerIdentityQuery(db, SCOPE, RUN).toSQL();
    expect(identity.sql).not.toMatch(/"surface"/);
  });

  it("applies the cursor at millisecond precision with byte-order ties, reading one row past the page", () => {
    const cursor = { at: "2026-09-11T10:00:00.000Z", id: "arun_a" };
    const ledger = ledgerPageQuery(db, SCOPE, {
      cursor,
      limit: 10,
      withoutWitnessRuns: false,
    }).toSQL();
    expect(ledger.sql).toContain("date_trunc('milliseconds'");
    expect(ledger.sql).toContain('collate "C"');
    expect(ledger.params).toEqual(expect.arrayContaining(["arun_a", 11]));
    const tacho = tachoPageQuery(db, SCOPE, {
      cursor,
      limit: 10,
      withoutWitnessRuns: false,
    }).toSQL();
    expect(tacho.params).toEqual(expect.arrayContaining(["arun_a", 11]));
  });
});

describe("list_runs verdict (ADR-064)", () => {
  it("carries the verdict the rollup row recorded, and null for a run no witness reported on", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({ publicId: "tse_proven", verdict: "flipped" }),
        tachoSession({
          publicId: "tse_tampered",
          session: { startedAt: at("2026-09-11T09:01:00.000Z") },
          cost: rollupCostRow(),
          verdict: "tampered",
        }),
        tachoSession({
          publicId: "tse_unproven",
          session: { startedAt: at("2026-09-11T09:02:00.000Z") },
          cost: rollupCostRow(),
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(runList.output.parse(out)).toEqual(out);
    const verdict = Object.fromEntries(out.runs.map((r) => [r.id, r.verdict]));
    expect(verdict).toEqual({
      tse_proven: "flipped",
      tse_tampered: "tampered",
      tse_unproven: null,
    });
    // A verdict with no priced frame is still a verdict, never a cost.
    expect(out.runs.find((r) => r.id === "tse_proven")?.cost).toBeNull();
  });
});

describe("list_runs witness runs (ADR-064)", () => {
  const runs = [
    tachoSession({ publicId: "tse_worker" }),
    tachoSession({
      publicId: "tse_witness",
      session: { startedAt: at("2026-09-11T09:01:00.000Z") },
      witnessFor: "tse_worker",
    }),
  ];

  it("lists a witness run to a signed-in member", async () => {
    const out = await handlerOver([], runs).list({ limit: 50 }, ctx());
    expect(out.runs.map((r) => r.id)).toEqual(["tse_witness", "tse_worker"]);
  });

  it("leaves every witness run out for an API-key caller (negative)", async () => {
    const out = await handlerOver([], runs).list(
      { limit: 50 },
      { ...ctx(), userId: null, apiKeyId: "aky_worker" },
    );
    expect(out.runs.map((r) => r.id)).toEqual(["tse_worker"]);
  });
});

describe("the row a caller decides from (#3285)", () => {
  it("carries a wrapped session's recorded tier, so an observe-tier run's controls can be disabled", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_observe",
          session: { enforcementTier: "observe" },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(out.runs[0]?.enforcementTier).toBe("observe");
  });

  it("reads a ledger run's tier from its seal, and a seal without one as harness", async () => {
    const { list } = handlerOver(
      [
        ledgerRun({
          publicId: "arun_gateway",
          runId: "0192d4a8-7c1e-7a00-8000-0000000000e1",
          seal: seal("0192d4a8-7c1e-7a00-8000-0000000000e1", {
            enforcementTier: "gateway",
          }),
        }),
        ledgerRun({
          publicId: "arun_ungraded",
          runId: "0192d4a8-7c1e-7a00-8000-0000000000e2",
          seal: seal("0192d4a8-7c1e-7a00-8000-0000000000e2", {
            enforcementTier: null,
          }),
        }),
      ],
      [],
    );
    const out = await list({ limit: 50 }, ctx());
    const byId = new Map(out.runs.map((r) => [r.id, r]));
    expect(byId.get("arun_gateway")?.enforcementTier).toBe("gateway");
    // A seal written before the column existed was graded under `harness`;
    // reading it as anything else would raise a grade the record cannot carry.
    expect(byId.get("arun_ungraded")?.enforcementTier).toBe("harness");
  });

  it("carries the seal's gaps and drops a word the vocabulary does not name", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_gaps",
          session: {
            completenessGaps: ["digest_only", "not_a_gap_kind", 7],
          },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(out.runs[0]?.completenessGaps).toEqual(["digest_only"]);
  });

  it("says a digest_only recording cannot be summarised, matching what the handler refuses", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_digest",
          session: { completenessGaps: ["digest_only"] },
        }),
        tachoSession({
          publicId: "tse_bodies",
          session: { completenessGaps: [] },
        }),
        tachoSession({
          publicId: "tse_live",
          session: { outcome: "running", sealedAt: null },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    const byId = new Map(out.runs.map((r) => [r.id, r]));
    expect(byId.get("tse_digest")?.canSummarize).toBe(false);
    expect(byId.get("tse_bodies")?.canSummarize).toBe(true);
    // A live run has sealed nothing, so it has recorded no gaps — not "none".
    expect(byId.get("tse_live")?.canSummarize).toBe(false);
    expect(byId.get("tse_live")?.completenessGaps).toEqual([]);
  });
});

describe("a run row names who ran it, on what, with which model", () => {
  const db = drizzle.mock({ schema });
  const page = { cursor: null, limit: 50, withoutWitnessRuns: false };

  it("reads the host and the operator's name in the page's own statement, not per row", () => {
    const query = tachoPageQuery(db, SCOPE, page).toSQL();
    // One statement for the whole page. A lookup per row would be a hundred
    // round trips at the contract's maximum limit.
    expect(query.sql.match(/\bselect\b/gi)).toHaveLength(1);
    expect(query.sql).toContain('left join "tacho"."hosts"');
    expect(query.sql).toContain("machine_snapshot");
    expect(query.sql).toContain('to_jsonb("tacho"."sessions")');
    expect(query.sql).toContain('left join "auth"."users"');
  });

  it("joins the ledger page's operator name in its own statement too", () => {
    const query = ledgerPageQuery(db, SCOPE, page).toSQL();
    expect(query.sql.match(/\bselect\b/gi)).toHaveLength(1);
    expect(query.sql).toContain('left join "auth"."users"');
  });

  it("names the person only through a human principal", () => {
    // A delegated agent principal carries its creator's parent_user_id, so
    // the kind is part of the join and not a filter applied afterwards.
    for (const query of [
      tachoPageQuery(db, SCOPE, page).toSQL(),
      ledgerPageQuery(db, SCOPE, page).toSQL(),
    ]) {
      expect(query.sql).toMatch(
        /left join "auth"\."users" on \("auth"\."users"\."id" = "iam"\."principals"\."parent_user_id" and "iam"\."principals"\."kind" = \$\d+\)/,
      );
      expect(query.params).toContain("human");
    }
  });

  it("fills the operator, the model and the machine on a wrapped session", async () => {
    const { list } = handlerOver([], [tachoSession({ publicId: "tse_full" })]);
    const out = await list({ limit: 50 }, ctx());
    expect(out.runs[0]).toMatchObject({
      operatorId: "prn_0123456789abcdefghjkmn",
      operatorKind: "human",
      operatorName: "Marcus Bell",
      model: { id: "claude-sonnet-5", provider: "anthropic", tier: "sonnet" },
      machine: {
        hostname: "mac-studio.local",
        platform: "darwin",
        osVersion: "15.6",
        arch: "arm64",
        nodeVersion: "v24.4.0",
      },
    });
  });

  it("keeps session host observations separate from later enrollment metadata", async () => {
    const fixture = tachoSession({ publicId: "tse_snapshot" });
    const recorded = {
      platform: "linux",
      osVersion: "6.12",
      arch: "x64",
      recordedAt: "2026-09-20T00:00:00Z",
      eventHash: `sha256:${"a".repeat(64)}`,
    };
    fixture.session.machineSnapshot = recorded;
    const { list } = handlerOver([], [fixture]);
    expect((await list({ limit: 50 }, ctx())).runs[0]?.machine).toMatchObject({
      platform: "darwin",
      recorded,
    });
  });

  it("does not publish malformed stored machine facts as a runtime observation", async () => {
    const fixture = tachoSession({ publicId: "tse_malformed" });
    fixture.session.machineSnapshot = {
      platform: "linux",
      recordedAt: "not-a-date",
    };
    const { list } = handlerOver([], [fixture]);
    const machine = (await list({ limit: 50 }, ctx())).runs[0]?.machine;
    expect(machine).toMatchObject({ platform: "darwin" });
    expect(machine).not.toHaveProperty("recorded");
  });

  it("reports the model the session started on when it recorded no final one", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_open",
          session: { modelFinal: null, outcome: "running", sealedAt: null },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(out.runs[0]?.model).toEqual({
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tier: "haiku",
    });
  });

  it("answers a null model when the session recorded neither (negative)", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_nomodel",
          session: { modelInitial: null, modelFinal: null },
        }),
      ],
    );
    expect((await list({ limit: 50 }, ctx())).runs[0]?.model).toBeNull();
  });

  it("answers a null machine when the session names no host (negative)", async () => {
    const { list } = handlerOver(
      [],
      [tachoSession({ publicId: "tse_nohost", host: null })],
    );
    expect((await list({ limit: 50 }, ctx())).runs[0]?.machine).toBeNull();
  });

  it("separates an agent operator from a person with no name recorded", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_agentop",
          operatorKind: "agent",
          operatorUserName: null,
        }),
        tachoSession({
          publicId: "tse_nameless",
          operatorUserName: null,
          session: { startedAt: at("2026-09-11T08:00:00.000Z") },
        }),
      ],
    );
    const byId = Object.fromEntries(
      (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
    );
    expect(byId["tse_agentop"]).toMatchObject({
      operatorKind: "agent",
      operatorName: null,
    });
    expect(byId["tse_nameless"]).toMatchObject({
      operatorKind: "human",
      operatorName: null,
    });
  });

  it("reads a kind outside the CHECK as not recorded (negative)", async () => {
    const { list } = handlerOver(
      [],
      [tachoSession({ publicId: "tse_bad", operatorKind: "robot" })],
    );
    expect((await list({ limit: 50 }, ctx())).runs[0]?.operatorKind).toBeNull();
  });

  it("names no model and no machine on a ledger run", async () => {
    const { list } = handlerOver(
      [ledgerRun({ publicId: "arun_x", runId: RUN_A })],
      [],
    );
    expect(out(await list({ limit: 50 }, ctx()))).toMatchObject({
      model: null,
      machine: null,
      operatorKind: "human",
      operatorName: "Marcus Bell",
    });
  });
});

function out(page: { runs: readonly unknown[] }): unknown {
  return page.runs[0];
}

// The outcome each store recorded, carried rather than folded. A row's status
// says a run ended; only its outcome says how.
describe("run outcome", () => {
  it("carries the ledger's own word", () => {
    expect(ledgerRunOutcome("pending")).toBe("running");
    expect(ledgerRunOutcome("running")).toBe("running");
    expect(ledgerRunOutcome("completed")).toBe("completed");
    expect(ledgerRunOutcome("failed")).toBe("failed");
    expect(ledgerRunOutcome("cancelled")).toBe("cancelled");
  });

  it("keeps a failed ledger run apart from a completed one, which the status does not", () => {
    expect(ledgerRunStatus("failed")).toBe(ledgerRunStatus("completed"));
    expect(ledgerRunOutcome("failed")).not.toBe(ledgerRunOutcome("completed"));
  });

  it("reads a session's aborted as cancelled and leaves unknown unknown", () => {
    expect(tachoRunOutcome("running")).toBe("running");
    expect(tachoRunOutcome("completed")).toBe("completed");
    expect(tachoRunOutcome("aborted")).toBe("cancelled");
    expect(tachoRunOutcome("crashed")).toBe("crashed");
    expect(tachoRunOutcome("unknown")).toBe("unknown");
  });

  it("fails on a word outside either CHECK rather than guessing (negative)", () => {
    expect(() => ledgerRunOutcome("abandoned")).toThrow(RangeError);
    expect(() => tachoRunOutcome("abandoned")).toThrow(RangeError);
    // The status read guessed `sealed` here, which said the record was
    // complete when the row said nothing of the kind.
    expect(() => tachoRunStatus("abandoned")).toThrow(RangeError);
  });
});
