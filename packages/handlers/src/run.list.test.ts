import { schema } from "@oxagen/database";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  HOST_POLL_WINDOW_MS,
  runList,
} from "@oxagen/oxagen/contracts/run.list";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";
import {
  beforeCursor,
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
  tachoRunName,
  tachoRunStatus,
  costIsEstimate,
  recordedSealSource,
  LEDGER_LIVE_STATUSES,
  liveCountQueries,
  TACHO_LIVE_OUTCOMES,
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

/** The clock the live count is read against. */
const NOW = new Date("2026-09-25T12:00:00.000Z");

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
  it("hides generated text when enrichment is off while preserving recorded facts", async () => {
    const stores = memoryStores(
      [],
      [
        tachoSession({
          publicId: "tse_off",
          session: { name: "Generated task", title: "Derived prompt" },
        }),
      ],
    );
    const list = createRunListHandler({
      ...stores,
      readEnrichmentEnabled: async () => false,
    });
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run).toMatchObject({
      name: null,
      summary: null,
      enrichmentEnabled: false,
      canSummarize: false,
      frames: 207,
      harness: { name: "Claude Code", version: "2.1.0" },
    });
  });

  it("keeps the harness's own title when enrichment is off", async () => {
    const stores = memoryStores(
      [],
      [
        tachoSession({
          publicId: "tse_titled",
          session: {
            harnessTitle: "tacho installer daemon reliability",
            name: "Generated task",
            title: "oxagen · 6 files",
          },
        }),
      ],
    );
    const list = createRunListHandler({
      ...stores,
      readEnrichmentEnabled: async () => false,
    });
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run).toMatchObject({
      name: "tacho installer daemon reliability",
      summary: null,
    });
  });

  it("names a wrapped session by the harness title, then the written name, then the derived title", async () => {
    const stores = memoryStores(
      [],
      [
        tachoSession({
          publicId: "tse_harness",
          session: {
            harnessTitle: "tacho installer daemon reliability",
            name: "Model name",
            title: "oxagen · 6 files",
          },
        }),
      ],
    );
    const list = createRunListHandler(stores);
    const out = await list({ limit: 50 }, ctx());
    expect(runList.output.parse(out)).toEqual(out);
    expect(out.runs[0]?.name).toBe("tacho installer daemon reliability");
  });

  // #4224: neither a harness title nor a ledger run's goal has a bound where
  // it is written, so a page could carry a name or task reference of any
  // length.
  describe("a run's name and task reference", () => {
    const long = `${"a".repeat(254)}😀${"a".repeat(44)}`;
    const cut = `${"a".repeat(254)}…`;

    it("cuts a long harness title to the display cap on a code-point boundary", async () => {
      const { list } = handlerOver(
        [],
        [
          tachoSession({
            publicId: "tse_long",
            session: { harnessTitle: long },
          }),
        ],
      );
      const out = await list({ limit: 50 }, ctx());
      expect(out.runs[0]?.name).toBe(cut);
      expect(runList.output.parse(out)).toEqual(out);
    });

    it("cuts a long harness title when enrichment is off", async () => {
      const stores = memoryStores(
        [],
        [
          tachoSession({
            publicId: "tse_long",
            session: { harnessTitle: long },
          }),
        ],
      );
      const list = createRunListHandler({
        ...stores,
        readEnrichmentEnabled: async () => false,
      });
      const out = await list({ limit: 50 }, ctx());
      expect(out.runs[0]?.name).toBe(cut);
      expect(runList.output.parse(out)).toEqual(out);
    });

    it("cuts a ledger run's goal and name to the display cap", async () => {
      const { list } = handlerOver(
        [
          ledgerRun({
            publicId: "arun_long",
            runId: RUN_A,
            run: {
              runId: RUN_A,
              publicId: "arun_long",
              status: "completed",
              createdAt: at("2026-09-11T10:00:00.000Z"),
              startedAt: at("2026-09-11T10:00:01.000Z"),
              name: "n".repeat(300),
              summary: null,
              summaryGeneratedAt: null,
              summaryModel: null,
            },
            identity: {
              orgNamespace: "acme",
              workspaceNamespace: "core",
              agentSlug: "reviewer",
              operatorPublicId: null,
              operatorKind: null,
              operatorUserName: null,
              goal: "g".repeat(8192),
            },
          }),
        ],
        [],
      );
      const out = await list({ limit: 50 }, ctx());
      expect(out.runs[0]?.taskRef).toBe(`${"g".repeat(255)}…`);
      expect(out.runs[0]?.name).toBe(`${"n".repeat(255)}…`);
      expect(runList.output.parse(out)).toEqual(out);
    });
  });

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

  it("refuses a signed year Date.parse accepts and Postgres does not (negative)", () => {
    // The filtered read casts the instant to timestamptz, which refuses this
    // year, so a cursor that passed a Date.parse check came back as a 500.
    const crafted = Buffer.from(
      JSON.stringify(["-000001-01-01T00:00:00.000Z", "tse_x"]),
      "utf8",
    ).toString("base64url");
    expect(decodeRunCursor(crafted)).toBeNull();
    expect(
      decodeRunCursor(
        encodeRunCursor({ at: "2026-09-11 10:00:00+00", id: "tse_x" }),
      ),
    ).toBeNull();
  });

  it("binds the cursor instant as a string the driver can send (negative)", () => {
    // Production paged with a JS Date in a raw `sql` fragment. postgres.js has
    // no serializer for that param and threw "The string argument must be of
    // type string or an instance of Buffer": page one loaded, every later page
    // was a 500. The mocked queries above never reach the driver, so this
    // compiles the predicate and checks what the driver would receive.
    const cursor = {
      at: "2026-09-20T07:33:36.659Z",
      id: "tse_nnktff51cryamp5betw49m",
    };
    const predicate = beforeCursor(
      sql`${schema.tachoSessions.startedAt}`,
      schema.tachoSessions.publicId,
      cursor,
    );
    expect(predicate).toBeDefined();
    const query = new PgDialect().sqlToQuery(
      predicate as NonNullable<typeof predicate>,
    );
    for (const param of query.params) {
      expect(typeof param).toBe("string");
    }
    expect(query.params).toEqual([cursor.at, cursor.at, cursor.id]);
    expect(query.sql).toContain("::timestamptz");
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

  // #4224. A ledger run's goal can run to kilobytes and the page shows at
  // most 256 characters of it. The select cuts it at 257, one past the cap,
  // which is enough for `runLabel` to draw the same label.
  it("cuts a ledger run's goal in the select, one past the label cap", () => {
    for (const query of [
      ledgerPageQuery(db, SCOPE, page).toSQL(),
      ledgerIdentityQuery(db, SCOPE, RUN).toSQL(),
    ]) {
      expect(query.sql).toMatch(
        /left\((?:"agent"\."agent_runs"\.)?"spec"->>'goal', 257\)/,
      );
    }
  });

  it("counts live runs over the same runs the pages list, with no cursor and no page size (A-04)", () => {
    const counts = liveCountQueries(
      db,
      SCOPE,
      { withoutWitnessRuns: false },
      NOW,
    );
    const ledger = counts.ledger.toSQL();
    expect(ledger.sql).toMatch(
      /^select count\(\*\)::int from "agent"\."agent_runs"/,
    );
    expect(ledger.sql).toContain('"agent"."agent_runs"."spec_version" = $');
    expect(ledger.sql).toContain('"agent"."agent_runs"."surface" not in');
    expect(ledger.sql).toContain('"agent"."agent_runs"."status" in');
    expect(ledger.params).toEqual(
      expect.arrayContaining([
        SCOPE.orgId,
        SCOPE.workspaceId,
        "pending",
        "running",
      ]),
    );
    const tacho = counts.tacho.toSQL();
    expect(tacho.sql).toMatch(
      /^select count\(\*\)::int from "tacho"\."sessions"/,
    );
    expect(tacho.sql).toContain(
      '"tacho"."sessions"."parent_session_uuid" is null',
    );
    expect(tacho.sql).toContain('"tacho"."sessions"."outcome" in');
    expect(tacho.params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, "running"]),
    );
    // Negative: a count is the workspace's, so no cursor, order or limit.
    for (const query of [ledger, tacho]) {
      expect(query.sql).not.toMatch(/\border by\b|\blimit\b/);
      expect(query.sql).not.toMatch(/"evidence"\."verdicts"/);
    }
    // An API-key caller's count leaves witness runs out, as its pages do.
    const hidden = liveCountQueries(
      db,
      SCOPE,
      { withoutWitnessRuns: true },
      NOW,
    );
    for (const query of [hidden.ledger.toSQL(), hidden.tacho.toSQL()])
      expect(query.sql).toMatch(
        /not exists \(select 1 from "evidence"\."verdicts"/,
      );
  });

  it("leaves out of the count a session whose row reads stale: its host revoked or quiet past the poll window (#4343 review)", () => {
    // The tile counted three live runs above three rows that said stale.
    const tacho = liveCountQueries(
      db,
      SCOPE,
      { withoutWitnessRuns: false },
      NOW,
    ).tacho.toSQL();
    expect(tacho.sql).toContain('left join "tacho"."hosts"');
    expect(tacho.sql).toMatch(
      /"tacho"\."hosts"\."id" is null or \("tacho"\."hosts"\."status" <> \$\d+ and "tacho"\."hosts"\."last_seen_at" >= \$\d+\)/,
    );
    expect(tacho.params).toContain("revoked");
    // The same window `commandBlockOf` reads, on the handler's clock.
    const cutoff = new Date(NOW.getTime() - HOST_POLL_WINDOW_MS);
    expect(
      tacho.params.some(
        (param) =>
          param instanceof Date && param.getTime() === cutoff.getTime(),
      ) || tacho.params.includes(cutoff.toISOString()),
    ).toBe(true);
    // The ledger records no host, so its count is unchanged.
    const ledger = liveCountQueries(
      db,
      SCOPE,
      { withoutWitnessRuns: false },
      NOW,
    ).ledger.toSQL();
    expect(ledger.sql).not.toContain('"tacho"."hosts"');
  });

  it("counts as live exactly the statuses and outcomes a row reads as live (A-04)", () => {
    expect([...LEDGER_LIVE_STATUSES].sort()).toEqual(["pending", "running"]);
    for (const status of [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
    ])
      expect(LEDGER_LIVE_STATUSES.includes(status)).toBe(
        ledgerRunStatus(status) === "live",
      );
    for (const outcome of schema.TACHO_SESSION_OUTCOMES)
      expect(TACHO_LIVE_OUTCOMES.includes(outcome)).toBe(
        tachoRunStatus(outcome) === "live",
      );
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

  it("counts a model call with no turn index as hiding the turn count", () => {
    // An engine call's payload is inline and names no `turn_index`. Testing
    // for a null payload alone listed such a run with zero turns, while the
    // seal's rollup (`deriveSealRollup`) records `null` for the same rows, so
    // the count changed when compaction ran (#3372, finding 4).
    const { sql } = ledgerRollupQuery(db, SCOPE, [RUN]).toSQL();
    expect(sql).toMatch(
      /count\(\*\) filter \(where "agent"\."agent_run_events"\."event_type" in \(.*\) and \("agent"\."agent_run_events"\."payload_inline" is null or "agent"\."agent_run_events"\."payload_inline"->>'turn_index' is null\)\)/,
    );
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
    // Spelled out, so the partial `(attempt_id, attempt_seq)` index serves
    // the probe.
    expect(compacted.sql).toMatch(
      /"agent_run_events"\."attempt_id" = "agent"\."agent_run_attempt_seals"\."attempt_id" and "agent"\."agent_run_events"\."event_record_version" = 2\)/,
    );
  });

  it("writes the event record version as a literal, so the partial run index matches", () => {
    const hot = ledgerRollupQuery(db, SCOPE, [RUN]).toSQL();
    expect(hot.sql).toMatch(/"agent_run_events"\."event_record_version" = 2/);
    // Not a bind parameter: a generic plan cannot prove `$1 = 2`.
    expect(hot.sql).not.toMatch(/"event_record_version" = \$\d/);
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

// ADR-163, #4023: the row answers `dispatch_command`'s own rule, so the page
// offers the controls on an observe-tier run whose host is polling and
// withholds them, with the reason, where no host would take the command.
describe("a run row says whether a command can reach it", () => {
  const host = (status: string, secondsAgo: number | null) => ({
    hostname: "mac-studio.local",
    platform: "darwin",
    osVersion: "15.6",
    arch: "arm64",
    nodeVersion: "v24.4.0",
    status,
    lastSeenAt:
      secondsAgo === null ? null : new Date(Date.now() - secondsAgo * 1000),
  });
  const live = { outcome: "running", sealedAt: null };

  it("reads the host's liveness in the page's own statement", () => {
    const db = drizzle.mock({ schema });
    const query = tachoPageQuery(db, SCOPE, {
      cursor: null,
      limit: 50,
      withoutWitnessRuns: false,
    }).toSQL();
    expect(query.sql).toContain('"tacho"."hosts"."last_seen_at"');
    expect(query.sql).toContain('"tacho"."hosts"."status"');
  });

  it("answers null for a live observe-tier run whose host polled a minute ago", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_observe",
          session: { ...live, enforcementTier: "observe" },
          host: host("active", 60),
        }),
      ],
    );
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run?.enforcementTier).toBe("observe");
    expect(run?.commandBlock).toBeNull();
  });

  it("names why a command cannot reach the run (negative)", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_quiet",
          session: live,
          host: host("active", 3 * 24 * 3600),
        }),
        tachoSession({
          publicId: "tse_revoked",
          session: live,
          host: host("revoked", 10),
        }),
        tachoSession({
          publicId: "tse_hostless",
          session: live,
          host: null,
        }),
        tachoSession({ publicId: "tse_sealed", host: host("active", 10) }),
      ],
    );
    const byId = new Map(
      (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
    );
    expect(byId.get("tse_quiet")?.commandBlock).toBe("host_offline");
    expect(byId.get("tse_revoked")?.commandBlock).toBe("host_revoked");
    expect(byId.get("tse_hostless")?.commandBlock).toBe("no_host");
    expect(byId.get("tse_sealed")?.commandBlock).toBe("run_sealed");
  });

  it("offers commands on a run Oxagen closed for silence while its host still polls (#3980)", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_idle",
          session: {
            outcome: "unknown",
            sealedAt: new Date("2026-09-15T21:00:00.000Z"),
            sealSource: "idle_timeout",
          },
          host: host("active", 10),
        }),
        tachoSession({
          publicId: "tse_stopped",
          session: { sealSource: "agent_stop" },
          host: host("active", 10),
        }),
      ],
    );
    const byId = new Map(
      (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
    );
    // The close is an inference, so a command queues for the host to take.
    expect(byId.get("tse_idle")?.commandBlock).toBeNull();
    // The host's own stop is final.
    expect(byId.get("tse_stopped")?.commandBlock).toBe("run_sealed");
  });

  it("lists a run an operator sealed as sealed and final, with its seal source (#4073)", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_operator",
          session: {
            outcome: "unknown",
            sealedAt: new Date("2026-09-15T21:00:00.000Z"),
            sealSource: "operator",
          },
          host: host("active", 10),
        }),
      ],
    );
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run).toMatchObject({
      status: "sealed",
      sealSource: "operator",
      // Final like the host's own stop: no command reaches it.
      commandBlock: "run_sealed",
    });
  });

  // #4023: Stella reads steering text only at session start, so its row
  // offers pause, resume and cancel but not Steer.
  it("names a Stella run's steer block and leaves its other commands open", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_stella",
          session: { ...live, runtime: "stella" },
          host: host("active", 60),
        }),
        tachoSession({
          publicId: "tse_claude",
          session: { ...live, runtime: "claude-code" },
          host: host("active", 60),
        }),
      ],
    );
    const byId = new Map(
      (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
    );
    expect(byId.get("tse_stella")).toMatchObject({
      commandBlock: null,
      steerBlock: "no_prompt_carrier",
    });
    expect(byId.get("tse_claude")?.steerBlock).toBeNull();
  });

  it("answers null on a ledger run, whose controls fence ingress", async () => {
    const { list } = handlerOver(
      [ledgerRun({ publicId: "arun_a", runId: RUN_A })],
      [],
    );
    expect((await list({ limit: 50 }, ctx())).runs[0]?.commandBlock).toBeNull();
  });
});

describe("a wrapped run row says whether its host holds it paused (#4112)", () => {
  const live = { outcome: "running", sealedAt: null };

  it("reads the last applied pause or resume in the page's own statement", () => {
    const db = drizzle.mock({ schema });
    const page = tachoPageQuery(db, SCOPE, {
      cursor: null,
      limit: 50,
      withoutWitnessRuns: false,
    }).toSQL();
    const one = tachoSessionQuery(db, SCOPE, "tse_a").toSQL();
    for (const query of [page, one]) {
      expect(query.sql).toContain('from "tacho"."control_commands"');
      // Correlated on the outer session, through the target index's columns.
      expect(query.sql).toContain(
        '"tacho"."control_commands"."target_id" = "tacho"."sessions"."public_id"',
      );
      expect(query.sql).toContain("in ('pause', 'resume')");
      expect(query.sql).toContain(
        `"tacho"."control_commands"."outcome" = 'applied'`,
      );
    }
  });

  it("answers paused for a live run whose host applied a pause, and not once it applied a resume", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_paused",
          session: { ...live, paused: true },
        }),
        tachoSession({
          publicId: "tse_resumed",
          session: { ...live, paused: false },
        }),
      ],
    );
    const byId = new Map(
      (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
    );
    expect(byId.get("tse_paused")?.ingressPaused).toBe(true);
    expect(byId.get("tse_resumed")?.ingressPaused).toBe(false);
  });

  it("reads a sealed run as not paused, whatever pause it ended under (negative)", async () => {
    const { list } = handlerOver(
      [],
      [tachoSession({ publicId: "tse_sealed", session: { paused: true } })],
    );
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run?.status).toBe("sealed");
    expect(run?.ingressPaused).toBe(false);
  });

  it("omits the flag where the reader selected no commands", async () => {
    const { list } = handlerOver(
      [],
      [tachoSession({ publicId: "tse_unread", session: live })],
    );
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run).not.toHaveProperty("ingressPaused");
  });
});

describe("a run row names who ran it, on what, with which model", () => {
  const db = drizzle.mock({ schema });
  const page = { cursor: null, limit: 50, withoutWitnessRuns: false };

  it("reads the host and the operator's name in the page's own statement, not per row", () => {
    const query = tachoPageQuery(db, SCOPE, page).toSQL();
    // One statement for the whole page. A lookup per row would be a hundred
    // round trips at the contract's maximum limit. The second `select` is
    // the correlated read of the last applied pause or resume, which runs
    // inside this same statement.
    expect(query.sql.match(/\bselect\b/gi)).toHaveLength(2);
    expect(query.sql).toMatch(/coalesce\(\(\s*select\b/i);
    expect(query.sql).toContain('left join "tacho"."hosts"');
    expect(query.sql).toContain("machine_snapshot");
    // `to_jsonb` takes the FROM-clause's own correlation name, which is
    // never schema-qualified even though every column reference is
    // (see the comment on `machineSnapshot` in run.list.ts).
    expect(query.sql).toContain('to_jsonb("sessions")');
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

  it("answers the workspace's live runs, not the page's, whatever the filter (A-04)", async () => {
    // Fleet's Live runs tile counted the live rows of one page after the
    // state chip, under a label that claims the workspace.
    const stores = memoryStores(
      [],
      [
        tachoSession({
          publicId: "tse_a",
          session: { outcome: "running", sealedAt: null },
        }),
        tachoSession({
          publicId: "tse_b",
          session: { outcome: "running", sealedAt: null },
        }),
      ],
    );
    const asked: unknown[] = [];
    const list = createRunListHandler({
      ...stores,
      readLiveCount: (scope, q, now) => {
        asked.push({ scope, q, now: now instanceof Date });
        return Promise.resolve(7);
      },
    });
    const out = await list({ limit: 1, countLive: true }, ctx());
    expect(runList.output.parse(out)).toEqual(out);
    expect(out.runs).toHaveLength(1);
    expect(out.liveRuns).toBe(7);
    expect(asked).toEqual([
      { scope: SCOPE, q: { withoutWitnessRuns: false }, now: true },
    ]);
    const filtered = await list(
      { limit: 1, pullRequests: "with", countLive: true },
      ctx(),
    );
    expect(filtered.liveRuns).toBe(7);
  });

  it("counts nothing for a caller that does not ask for the count (negative, #4343 review)", async () => {
    // The count read every root session on every list_runs call: each page,
    // each cursor, the API, MCP and agent surfaces, and the Agents page.
    const stores = memoryStores([], [tachoSession({ publicId: "tse_a" })]);
    const readLiveCount = vi.fn(() => Promise.resolve(7));
    const list = createRunListHandler({ ...stores, readLiveCount });
    const out = await list({ limit: 50 }, ctx());
    const declined = await list({ limit: 50, countLive: false }, ctx());
    expect(readLiveCount).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty("liveRuns");
    expect(declined).not.toHaveProperty("liveRuns");
    expect(out.runs).toHaveLength(1);
  });

  it("leaves the live count out, and still answers the page, when the count fails (negative)", async () => {
    const stores = memoryStores([], [tachoSession({ publicId: "tse_a" })]);
    const list = createRunListHandler({
      ...stores,
      readLiveCount: () => Promise.reject(new Error("postgres timeout")),
    });
    const out = await list({ limit: 50, countLive: true }, ctx());
    expect(out.runs).toHaveLength(1);
    expect(out).not.toHaveProperty("liveRuns");
  });

  it("says where a wrapped session ran, as its start recorded it, and nothing for a ledger run (A-05)", async () => {
    // The Run header drew "repository and branch not captured" whenever the
    // work read was pending or failed, though the session row held both.
    const { list } = handlerOver(
      [ledgerRun({ publicId: "arun_place", runId: RUN_A })],
      [
        tachoSession({
          publicId: "tse_place",
          session: { cwd: "/Users/mb/src/platform", gitBranch: "main" },
        }),
        tachoSession({
          publicId: "tse_worktree",
          session: {
            cwd: "/Users/mb/src/platform/.worktrees/fix",
            gitBranch: "main",
            worktreeBranch: "fix/tags",
          },
        }),
        tachoSession({
          publicId: "tse_nowhere",
          session: { cwd: " ", gitBranch: null, worktreeBranch: null },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(runList.output.parse(out)).toEqual(out);
    const place = (id: string) => out.runs.find((r) => r.id === id)?.place;
    expect(place("tse_place")).toEqual({
      path: "/Users/mb/src/platform",
      branch: "main",
    });
    // A session in a worktree worked on the worktree's branch.
    expect(place("tse_worktree")).toEqual({
      path: "/Users/mb/src/platform/.worktrees/fix",
      branch: "fix/tags",
    });
    // Negative: a blank column is unrecorded, and a ledger run has no host.
    expect(place("tse_nowhere")).toBeNull();
    expect(place("arun_place")).toBeNull();
  });

  it("names the path in get_run_work's order: the worktree, the project, then the working directory (#4343 review)", async () => {
    // The strip paired the worktree's branch with the working directory, so
    // before the work read answered it named a folder that read did not.
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_nested",
          session: {
            cwd: "/Users/mb/src/platform/packages/api",
            projectDir: "/Users/mb/src/platform",
            worktreePath: "/Users/mb/src/platform/.worktrees/tags",
            gitBranch: "main",
            worktreeBranch: "fix/tags",
          },
        }),
        tachoSession({
          publicId: "tse_project",
          session: {
            cwd: "/Users/mb/src/platform/packages/api",
            projectDir: "/Users/mb/src/platform",
            worktreePath: "",
            gitBranch: "main",
          },
        }),
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    const place = (id: string) => out.runs.find((r) => r.id === id)?.place;
    expect(place("tse_nested")).toEqual({
      path: "/Users/mb/src/platform/.worktrees/tags",
      branch: "fix/tags",
    });
    // Negative: a blank worktree path falls through to the project directory.
    expect(place("tse_project")).toEqual({
      path: "/Users/mb/src/platform",
      branch: "main",
    });
  });

  it("selects the session's place in the page's own statement (A-05)", () => {
    const query = tachoPageQuery(db, SCOPE, page).toSQL();
    expect(query.sql).toContain('"tacho"."sessions"."cwd"');
    expect(query.sql).toContain('"tacho"."sessions"."project_dir"');
    expect(query.sql).toContain('"tacho"."sessions"."worktree_path"');
    expect(query.sql).toContain('"tacho"."sessions"."git_branch"');
    expect(query.sql).toContain('"tacho"."sessions"."worktree_branch"');
  });

  // #4024: ingest attributes a wrapped session to whoever enrolled the host,
  // so the row says so; a ledger run names the principal it was admitted for.
  it("marks a wrapped session's operator as the host's enroller", async () => {
    const { list } = handlerOver(
      [ledgerRun({ publicId: "arun_op", runId: RUN_A })],
      [
        tachoSession({ publicId: "tse_op" }),
        tachoSession({
          publicId: "tse_noop",
          operatorPublicId: null,
          operatorKind: null,
          operatorUserName: null,
        }),
      ],
    );
    const byId = Object.fromEntries(
      (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
    );
    expect(byId["tse_op"]?.operatorAttribution).toBe("host_enroller");
    expect(byId["tse_noop"]?.operatorAttribution).toBeNull();
    expect(byId["arun_op"]?.operatorAttribution).toBe("initiator");
  });

  // #3999: the operator's workspace role is the value stamped when the run
  // opened (ADR-197), read back as stamped.
  describe("the operator's role", () => {
    const stampedLedger = (publicId: string, runId: string, role: string) => {
      const base = ledgerRun({ publicId, runId });
      return { ...base, run: { ...base.run, operatorRole: role } };
    };

    it("answers the stamped role on a wrapped session and a ledger run", async () => {
      const { list } = handlerOver(
        [stampedLedger("arun_role", RUN_A, "member")],
        [
          tachoSession({
            publicId: "tse_role",
            session: { operatorRole: "admin" },
          }),
        ],
      );
      const byId = Object.fromEntries(
        (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
      );
      expect(byId["tse_role"]?.operatorRole).toBe("admin");
      expect(byId["arun_role"]?.operatorRole).toBe("member");
    });

    it("answers null for a run recorded before the stamp", async () => {
      // The fixtures carry no `operatorRole`, as a row from before the column
      // reads: not recorded, never today's role.
      const { list } = handlerOver(
        [ledgerRun({ publicId: "arun_old", runId: RUN_A })],
        [tachoSession({ publicId: "tse_old" })],
      );
      for (const run of (await list({ limit: 50 }, ctx())).runs)
        expect(run.operatorRole).toBeNull();
    });

    it("answers null for an operator who is not a person, whatever the column holds", async () => {
      const { list } = handlerOver(
        [],
        [
          tachoSession({
            publicId: "tse_agent",
            operatorKind: "agent",
            session: { operatorRole: "owner" },
          }),
        ],
      );
      expect((await list({ limit: 50 }, ctx())).runs[0]?.operatorRole).toBeNull();
    });

    it("reads a value outside the six roles as not recorded", async () => {
      const { list } = handlerOver(
        [],
        [
          tachoSession({
            publicId: "tse_odd",
            session: { operatorRole: "superuser" },
          }),
        ],
      );
      expect((await list({ limit: 50 }, ctx())).runs[0]?.operatorRole).toBeNull();
    });

    it("never joins the membership table, so a later role change cannot reach the row", () => {
      // The stamp wins over a role changed after the run opened because the
      // read has no other source: both queries select the stamped column and
      // neither names `workspace_users`.
      for (const query of [
        tachoPageQuery(db, SCOPE, page).toSQL(),
        ledgerPageQuery(db, SCOPE, page).toSQL(),
      ]) {
        expect(query.sql).toMatch(/"operator_role"/);
        expect(query.sql).not.toContain("workspace_users");
      }
    });
  });

  // #4024: `sealed_at` is when the server received the stop; the wall clock
  // ends at the stop event's own timestamp.
  it("reports a wrapped session's end from the stop event, not the seal receipt", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_ended",
          session: {
            endedAt: at("2026-09-11T09:04:30.000Z"),
            sealedAt: at("2026-09-11T09:05:00.000Z"),
          },
        }),
        tachoSession({
          publicId: "tse_open",
          session: {
            outcome: "running",
            endedAt: null,
            sealedAt: null,
            startedAt: at("2026-09-11T07:00:00.000Z"),
          },
        }),
      ],
    );
    const byId = Object.fromEntries(
      (await list({ limit: 50 }, ctx())).runs.map((r) => [r.id, r]),
    );
    expect(byId["tse_ended"]).toMatchObject({
      endedAt: "2026-09-11T09:04:30.000Z",
      sealedAt: "2026-09-11T09:05:00.000Z",
    });
    expect(byId["tse_open"]).toMatchObject({ endedAt: null, sealedAt: null });
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

  it("reports the effort, the final permission mode and the token counters the session recorded", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_facts",
          session: {
            effort: "high",
            permissionModeInitial: "default",
            permissionModeFinal: "acceptEdits",
            inputTokens: 1200,
            outputTokens: 340,
            cacheReadTokens: 56000,
            cacheCreationTokens: 7800,
          },
        }),
      ],
    );
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run?.effort).toBe("high");
    expect(run?.permissionMode).toBe("acceptEdits");
    expect(run?.reportedTokens).toEqual({
      input: 1200,
      output: 340,
      cacheRead: 56000,
      cacheWrite: 7800,
    });
  });

  it("falls back to the first permission mode and answers null for unrecorded facts (negative)", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_nofacts",
          session: {
            effort: null,
            permissionModeInitial: "plan",
            permissionModeFinal: null,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
      ],
    );
    const run = (await list({ limit: 50 }, ctx())).runs[0];
    expect(run?.effort).toBeNull();
    expect(run?.permissionMode).toBe("plan");
    expect(run?.reportedTokens).toBeNull();
  });

  it("preserves the recorded harness version separately from the model", async () => {
    const { list } = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_harness",
          session: {
            harness: "codex",
            harnessVersion: "0.115.0",
            runtime: "codex",
          },
        }),
      ],
    );
    expect((await list({ limit: 50 }, ctx())).runs[0]?.harness).toEqual({
      name: "codex",
      version: "0.115.0",
      runtime: "codex",
    });
    const missing = handlerOver(
      [],
      [
        tachoSession({
          publicId: "tse_missing",
          session: { harnessVersion: null },
        }),
      ],
    );
    expect(
      (await missing.list({ limit: 50 }, ctx())).runs[0]?.harness?.version,
    ).toBeNull();
  });

  it("answers every row's harness key, null where none was recorded (#3790)", async () => {
    const { list } = handlerOver(
      [ledgerRun({ publicId: "arun_ledger", runId: RUN_A })],
      [
        tachoSession({ publicId: "tse_wrapped" }),
        tachoSession({
          publicId: "tse_unrecorded",
          session: { harness: "", harnessVersion: null },
        }),
      ],
    );
    const out = runList.output.parse(await list({ limit: 50 }, ctx()));
    const byId = new Map(out.runs.map((run) => [run.id, run]));
    // The key is present on each row, so an API or MCP reader sees null
    // rather than a missing field.
    for (const run of out.runs) expect(run).toHaveProperty("harness");
    expect(byId.get("arun_ledger")?.harness).toBeNull();
    expect(byId.get("tse_unrecorded")?.harness).toBeNull();
    expect(byId.get("tse_wrapped")?.harness).toEqual({
      name: "Claude Code",
      version: "2.1.0",
      runtime: "claude-code",
    });
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

describe("an open run's cost and what sealed a run (#3980)", () => {
  const cost = {
    costMicros: 900n,
    currency: "USD",
    costBasis: "client_attested" as const,
  };
  const sealed = at("2026-09-11T10:05:00.000Z");

  it("reads a priced open run as an estimate", () => {
    expect(costIsEstimate(null, { cost, verdict: null, sealedAt: null })).toBe(
      true,
    );
  });

  it("reads a sealed run whose row predates the seal as an estimate", () => {
    expect(
      costIsEstimate(sealed, { cost, verdict: null, sealedAt: null }),
    ).toBe(true);
  });

  it("reads a sealed run rolled up after its seal as final", () => {
    expect(
      costIsEstimate(sealed, { cost, verdict: null, sealedAt: sealed }),
    ).toBe(false);
  });

  it("calls no cost an estimate (negative)", () => {
    expect(costIsEstimate(null, undefined)).toBe(false);
    expect(
      costIsEstimate(null, { cost: null, verdict: null, sealedAt: null }),
    ).toBe(false);
  });

  it("names the idle close, and reads every other seal as the host's own", () => {
    expect(recordedSealSource(sealed, "idle_timeout")).toBe("idle_timeout");
    expect(recordedSealSource(sealed, "agent_stop")).toBe("agent_stop");
    // Sealed before the column existed: only an agent_stop sealed then.
    expect(recordedSealSource(sealed, null)).toBe("agent_stop");
    expect(recordedSealSource(null, "idle_timeout")).toBeNull();
  });

  it("names an operator's seal (#4073)", () => {
    expect(recordedSealSource(sealed, "operator")).toBe("operator");
    expect(recordedSealSource(null, "operator")).toBeNull();
  });

  it("refuses a seal source outside the CHECK (negative)", () => {
    expect(() => recordedSealSource(sealed, "guessed")).toThrow(RangeError);
  });
});

describe("tachoRunName", () => {
  it.each([
    [
      { harnessTitle: "Claude title", name: "Model name", title: "dir" },
      "Claude title",
    ],
    [{ harnessTitle: null, name: "Model name", title: "dir" }, "Model name"],
    [{ name: "Fix login · fix/auth", title: "dir" }, "Fix login · fix/auth"],
    [
      { harnessTitle: null, name: null, title: "oxagen · 6 files" },
      "oxagen · 6 files",
    ],
    [{ name: null }, null],
    // #4224: the name is cut to the display cap.
    [
      { harnessTitle: "t".repeat(300), name: "Model name", title: "dir" },
      `${"t".repeat(255)}…`,
    ],
  ])("names %o as %s", (session, expected) => {
    expect(tachoRunName(session)).toBe(expected);
  });
});

describe("pull requests, the lines changed and the pull-request filter", () => {
  const uuid = (i: number) =>
    `0192d4a8-7c1e-7a00-8000-${String(i).padStart(12, "0")}`;
  const session = (
    i: number,
    over: Parameters<typeof tachoSession>[0]["session"] = {},
  ) =>
    tachoSession({
      publicId: `tse_${String(i).padStart(3, "0")}`,
      session: {
        id: uuid(1000 + i),
        sessionUuid: uuid(i),
        // Newest first by index: session 0 is the newest.
        startedAt: new Date(Date.UTC(2026, 8, 11, 12, 0, 0) - i * 60_000),
        ...over,
      },
    });
  const pull = (n: number) => ({
    url: `https://github.com/acme/api/pull/${String(n)}`,
    number: n,
    repository: "acme/api",
    state: null,
  });

  function handler(
    tacho: ReturnType<typeof session>[],
    linked: Record<number, number[]>,
    opts: {
      ledger?: Parameters<typeof memoryStores>[0];
      readPullRequests?: (uuids: readonly string[]) => Promise<never>;
      git?: Map<string, { added: number; removed: number }>;
    } = {},
  ) {
    const stores = memoryStores(opts.ledger ?? [], tacho);
    const asked: (readonly string[])[] = [];
    const gitAsked: (readonly string[])[] = [];
    const list = createRunListHandler({
      ...stores,
      readPullRequests:
        opts.readPullRequests ??
        ((uuids) => {
          asked.push(uuids);
          const out = new Map<string, ReturnType<typeof pull>[]>();
          for (const [i, numbers] of Object.entries(linked))
            if (uuids.includes(uuid(Number(i))))
              out.set(uuid(Number(i)), numbers.map(pull));
          return Promise.resolve(out);
        }),
      readGitDiffs: (_scope, uuids) => {
        gitAsked.push(uuids);
        return Promise.resolve(opts.git ?? new Map());
      },
    });
    return { list, asked, gitAsked };
  }

  it("carries the pull requests the frames name and the pr_open count, with status unknown", async () => {
    const { list, asked } = handler(
      [session(0, { pullRequests: 1 }), session(1, { pullRequests: 0 })],
      { 0: [12, 13] },
    );
    const out = await list({ limit: 10 }, ctx());
    expect(asked).toEqual([[uuid(0), uuid(1)]]);
    expect(out.runs[0]?.pullRequests).toEqual([pull(12), pull(13)]);
    expect(out.runs[0]?.pullRequestsOpened).toBe(1);
    expect(out.runs[1]?.pullRequests).toEqual([]);
    expect(out.runs[1]?.pullRequestsOpened).toBe(0);
    expect(out.warnings).toBeUndefined();
    // The contract accepts the row it built, state and all.
    expect(runList.output.parse(out)).toEqual(out);
  });

  it("keeps the rows and warns when the pull-request frames cannot be read (negative)", async () => {
    const { list } = handler(
      [session(0, { pullRequests: 2 })],
      {},
      {
        readPullRequests: () => Promise.reject(new Error("clickhouse down")),
      },
    );
    const out = await list({ limit: 10 }, ctx());
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).not.toHaveProperty("pullRequests");
    expect(out.runs[0]?.pullRequestsOpened).toBe(2);
    expect(out.warnings).toEqual(["pull_requests_unread"]);
  });

  it("reads no pull requests for a ledger run, and leaves its row without them", async () => {
    const { list, asked } = handler(
      [],
      {},
      {
        ledger: [ledgerRun({ publicId: "arun_1", runId: RUN_A })],
      },
    );
    const out = await list({ limit: 10 }, ctx());
    expect(asked).toEqual([]);
    expect(out.runs[0]).not.toHaveProperty("pullRequests");
    expect(out.runs[0]).not.toHaveProperty("pullRequestsOpened");
  });

  it("shows the harness's line totals, else git's uncommitted change, else nothing", async () => {
    const { list, gitAsked } = handler(
      [
        session(0, { linesAdded: 120, linesRemoved: 30 }),
        session(1),
        session(2),
      ],
      {},
      { git: new Map([[uuid(1), { added: 4, removed: 1 }]]) },
    );
    const out = await list({ limit: 10 }, ctx());
    // Git is asked only about the sessions with no harness totals.
    expect(gitAsked).toEqual([[uuid(1), uuid(2)]]);
    expect(out.runs.map((r) => r.diff)).toEqual([
      { added: 120, removed: 30, basis: "harness_reported" },
      { added: 4, removed: 1, basis: "git_observed" },
      null,
    ]);
  });

  it("lists only sessions with pull requests, by frame or by count, and leaves ledger runs out", async () => {
    const tacho = [
      session(0),
      session(1, { pullRequests: 1 }),
      session(2),
      session(3),
    ];
    const { list } = handler(
      tacho,
      { 2: [7] },
      {
        ledger: [
          ledgerRun({
            publicId: "arun_new",
            runId: RUN_A,
            run: {
              runId: RUN_A,
              publicId: "arun_new",
              status: "completed",
              createdAt: at("2026-09-12T00:00:00.000Z"),
              startedAt: at("2026-09-12T00:00:00.000Z"),
              name: null,
              summary: null,
              summaryGeneratedAt: null,
              summaryModel: null,
            },
          }),
        ],
      },
    );
    const withPrs = await list({ limit: 10, pullRequests: "with" }, ctx());
    expect(withPrs.runs.map((r) => r.id)).toEqual(["tse_001", "tse_002"]);
    expect(withPrs.nextCursor).toBeNull();
    const without = await list({ limit: 10, pullRequests: "without" }, ctx());
    expect(without.runs.map((r) => r.id)).toEqual(["tse_000", "tse_003"]);
    const any = await list({ limit: 10, pullRequests: "any" }, ctx());
    expect(any.runs.map((r) => r.id)).toContain("arun_new");
  });

  it("stops a full filtered page at the last run it took, and the next page carries on", async () => {
    const tacho = Array.from({ length: 6 }, (_, i) =>
      session(i, { pullRequests: i % 2 === 0 ? 1 : 0 }),
    );
    const { list } = handler(tacho, {});
    const first = await list({ limit: 2, pullRequests: "with" }, ctx());
    expect(first.runs.map((r) => r.id)).toEqual(["tse_000", "tse_002"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(
      { limit: 2, pullRequests: "with", cursor: first.nextCursor ?? "" },
      ctx(),
    );
    expect(second.runs.map((r) => r.id)).toEqual(["tse_004"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns what a bounded scan found, with a cursor past the last run it looked at (negative)", async () => {
    // More sessions than the scan reads, none of them matching: the page is
    // empty, and its cursor lets the reader go on rather than reading "none".
    const tacho = Array.from({ length: 501 }, (_, i) => session(i));
    const { list, asked } = handler(tacho, {});
    const out = await list({ limit: 10, pullRequests: "with" }, ctx());
    expect(out.runs).toEqual([]);
    expect(asked).toHaveLength(5);
    expect(out.nextCursor).not.toBeNull();
    const next = decodeRunCursor(out.nextCursor ?? "");
    expect(next?.id).toBe("tse_499");
  });
});
