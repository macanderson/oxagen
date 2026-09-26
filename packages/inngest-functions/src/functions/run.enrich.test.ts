import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestBytes } from "@oxagen/tacho";
import { tachoFrame } from "@oxagen/run-ledger";
const state = vi.hoisted(() => ({
  enabled: true,
  archived: false,
  readable: true,
  sweepRows: [] as Record<string, unknown>[],
  sent: [] as unknown[],
  digest: null as string | null,
  name: null as string | null,
  summary: false,
  observedAt: null as string | null,
  branch: "fix/auth-redirect" as string | null,
  writes: [] as Record<string, unknown>[],
  call: vi.fn(),
  bodies: new Map<string, Uint8Array>(),
  /** The run's frames; the one-prompt run below when unset. */
  frames: null as unknown[] | null,
  configs: new Map<string, import("@oxagen/functions").DurableFunctionConfig>(),
  handlers: new Map<string, (ctx: unknown) => Promise<unknown>>(),
  /** Scratch objects by `<job run id>/<name>`, as the evidence store keeps them. */
  scratch: new Map<string, { bytes: Uint8Array; contentType: string }>(),
  /** Every scratch key a job wrote, in order. */
  scratchWritten: [] as string[],
  /** Every scratch key a job deleted, in order. */
  scratchDeleted: [] as string[],
  /** Every scratch key a job asked to read, in order, found or not. */
  scratchRead: [] as string[],
}));
vi.mock("../inngest", () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}));
vi.mock("../create-function", async (original) => {
  const actual = await original<typeof import("../create-function")>();
  return {
    ...actual,
    createFunction: (
      opts: import("@oxagen/functions").DurableFunctionConfig,
      trigger: { event?: string },
      handler: (ctx: unknown) => Promise<unknown>,
    ) => {
      actual.createFunction(opts, trigger as never, handler as never);
      state.configs.set(opts.id, opts);
      state.handlers.set(trigger.event ?? "sweep", handler);
      if (!opts.onFailure) return [handler];
      state.handlers.set(
        "failure",
        opts.onFailure as (ctx: unknown) => Promise<unknown>,
      );
      return [handler, opts.onFailure];
    },
  };
});
vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            // The ranked subquery, then the outer read of its first few.
            innerJoin: () => ({ where: () => ({ as: () => ({}) }) }),
            where: () => ({
              orderBy: () => ({
                limit: async () => state.sweepRows.splice(0),
              }),
            }),
          }),
        }),
      }),
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: async () =>
                table === actual.schema.workspaces
                  ? [
                      {
                        settings: { runEnrichmentEnabled: state.enabled },
                        archivedAt: state.archived ? new Date() : null,
                      },
                    ]
                  : !state.readable
                    ? []
                    : [
                        {
                          digest: state.digest,
                          name: state.name,
                          hasSummary: state.summary,
                          observedAt: state.observedAt,
                          branch: state.branch,
                          revision: "2026-09-23 10:00:00.123456+00",
                        },
                      ],
            }),
          }),
        }),
        update: () => ({
          set: (value: Record<string, unknown>) => ({
            where: async () => {
              state.writes.push(value);
              if (typeof value.summaryInputDigest === "string")
                state.digest = value.summaryInputDigest;
              if (typeof value.name === "string") state.name = value.name;
              if (typeof value.summary === "string") state.summary = true;
            },
          }),
        }),
      }),
  };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../lib/run-enrichment", async (original) => ({
  ...(await original<typeof import("../lib/run-enrichment")>()),
  runNarrativeTurn: state.call,
}));
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({
    put: async ({ bytes, digest }: { bytes: Uint8Array; digest: string }) => {
      state.bodies.set(digest, bytes);
      return { ref: digest };
    },
    getBody: async (_scope: unknown, ref: string) => ({
      bytes:
        state.bodies.get(ref) ??
        new TextEncoder().encode(
          "Please repair authentication. Fixed the redirect.",
        ),
    }),
    putScratch: async (input: {
      jobRunId: string;
      name: string;
      contentType: string;
      bytes: Uint8Array;
    }) => {
      state.scratch.set(`${input.jobRunId}/${input.name}`, {
        bytes: input.bytes,
        contentType: input.contentType,
      });
      state.scratchWritten.push(`${input.jobRunId}/${input.name}`);
    },
    getScratch: async (_scope: unknown, jobRunId: string, name: string) => {
      state.scratchRead.push(`${jobRunId}/${name}`);
      const object = state.scratch.get(`${jobRunId}/${name}`);
      if (object) return object;
      // What the storage driver throws for a key that holds nothing.
      throw Object.assign(new Error(`no object ${name}`), {
        name: "StorageNotFoundError",
      });
    },
    deleteScratch: async (
      _scope: unknown,
      jobRunId: string,
      names: readonly string[],
    ) => {
      for (const name of names) {
        state.scratch.delete(`${jobRunId}/${name}`);
        state.scratchDeleted.push(`${jobRunId}/${name}`);
      }
    },
  }),
}));
vi.mock("../lib/run-record", () => ({
  resolveRunRecord: async () => ({ source: "tacho", sessionUuid: "session" }),
  runFramePages: async function* () {
    yield state.frames ?? [
      tachoFrame({
        seq: 1,
        ts: "2026-09-22 00:00:00.000",
        kind: "turn_start",
        hash: `sha256:${"a".repeat(64)}`,
        contentDigest: digestBytes(
          new TextEncoder().encode(
            "Please repair authentication. Fixed the redirect.",
          ),
        ),
        bytesRef: "body",
        redactions: "",
        toolName: "",
        toolStatus: "",
        toolUseId: "",
        model: "",
        provider: "",
        policyDecision: "",
        costUsdMicros: null,
        turnSeq: 1,
      }),
    ];
  },
}));
const {
  ENRICHMENT_BUDGET_NOTE,
  ENRICHMENT_CHUNK_CHARS,
  ENRICHMENT_RUN_BUDGET_USD,
} = await import("../lib/run-enrichment");
await import("./run.enrich");
const data = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  runPublicId: "tse_12345678",
};
/** The provider's run id for one job, which keys its scratch chunks. */
const JOB_RUN_ID = "01K5ZJ3N9Q8R7S6T5V4W3X2Y1Z";
const run = () =>
  state.handlers.get("run/enrich")!({
    event: { data },
    events: [{ data }],
    step: { run: (_name: string, fn: () => unknown) => fn() },
    runId: JOB_RUN_ID,
  });
beforeEach(() => {
  state.enabled = true;
  state.archived = false;
  state.sweepRows = [];
  state.sent = [];
  state.readable = true;
  state.digest = null;
  state.name = null;
  state.summary = false;
  state.observedAt = null;
  state.branch = "fix/auth-redirect";
  state.writes = [];
  state.bodies.clear();
  state.frames = null;
  state.call.mockReset();
  state.call.mockResolvedValue({
    text: JSON.stringify({
      name: "Repair authentication",
      summary: "Fixed the authentication redirect.",
    }),
    model: "fast-test",
  });
  state.scratch.clear();
  state.scratchWritten = [];
  state.scratchDeleted = [];
  state.scratchRead = [];
});
describe("automatic run enrichment", () => {
  it("writes a generated account, then avoids charging for the identical input", async () => {
    expect(await run()).toMatchObject({ status: "generated" });
    expect(state.writes.at(-1)).toMatchObject({
      name: "Repair authentication (tse_12345678)",
      summaryModel: "fast-test",
    });
    expect(await run()).toMatchObject({ status: "unchanged" });
    expect(state.call).toHaveBeenCalledTimes(1);
  });
  it("does not call Stella or erase evidence when the workspace switches it off", async () => {
    state.enabled = false;
    expect(await run()).toEqual({ status: "disabled" });
    expect(state.call).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(1);
    // Only the observed time moves. A failed attempt keeps its error, so the
    // run is due again once enrichment is back on (#3784).
    expect(Object.keys(state.writes[0]!)).toEqual(["summaryObservedAt"]);
    expect(state.writes[0]).not.toHaveProperty("summaryError");
  });
  it("does not persist an invented account when Stella or credit admission fails", async () => {
    state.call.mockRejectedValue(new Error("credit gate refused"));
    await expect(run()).rejects.toThrow("credit gate refused");
    // The one write is the prompt's title; no summary, model or digest lands.
    expect(state.writes).toEqual([
      { name: "Please repair authentication on fix/auth-redirect" },
    ]);
  });
  it("names the run for its first prompt, then replaces that with the model's name", async () => {
    expect(await run()).toMatchObject({ status: "generated" });
    expect(state.writes[0]).toEqual({
      name: "Please repair authentication on fix/auth-redirect",
    });
    expect(state.writes.at(-1)).toMatchObject({
      name: "Repair authentication (tse_12345678)",
      summaryError: null,
    });
  });
  it("still asks the model when the same input left only a fallback title", async () => {
    expect(await run()).toMatchObject({ status: "generated" });
    // Same digest and a name, but no account: the model is asked again.
    state.summary = false;
    expect(await run()).toMatchObject({ status: "generated" });
    expect(state.call).toHaveBeenCalledTimes(2);
  });
  it("never overwrites a name the run already has", async () => {
    state.name = "Operator's own name";
    state.call.mockRejectedValue(new Error("credit gate refused"));
    await expect(run()).rejects.toThrow("credit gate refused");
    expect(state.writes).toHaveLength(0);
  });
});

// #3944, E-01: every call reports its tokens, priced, and one job spends at
// most ENRICHMENT_RUN_BUDGET_USD on reductions before it writes the account.
describe("the enrichment budget", () => {
  /** One retained prompt long enough to take four chunks. */
  function longRun() {
    const text = "Work on the parser. ".repeat(
      Math.ceil((3 * ENRICHMENT_CHUNK_CHARS) / 20),
    );
    const bytes = new TextEncoder().encode(text);
    state.bodies.set("long-body", bytes);
    state.frames = [
      tachoFrame({
        seq: 1,
        ts: "2026-09-22 00:00:00.000",
        kind: "turn_start",
        hash: `sha256:${"b".repeat(64)}`,
        contentDigest: digestBytes(bytes),
        bytesRef: "long-body",
        redactions: "",
        toolName: "",
        toolStatus: "",
        toolUseId: "",
        model: "",
        provider: "",
        policyDecision: "",
        costUsdMicros: null,
        turnSeq: 1,
      }),
    ];
  }
  const account = {
    text: JSON.stringify({ name: "Parser work", summary: "Worked on it." }),
    model: "fast-test",
    costUsd: 0.01,
  };

  it("stops reducing once the budget is spent, and the account says it covers only the start", async () => {
    longRun();
    state.call
      .mockResolvedValueOnce({
        text: "The first portion: parser work began.",
        model: "fast-test",
        costUsd: ENRICHMENT_RUN_BUDGET_USD,
      })
      .mockResolvedValueOnce(account);
    expect(await run()).toMatchObject({
      status: "generated",
      calls: 2,
      spentUsd: ENRICHMENT_RUN_BUDGET_USD + 0.01,
      budgetReached: true,
    });
    // One reduction, then the account: the three chunks left were not sent.
    expect(state.call).toHaveBeenCalledTimes(2);
    const instruction = state.call.mock.calls[1]![1] as string;
    expect(instruction).toContain("budget ran out");
    expect(instruction).toContain("The first portion: parser work began.");
    expect(instruction.length).toBeLessThan(2 * ENRICHMENT_CHUNK_CHARS);
    expect(String(state.writes.at(-1)?.summary)).toBe(
      `Worked on it.${ENRICHMENT_BUDGET_NOTE}`,
    );
  });

  it("reduces every chunk and adds no note while the run is under budget (negative)", async () => {
    longRun();
    state.call.mockImplementation(async (_scope: unknown, text: string) =>
      text.startsWith("Return only JSON")
        ? account
        : { text: "A portion.", model: "fast-test", costUsd: 0.01 },
    );
    expect(await run()).toMatchObject({
      status: "generated",
      budgetReached: false,
    });
    // Four reductions and the account.
    expect(state.call).toHaveBeenCalledTimes(5);
    expect(String(state.writes.at(-1)?.summary)).toBe("Worked on it.");
  });
});

it("registers enrichment under the adapter limits and serializes each organization's work", () => {
  const config = state.configs.get("run.enrich")!;
  expect(config.batchEvents?.maxSize).toBeLessThanOrEqual(5);
  expect(config.concurrency).toEqual({ limit: 1, key: "event.data.orgId" });
  expect(config.batchEvents?.key).toContain("event.data.runPublicId");
  // Every run waits out the batch before its account starts.
  expect(config.batchEvents?.timeout).toBe("2s");
});

it("does not charge for queued child sessions or legacy rows absent from the readable selection", async () => {
  state.readable = false;
  expect(await run()).toEqual({ status: "not_found" });
  expect(state.call).not.toHaveBeenCalled();
  expect(state.bodies.size).toBe(0);
});

it("uses root Tacho and V2 ledger predicates for enrichment eligibility", async () => {
  const { readableEnrichmentRun } = await import("./run.enrich");
  const { schema } = await import("@oxagen/database");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  expect(
    dialect.sqlToQuery(readableEnrichmentRun(schema.tachoSessions)).sql,
  ).toContain('"parent_session_uuid" is null');
  const ledger = dialect.sqlToQuery(readableEnrichmentRun(schema.agentRuns));
  // The literal 2 the partial index names, not a bind parameter (#3784).
  expect(ledger.sql).toBe('"agent"."agent_runs"."spec_version" = 2');
  expect(ledger.params).toEqual([]);
});

it("rejects an ineligible queued run before replaying an older durable read step", async () => {
  state.readable = false;
  const replay = vi.fn((_name: string, fn: () => unknown) => fn());
  expect(
    await state.handlers.get("run/enrich")!({
      event: { data },
      events: [{ data }],
      step: { run: replay },
    }),
  ).toEqual({ status: "not_found" });
  expect(replay).not.toHaveBeenCalled();
  expect(state.call).not.toHaveBeenCalled();
});

it("does not charge for a run in an archived workspace", async () => {
  state.archived = true;
  expect(await run()).toEqual({ status: "disabled" });
  expect(state.call).not.toHaveBeenCalled();
});

it("records the row revision the read saw, to the microsecond", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  expect(await run()).toMatchObject({ status: "generated" });
  const revision = state.writes.at(-1)!.summaryObservedRevision;
  const query = new PgDialect().sqlToQuery(revision as never);
  expect(query.sql).toContain("::timestamptz");
  expect(query.params).toEqual(["2026-09-23 10:00:00.123456+00"]);
});

it("sweeps a run whose row changed after the observed revision, and skips archived or disabled workspaces", async () => {
  const { dueForEnrichment, enrichableWorkspace } = await import(
    "./run.enrich"
  );
  const { schema } = await import("@oxagen/database");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const due = dialect.sqlToQuery(
    dueForEnrichment(schema.tachoSessions, new Date())!,
  ).sql;
  expect(due).toContain(
    '"updated_at" IS DISTINCT FROM "tacho"."sessions"."summary_observed_revision"',
  );
  const workspace = dialect.sqlToQuery(enrichableWorkspace()!).sql;
  expect(workspace).toContain('"archived_at" is null');
  expect(workspace).toContain("IS DISTINCT FROM 'false'::jsonb");
});

it("gives a run the same event id on every sweep until its job finishes, the row changes or the window turns", async () => {
  vi.useFakeTimers({ now: new Date("2026-09-24T12:01:00Z") });
  const row = {
    orgId: data.orgId,
    workspaceId: data.workspaceId,
    runPublicId: data.runPublicId,
    revision: "2026-09-23 10:00:00.123456+00",
    observedAt: null,
  };
  const sweep = async () => {
    state.sweepRows = [{ ...row }];
    await state.handlers.get("sweep")!({
      step: {
        run: (_name: string, fn: () => unknown) => fn(),
        sendEvent: async (_label: string, events: unknown) => {
          state.sent.push(...(events as unknown[]));
        },
      },
    });
  };
  await sweep();
  vi.setSystemTime(new Date("2026-09-24T12:29:00Z"));
  await sweep();
  vi.setSystemTime(new Date("2026-09-24T12:31:00Z"));
  await sweep();
  vi.useRealTimers();
  const [first, second, third] = state.sent as { id: string; data: unknown }[];
  expect(first!.id).toBe(second!.id);
  expect(third!.id).not.toBe(first!.id);
  expect(first!.data).toEqual({ ...data, observedAt: null });
  const { enrichmentEventId, sweepWindow } = await import("./run.enrich");
  const window = sweepWindow(new Date("2026-09-24T12:01:00Z"));
  expect(
    enrichmentEventId({
      ...row,
      observedAt: "2026-09-23 10:05:00+00",
      window,
    }),
  ).not.toBe(first!.id);
  expect(
    enrichmentEventId({
      ...row,
      revision: "2026-09-23 10:00:01+00",
      window,
    }),
  ).not.toBe(first!.id);
});

// #4113: runs sealed on 2026-09-24 ranked past the 500th due run in the
// oldest-first sweep and were never queued.
it("queues the run sealed now ahead of a week-old backlog, a few per organization", async () => {
  const { sweepCandidates, SWEEP_RUNS_PER_ORG } = await import("./run.enrich");
  const { schema } = await import("@oxagen/database");
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async () => ({ rows: [] }));
  const query = sweepCandidates(
    db as never,
    schema.tachoSessions,
    new Date("2026-09-24T12:00:00Z"),
  ).toSQL();
  const col = (name: string) => `"tacho"."sessions"."${name}"`;
  // Within each organization: ended runs first, then the latest seal first.
  const rank = new RegExp(
    `row_number\\(\\) over \\(partition by ${escapeRegExp(col("org_id"))} order by \\(${escapeRegExp(col("outcome"))} <> \\$(\\d+)\\) desc, coalesce\\(${escapeRegExp(col("sealed_at"))}, ${escapeRegExp(col("updated_at"))}\\) desc\\)`,
    "u",
  ).exec(query.sql);
  expect(rank).not.toBeNull();
  expect(query.params[Number(rank![1]) - 1]).toBe("running");
  const limit = /"rank" <= \$(\d+)/u.exec(query.sql);
  expect(limit).not.toBeNull();
  expect(query.params[Number(limit![1]) - 1]).toBe(SWEEP_RUNS_PER_ORG);
  expect(SWEEP_RUNS_PER_ORG).toBeLessThanOrEqual(5);
  // The old order: oldest observation or change first.
  expect(query.sql).not.toContain(`coalesce(${col("summary_observed_at")}`);
});

describe("a queued event that no longer asks for work", () => {
  const sweepData = { ...data, observedAt: null };
  const queued = (eventData: unknown, sentAt: number) =>
    state.handlers.get("run/enrich")!({
      event: { data: eventData, ts: sentAt },
      events: [{ data: eventData, ts: sentAt }],
      step: { run: (_name: string, fn: () => unknown) => fn() },
      runId: JOB_RUN_ID,
    });

  it("skips a sweep event that waited past its window, and leaves the run due", async () => {
    expect(await queued(sweepData, Date.now() - 31 * 60_000)).toEqual({
      status: "stale",
    });
    expect(state.call).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  it("skips an event from before sweep events carried observedAt by its age alone", async () => {
    expect(await queued(data, Date.now() - 3 * 60 * 60_000)).toEqual({
      status: "stale",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("skips a copy that arrives after another job observed the run", async () => {
    state.observedAt = "2026-09-24 12:10:00.123+00";
    expect(await queued(sweepData, Date.now())).toEqual({
      status: "superseded",
    });
    expect(state.call).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  it("still runs a fresh sweep event for a run nobody observed since", async () => {
    expect(await queued(sweepData, Date.now() - 60_000)).toMatchObject({
      status: "generated",
    });
  });

  it("always runs a person's request, however long it waited", async () => {
    expect(
      await queued(
        { ...data, requestedByUserId: "user-1" },
        Date.now() - 3 * 60 * 60_000,
      ),
    ).toMatchObject({ status: "generated" });
  });
});

describe("a failed enrichment", () => {
  const fail = (error: unknown, eventData: unknown = data) =>
    state.handlers.get("failure")!({
      event: {
        name: "inngest/function.failed",
        data: {
          function_id: "oxagen-runner-run.enrich",
          run_id: JOB_RUN_ID,
          error,
          event: { data: eventData },
        },
      },
      step: { run: (_name: string, fn: () => unknown) => fn() },
    });

  it("registers an on-failure companion for run.enrich", () => {
    expect(state.configs.get("run.enrich")!.onFailure).toBeTypeOf("function");
    expect(state.handlers.has("failure")).toBe(true);
  });

  it("records a short reason and moves the observed time, never the provider's text", async () => {
    await fail({
      name: "GatewayError",
      message: "Free tier users do not have access to this model",
    });
    expect(state.writes).toHaveLength(1);
    const write = state.writes[0]!;
    expect(write.summaryError).toBe("model_refused");
    expect(write.summaryObservedAt).toBeInstanceOf(Date);
    expect(write).not.toHaveProperty("summary");
    expect(write).not.toHaveProperty("summaryInputDigest");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    expect(
      new PgDialect().sqlToQuery(write.summaryObservedRevision as never).sql,
    ).toContain('"updated_at"');
  });

  it("records a credit refusal by its gate code", async () => {
    await fail({ message: "Run enrichment unavailable: insufficient_credits" });
    expect(state.writes[0]!.summaryError).toBe(
      "credit_refused:insufficient_credits",
    );
  });

  it("ignores a failure event it cannot read", async () => {
    await fail({ message: "boom" }, { runPublicId: 1 });
    expect(state.writes).toHaveLength(0);
  });

  it("clears the recorded reason once an account is written", async () => {
    expect(await run()).toMatchObject({ status: "generated" });
    expect(state.writes.at(-1)).toMatchObject({ summaryError: null });
  });
});

describe("which runs the sweep queues", () => {
  // Each case is one row; the query is compiled and evaluated in memory so
  // the truth table covers the SQL the sweep sends, not a copy of it.
  const now = new Date("2026-09-24T12:00:00Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  it.each([
    [
      "never observed",
      {
        observedAt: null,
        revision: null,
        error: null,
        changed: true,
        digest: null,
      },
      true,
    ],
    [
      "observed a minute ago with no revision",
      {
        observedAt: minutesAgo(1),
        revision: null,
        error: null,
        changed: true,
        digest: "d",
      },
      false,
    ],
    [
      "observed half an hour ago with no revision",
      {
        observedAt: minutesAgo(31),
        revision: null,
        error: null,
        changed: true,
        digest: "d",
      },
      true,
    ],
    [
      "unchanged since its account",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: null,
        changed: false,
        digest: "d",
      },
      false,
    ],
    [
      // A sealed Claude Code session goes on receiving events after its seal.
      "sealed and changed a minute after its account",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: null,
        changed: true,
        digest: "d",
      },
      false,
    ],
    [
      "sealed and changed half an hour after its account",
      {
        observedAt: minutesAgo(31),
        revision: "r",
        error: null,
        changed: true,
        digest: "d",
      },
      true,
    ],
    [
      "sealed, changed and still unnamed",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: null,
        changed: true,
        digest: "d",
        named: false,
      },
      true,
    ],
    [
      "partial and five minutes old",
      {
        observedAt: minutesAgo(6),
        revision: "r",
        error: null,
        changed: false,
        digest: "partial:d",
      },
      true,
    ],
    [
      "partial and fresh",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: null,
        changed: false,
        digest: "partial:d",
      },
      false,
    ],
    [
      "failed a minute ago",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: "model_refused",
        changed: false,
        digest: null,
      },
      false,
    ],
    [
      "failed a minute ago, then got new frames",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: "model_refused",
        changed: true,
        digest: null,
      },
      false,
    ],
    [
      "failed half an hour ago",
      {
        observedAt: minutesAgo(31),
        revision: "r",
        error: "model_refused",
        changed: false,
        digest: null,
      },
      true,
    ],
    [
      "live and never observed",
      {
        observedAt: null,
        revision: null,
        error: null,
        changed: true,
        digest: null,
        live: true,
        named: false,
      },
      true,
    ],
    [
      "live and still unnamed",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: null,
        changed: true,
        digest: null,
        live: true,
        named: false,
      },
      true,
    ],
    [
      "live and changed a minute after its account",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: null,
        changed: true,
        digest: "d",
        live: true,
      },
      false,
    ],
    [
      "live and changed half an hour after its account",
      {
        observedAt: minutesAgo(31),
        revision: "r",
        error: null,
        changed: true,
        digest: "d",
        live: true,
      },
      true,
    ],
    [
      "live and unchanged half an hour after its account",
      {
        observedAt: minutesAgo(31),
        revision: "r",
        error: null,
        changed: false,
        digest: "d",
        live: true,
      },
      false,
    ],
    [
      "live, failed a minute ago, then got new frames",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: "model_refused",
        changed: true,
        digest: null,
        live: true,
      },
      false,
    ],
    [
      "live and failed half an hour ago",
      {
        observedAt: minutesAgo(31),
        revision: "r",
        error: "model_refused",
        changed: true,
        digest: null,
        live: true,
      },
      true,
    ],
  ] as const)("%s: due is %s", async (_label, row, due) => {
    const { dueForEnrichment } = await import("./run.enrich");
    const { schema } = await import("@oxagen/database");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const query = new PgDialect().sqlToQuery(
      dueForEnrichment(schema.tachoSessions, now)!,
    );
    expect(evaluateDue(query.sql, query.params, row)).toBe(due);
  });
});

/**
 * Evaluate the compiled due predicate against one row. It substitutes each
 * column with the row's value and each parameter with its bound value, then
 * reads the result as a JavaScript boolean expression. A row is an ended,
 * named run unless it says otherwise.
 */
function evaluateDue(
  text: string,
  params: unknown[],
  row: {
    observedAt: Date | null;
    revision: string | null;
    error: string | null;
    changed: boolean;
    digest: string | null;
    live?: boolean;
    named?: boolean;
  },
): boolean {
  const col = (name: string) => `"tacho"."sessions"."${name}"`;
  const js = text
    .replace(
      new RegExp(
        `${escapeRegExp(col("updated_at"))} IS NOT DISTINCT FROM ${escapeRegExp(col("summary_observed_revision"))}`,
        "gu",
      ),
      JSON.stringify(!row.changed),
    )
    .replace(
      new RegExp(
        `${escapeRegExp(col("updated_at"))} IS DISTINCT FROM ${escapeRegExp(col("summary_observed_revision"))}`,
        "gu",
      ),
      JSON.stringify(row.changed),
    )
    .replace(
      new RegExp(`${escapeRegExp(col("summary_observed_at"))} is null`, "gu"),
      JSON.stringify(row.observedAt === null),
    )
    .replace(
      new RegExp(
        `${escapeRegExp(col("summary_observed_revision"))} is null`,
        "gu",
      ),
      JSON.stringify(row.revision === null),
    )
    .replace(
      new RegExp(`${escapeRegExp(col("summary_error"))} is null`, "gu"),
      JSON.stringify(row.error === null),
    )
    .replace(
      new RegExp(`${escapeRegExp(col("summary_error"))} is not null`, "gu"),
      JSON.stringify(row.error !== null),
    )
    .replace(
      new RegExp(`${escapeRegExp(col("name"))} is null`, "gu"),
      JSON.stringify(row.named === false),
    )
    .replace(
      new RegExp(`${escapeRegExp(col("outcome"))} <> \\$(\\d+)`, "gu"),
      (_m, i: string) =>
        JSON.stringify(
          (row.live === true ? "running" : "completed") !==
            params[Number(i) - 1],
        ),
    )
    .replace(
      new RegExp(
        `${escapeRegExp(col("summary_input_digest"))} like \\$(\\d+)`,
        "gu",
      ),
      (_m, i: string) =>
        JSON.stringify(
          row.digest !== null &&
            row.digest.startsWith(
              String(params[Number(i) - 1]).replace(/%$/u, ""),
            ),
        ),
    )
    .replace(
      new RegExp(
        `${escapeRegExp(col("summary_observed_at"))} < \\$(\\d+)`,
        "gu",
      ),
      (_m, i: string) =>
        JSON.stringify(
          row.observedAt !== null &&
            row.observedAt.getTime() <
              new Date(params[Number(i) - 1] as string | Date).getTime(),
        ),
    )
    .replace(/\s+/gu, " ");
  if (/"|\$/u.test(js)) throw new Error(`unevaluated SQL left: ${js}`);
  // Drizzle wraps every and() and or() in parentheses, so each innermost
  // group joins its terms with one operator.
  const flat = (inner: string) => {
    const any = inner.split(" or ");
    const all = inner.split(" and ");
    if (any.length > 1 && all.length > 1)
      throw new Error(`mixed operators: ${inner}`);
    return any.length > 1
      ? any.some((term) => term.trim() === "true")
      : all.every((term) => term.trim() === "true");
  };
  let expr = js;
  const group = /\(([^()]*)\)/u;
  while (group.test(expr))
    expr = expr.replace(group, (_m, inner: string) => String(flat(inner)));
  return flat(expr);
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// #3784: a job wrote its transcript chunks and their manifest under the
// content-addressed bodies/ prefix, shared with frame bodies, and nothing
// ever deleted them.
describe("the transcript chunks a job keeps", () => {
  const key = (name: string) => `${JOB_RUN_ID}/${name}`;
  const encode = (text: string) => new TextEncoder().encode(text);
  const account = {
    text: JSON.stringify({ name: "Parser work", summary: "Worked on it." }),
    model: "fast-test",
    costUsd: 0.01,
  };
  /** One retained prompt whose text takes `count` chunks. */
  function runOfChunks(count: number) {
    const bytes = encode(
      "Work on the parser. ".repeat(
        Math.ceil(((count - 0.5) * ENRICHMENT_CHUNK_CHARS) / 20),
      ),
    );
    state.bodies.set("long-body", bytes);
    state.frames = [
      tachoFrame({
        seq: 1,
        ts: "2026-09-22 00:00:00.000",
        kind: "turn_start",
        hash: `sha256:${"c".repeat(64)}`,
        contentDigest: digestBytes(bytes),
        bytesRef: "long-body",
        redactions: "",
        toolName: "",
        toolStatus: "",
        toolUseId: "",
        model: "",
        provider: "",
        policyDecision: "",
        costUsdMicros: null,
        turnSeq: 1,
      }),
    ];
  }
  const failed = () =>
    state.handlers.get("failure")!({
      event: {
        name: "inngest/function.failed",
        data: {
          function_id: "oxagen-runner-run.enrich",
          run_id: JOB_RUN_ID,
          error: { message: "credit gate refused" },
          event: { data },
        },
      },
      step: { run: (_name: string, fn: () => unknown) => fn() },
    });

  it("keeps a run's chunks as scratch while it is summarized, then deletes every one", async () => {
    runOfChunks(3);
    state.call.mockImplementation(async (_scope: unknown, text: string) => {
      // Every step that reads a chunk runs while the chunks are kept.
      expect(state.scratch.has(key("manifest"))).toBe(true);
      return text.startsWith("Return only JSON")
        ? account
        : { text: "A portion.", model: "fast-test", costUsd: 0.01 };
    });
    expect(await run()).toMatchObject({ status: "generated", calls: 4 });
    // The manifest goes first, so a job that fails part way names each chunk.
    expect(state.scratchWritten).toEqual([
      key("manifest"),
      key("chunk-0"),
      key("chunk-1"),
      key("chunk-2"),
    ]);
    // The manifest goes last, so a cleanup that fails part way can finish.
    expect(state.scratchDeleted).toEqual([
      key("chunk-0"),
      key("chunk-1"),
      key("chunk-2"),
      key("manifest"),
    ]);
    expect(state.scratch.size).toBe(0);
    // Nothing was written to the content-addressed body store.
    expect([...state.bodies.keys()]).toEqual(["long-body"]);
  });

  it("keeps no chunks for a run whose input did not change (negative)", async () => {
    expect(await run()).toMatchObject({ status: "generated" });
    const written = [...state.scratchWritten];
    expect(await run()).toEqual({ status: "unchanged" });
    expect(state.scratchWritten).toEqual(written);
    expect(state.scratch.size).toBe(0);
  });

  it("keeps no chunks for a run with no retained text (negative)", async () => {
    state.frames = [
      tachoFrame({
        seq: 1,
        ts: "2026-09-22 00:00:00.000",
        kind: "tool_call",
        hash: `sha256:${"d".repeat(64)}`,
        contentDigest: "",
        bytesRef: "",
        redactions: "",
        toolName: "Read",
        toolStatus: "ok",
        toolUseId: "toolu_1",
        model: "",
        provider: "",
        policyDecision: "",
        costUsdMicros: null,
        turnSeq: 1,
      }),
    ];
    expect(await run()).toEqual({ status: "no_retained_text" });
    expect(state.scratchWritten).toEqual([]);
    expect(state.call).not.toHaveBeenCalled();
  });

  it("deletes a failed job's chunks from its failure handler", async () => {
    runOfChunks(2);
    state.call.mockRejectedValue(new Error("credit gate refused"));
    await expect(run()).rejects.toThrow("credit gate refused");
    expect([...state.scratch.keys()].sort()).toEqual(
      [key("chunk-0"), key("chunk-1"), key("manifest")].sort(),
    );
    await failed();
    expect(state.scratch.size).toBe(0);
    expect(state.scratchDeleted).toEqual([
      key("chunk-0"),
      key("chunk-1"),
      key("manifest"),
    ]);
  });

  it("deletes nothing from its failure handler when the job kept nothing (negative)", async () => {
    await failed();
    expect(state.scratchDeleted).toEqual([]);
  });

  it("records a failure whose event names no job run, and deletes nothing it cannot name (negative)", async () => {
    runOfChunks(2);
    state.call.mockRejectedValue(new Error("credit gate refused"));
    await expect(run()).rejects.toThrow("credit gate refused");
    await state.handlers.get("failure")!({
      event: {
        name: "inngest/function.failed",
        data: {
          function_id: "oxagen-runner-run.enrich",
          error: { message: "credit gate refused" },
          event: { data },
        },
      },
      step: { run: (_name: string, fn: () => unknown) => fn() },
    });
    // The failure is still recorded against the run.
    expect(state.writes.at(-1)).toHaveProperty("summaryError");
    // Without the run id no chunk can be named, so none is deleted. The
    // provider sends one on every failure. This pins the guard alone.
    expect(state.scratchDeleted).toEqual([]);
    expect(state.scratch.size).toBe(3);
  });

  it("opens no chunk past the one the account is cut to once the budget runs out", async () => {
    runOfChunks(4);
    state.call
      .mockResolvedValueOnce({
        text: "The first portion.",
        model: "fast-test",
        costUsd: ENRICHMENT_RUN_BUDGET_USD,
      })
      .mockResolvedValueOnce(account);
    expect(await run()).toMatchObject({
      status: "generated",
      calls: 2,
      budgetReached: true,
    });
    // One reduction read chunk 0. The account is cut to one chunk, which the
    // reduced portion and chunk 1 fill, so chunks 2 and 3 are never opened.
    const opened = state.scratchRead.filter((read) => read.includes("chunk-"));
    expect(opened).toEqual([key("chunk-0"), key("chunk-1")]);
    expect(state.scratchWritten).toContain(key("chunk-3"));
    expect(state.scratch.size).toBe(0);
  });

  it("deletes the chunks of a run that stopped being readable after its read step", async () => {
    // What this job's read step kept before the run left the readable set.
    state.scratch.set(key("manifest"), {
      bytes: encode(JSON.stringify({ chunks: 2 })),
      contentType: "application/json",
    });
    state.scratch.set(key("chunk-0"), {
      bytes: encode("first"),
      contentType: "text/plain",
    });
    state.scratch.set(key("chunk-1"), {
      bytes: encode("second"),
      contentType: "text/plain",
    });
    state.readable = false;
    expect(await run()).toEqual({ status: "not_found" });
    expect(state.scratch.size).toBe(0);
  });

  it("reads a read step recorded before #3784 through its manifest body, and deletes nothing", async () => {
    state.bodies.set("legacy-chunk", encode("Frame 1: the legacy transcript"));
    state.bodies.set(
      "legacy-manifest",
      encode(JSON.stringify(["legacy-chunk"])),
    );
    const legacy = {
      retained: 1,
      missing: 0,
      unavailable: 0,
      frames: 1,
      truncated: 0,
      digest: "legacy-digest",
      revision: "2026-09-23 10:00:00.123456+00",
      manifest: "legacy-manifest",
      unchanged: false,
    };
    const outcome = await state.handlers.get("run/enrich")!({
      event: { data },
      events: [{ data }],
      step: {
        run: (name: string, fn: () => unknown) =>
          name === "read-record" ? Promise.resolve(legacy) : fn(),
      },
      runId: JOB_RUN_ID,
    });
    expect(outcome).toMatchObject({ status: "generated" });
    expect(String(state.call.mock.calls.at(-1)?.[1])).toContain(
      "the legacy transcript",
    );
    expect(state.scratchDeleted).toEqual([]);
    expect(state.bodies.has("legacy-chunk")).toBe(true);
  });

  it("refuses to keep a transcript without the provider's run id (negative)", async () => {
    await expect(
      state.handlers.get("run/enrich")!({
        event: { data },
        events: [{ data }],
        step: { run: (_name: string, fn: () => unknown) => fn() },
      }),
    ).rejects.toThrow("run id");
    expect(state.scratchWritten).toEqual([]);
    expect(state.call).not.toHaveBeenCalled();
  });
});
