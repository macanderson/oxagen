import { schema } from "@oxagen/database";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  createRunListHandler,
  decodeRunCursor,
  encodeRunCursor,
  ledgerPageQuery,
  ledgerRollupQuery,
  ledgerSealQuery,
  tachoPageQuery,
  tachoSessionQuery,
  ledgerIdentityQuery,
} from "./run.list";
import {
  ctx,
  ledgerRun,
  memoryStores,
  OTHER_WORKSPACE,
  SCOPE,
  seal,
  tachoSession,
  usage,
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

  it("maps a tacho session with no cost_basis to cost null, never 0", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_nobasis",
          session: { totalCostMicros: 0, costBasis: null },
        }),
        tachoSession({
          publicId: "tse_priced",
          session: {
            startedAt: at("2026-09-11T09:01:00.000Z"),
            totalCostMicros: 97_937,
            costBasis: "list",
          },
        }),
        tachoSession({
          publicId: "tse_unknownbasis",
          session: {
            startedAt: at("2026-09-11T09:02:00.000Z"),
            totalCostMicros: 50,
            costBasis: "unknown",
          },
        }),
        tachoSession({
          publicId: "tse_unpriced",
          session: {
            startedAt: at("2026-09-11T09:03:00.000Z"),
            totalCostMicros: 50,
            costBasis: "list",
            hasUnknownModelCost: true,
          },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    const cost = Object.fromEntries(out.runs.map((r) => [r.id, r.cost]));
    expect(cost["tse_nobasis"]).toBeNull();
    expect(cost["tse_unknownbasis"]).toBeNull();
    expect(cost["tse_unpriced"]).toBeNull();
    expect(cost["tse_priced"]).toEqual({
      micros: "97937",
      currency: "USD",
      basis: "client_attested",
    });
    expect(JSON.stringify(out)).not.toContain('"micros":"0"');
  });

  it("costs a ledger run from gateway-metered token usage and leaves an unmetered one null", async () => {
    const { list, stores } = handlerOver(
      [
        ledgerRun({ publicId: "arun_metered", runId: RUN_A, usage: usage() }),
        ledgerRun({
          publicId: "arun_unmetered",
          runId: RUN_B,
          run: {
            runId: RUN_B,
            publicId: "arun_unmetered",
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
      [],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(out.runs.map((r) => [r.id, r.cost])).toEqual([
      ["arun_unmetered", null],
      [
        "arun_metered",
        { micros: "12500", currency: "USD", basis: "gateway_observed" },
      ],
    ]);
    // One ClickHouse read for the page, over exactly the ledger runs on it.
    expect(stores.usageCalls).toEqual([[RUN_B, RUN_A]]);
    // A run with no started_at is placed by its created_at.
    expect(out.runs[0]?.startedAt).toBe("2026-09-11T11:00:00.000Z");
  });

  it("does not read ClickHouse when the page holds no ledger run", async () => {
    const { list, stores } = handlerOver(
      [],
      [tachoSession({ publicId: "tse_a" })],
    );
    await list({ limit: 50 }, ctx());
    expect(stores.usageCalls).toEqual([]);
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
            goal: null,
          },
        }),
      ],
      [tachoSession({ publicId: "tse_anon", operatorPublicId: null })],
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
  const page = { cursor: null, limit: 50 };
  const RUN = "0192d4a8-7c1e-7a00-8000-0000000000a1";
  const cases = [
    ["ledgerPageQuery", ledgerPageQuery(db, SCOPE, page).toSQL()],
    ["ledgerIdentityQuery", ledgerIdentityQuery(db, SCOPE, RUN).toSQL()],
    ["ledgerRollupQuery", ledgerRollupQuery(db, SCOPE, [RUN]).toSQL()],
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

  it("a different scope binds different tenant ids (negative)", () => {
    const query = ledgerPageQuery(db, OTHER_WORKSPACE, page).toSQL();
    expect(query.params).not.toContain(SCOPE.workspaceId);
    expect(query.params).toContain(OTHER_WORKSPACE.workspaceId);
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

  it("applies the cursor at millisecond precision with byte-order ties, reading one row past the page", () => {
    const cursor = { at: "2026-09-11T10:00:00.000Z", id: "arun_a" };
    const ledger = ledgerPageQuery(db, SCOPE, { cursor, limit: 10 }).toSQL();
    expect(ledger.sql).toContain("date_trunc('milliseconds'");
    expect(ledger.sql).toContain('collate "C"');
    expect(ledger.params).toEqual(expect.arrayContaining(["arun_a", 11]));
    const tacho = tachoPageQuery(db, SCOPE, { cursor, limit: 10 }).toSQL();
    expect(tacho.params).toEqual(expect.arrayContaining(["arun_a", 11]));
  });
});
