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
      return [handler];
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
                          name: state.digest ? "Prior account" : null,
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
      kind: "user_prompt",
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
      name: "Repair authentication · tse_12345678",
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
    expect(Object.keys(state.writes[0]!)).toEqual(["summaryObservedAt"]);
  });
  it("does not persist an invented account when Stella or credit admission fails", async () => {
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
