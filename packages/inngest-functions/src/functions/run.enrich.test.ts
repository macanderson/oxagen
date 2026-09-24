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
  branch: "fix/auth-redirect" as string | null,
  writes: [] as Record<string, unknown>[],
  call: vi.fn(),
  bodies: new Map<string, Uint8Array>(),
  configs: new Map<string, import("@oxagen/functions").DurableFunctionConfig>(),
  handlers: new Map<string, (ctx: unknown) => Promise<unknown>>(),
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
            innerJoin: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => state.sweepRows.splice(0),
                }),
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
  }),
}));
vi.mock("../lib/run-record", () => ({
  resolveRunRecord: async () => ({ source: "tacho", sessionUuid: "session" }),
  readRunFrames: async () => [
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
  ],
}));
await import("./run.enrich");
const data = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  runPublicId: "tse_12345678",
};
const run = () =>
  state.handlers.get("run/enrich")!({
    event: { data },
    events: [{ data }],
    step: { run: (_name: string, fn: () => unknown) => fn() },
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
  state.branch = "fix/auth-redirect";
  state.writes = [];
  state.bodies.clear();
  state.call.mockReset();
  state.call.mockResolvedValue({
    text: JSON.stringify({
      name: "Repair authentication",
      summary: "Fixed the authentication redirect.",
    }),
    model: "fast-test",
  });
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
    expect(Object.keys(state.writes[0]!)).toEqual([
      "summaryObservedAt",
      "summaryError",
    ]);
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
  expect(ledger.sql).toContain('"spec_version" =');
  expect(ledger.params).toEqual([2]);
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

it("gives a run the same event id on every sweep until its job finishes or the row changes", async () => {
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
  await sweep();
  const [first, second] = state.sent as { id: string; data: unknown }[];
  expect(first!.id).toBe(second!.id);
  expect(first!.data).toEqual(data);
  const { enrichmentEventId } = await import("./run.enrich");
  expect(
    enrichmentEventId({ ...row, observedAt: "2026-09-23 10:05:00+00" }),
  ).not.toBe(first!.id);
  expect(
    enrichmentEventId({ ...row, revision: "2026-09-23 10:00:01+00" }),
  ).not.toBe(first!.id);
});

describe("a failed enrichment", () => {
  const fail = (error: unknown, eventData: unknown = data) =>
    state.handlers.get("failure")!({
      event: {
        name: "inngest/function.failed",
        data: {
          function_id: "oxagen-runner-run.enrich",
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
      "observed with no revision",
      {
        observedAt: minutesAgo(1),
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
      "changed since its account",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: null,
        changed: true,
        digest: "d",
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
      "failed, then got new frames",
      {
        observedAt: minutesAgo(1),
        revision: "r",
        error: "model_refused",
        changed: true,
        digest: null,
      },
      true,
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
