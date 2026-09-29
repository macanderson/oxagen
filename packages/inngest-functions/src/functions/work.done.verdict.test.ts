// work.done.verdict.test.ts: the verdict row a finished stage appends, and the
// work/done.verdict event it sends.
import { lockDigest, type DoneRecord } from "@oxagen/done-record";
import { NonRetriableError } from "@oxagen/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkStageCompletedEventData } from "../events";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type StepRun = (name: string, fn: () => unknown) => Promise<unknown>;
type SendEvent = (label: string, event: unknown) => Promise<void>;
type Handler = (ctx: { event: { data: unknown }; step: { run: StepRun; sendEvent: SendEvent } }) => Promise<unknown>;

/** Where the createFunction stub leaves the handler and the options the module hands it. */
const captured = vi.hoisted(() => ({}) as { handler?: Handler; options?: unknown; trigger?: unknown });

vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, fn: Handler) => {
    captured.handler = fn;
    captured.options = options;
    captured.trigger = trigger;
    return [{}];
  },
}));
vi.mock("@oxagen/database", () => ({
  schema: {
    workDoneVerdicts: {
      id: "verdicts.id",
      orgId: "verdicts.org_id",
      workspaceId: "verdicts.workspace_id",
      createdAt: "verdicts.created_at",
      recordDigest: "verdicts.record_digest",
      verdict: "verdicts.verdict",
    },
  },
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
  desc: (column: unknown) => ({ desc: column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?"), values }),
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mocks.runInTenantScope }));
vi.mock("../logger", () => ({ logger: mocks.logger }));

const { recordDoneVerdict, setDoneEvidenceLoader } = await import("./work.done.verdict");
type Loaded = Parameters<typeof recordDoneVerdict>[1];

const ORG = "0193a8f0-0000-7000-8000-000000000001";
const WORKSPACE = "0193a8f0-0000-7000-8000-000000000002";
const SCOPE = { orgId: ORG, workspaceId: WORKSPACE };
const AT = "2026-09-26T18:04:11Z";
const EVIDENCE = `sha256:${"e".repeat(64)}` as const;

const UNLOCKED: DoneRecord = {
  schema: "done-record/v1",
  item: "wi_01K5ZQ4M8T2DXW",
  lineage: "aintel.platform.export",
  criteria: [
    { id: "c1", text: "The export tests pass.", tag: "test", check: { run: "pnpm test -- export" } },
    { id: "c2", text: "The import tests pass.", tag: "test", check: { run: "pnpm test -- import" } },
  ],
};
const DIGEST = lockDigest(UNLOCKED);
const LOCKED: DoneRecord = { ...UNLOCKED, lock: { digest: DIGEST, by: "priya", at: AT } };

const EVENT_DATA: WorkStageCompletedEventData = {
  org_id: ORG,
  workspace_id: WORKSPACE,
  work_order_id: "0193a8f0-0000-7000-8000-000000000003",
  role: "Fix",
  session_id: "0193a8f0-0000-7000-8000-000000000004",
};

/** Evidence with each named check passing (true) or failing (false). */
function loaded(checks: Record<string, boolean>, record: DoneRecord = LOCKED): Loaded {
  return {
    evidence: {
      record,
      criteria: Object.entries(checks).map(([id, ok]) => ({ id, check: { ok, evidence: EVIDENCE } })),
      models: { build: ["build-model"] },
    },
    stageModels: { Fix: "build-model" },
  };
}

/** A transaction whose last verdict row is `last`, and whose insert returns `inserted`. */
function fakeTx(last: { verdict: string }[], inserted: { id: string }[] = [{ id: "row-2" }]) {
  const seen = {
    executed: [] as unknown[],
    where: [] as unknown[],
    orderBy: [] as unknown[],
    limit: [] as unknown[],
    values: [] as unknown[],
  };
  const tx = {
    execute: (query: unknown) => {
      seen.executed.push(query);
      return Promise.resolve();
    },
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          seen.where.push(where);
          return {
            orderBy: (...order: unknown[]) => {
              seen.orderBy.push(order);
              return {
                limit: (count: number) => {
                  seen.limit.push(count);
                  return Promise.resolve(last);
                },
              };
            },
          };
        },
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        seen.values.push(values);
        return { returning: () => Promise.resolve(inserted) };
      },
    }),
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  return seen;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
  setDoneEvidenceLoader(null);
});

describe("recordDoneVerdict", () => {
  it("appends the first verdict under the record's lock digest", async () => {
    const seen = fakeTx([]);
    await expect(recordDoneVerdict(SCOPE, loaded({}))).resolves.toEqual({
      status: "recorded",
      id: "row-2",
      digest: DIGEST,
      verdict: "pending",
    });
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(SCOPE, expect.any(Function));
    expect(seen.values).toEqual([
      {
        orgId: ORG,
        workspaceId: WORKSPACE,
        recordDigest: DIGEST,
        verdict: "pending",
        reasons: [],
        criteria: [
          { id: "c1", state: "open" },
          { id: "c2", state: "open" },
        ],
        stageModels: { Fix: "build-model" },
        commitSha: null,
      },
    ]);
  });

  it("locks the record and reads its last row before it writes", async () => {
    const seen = fakeTx([]);
    await recordDoneVerdict(SCOPE, loaded({}));
    expect(seen.executed).toEqual([
      {
        sql: "select pg_advisory_xact_lock(hashtextextended(?, 0))",
        values: [`work.done_verdicts:${ORG}:${WORKSPACE}:${DIGEST}`],
      },
    ]);
    expect(seen.where).toEqual([
      {
        and: [
          { eq: ["verdicts.org_id", ORG] },
          { eq: ["verdicts.workspace_id", WORKSPACE] },
          { eq: ["verdicts.record_digest", DIGEST] },
        ],
      },
    ]);
    expect(seen.orderBy).toEqual([[{ desc: "verdicts.created_at" }, { desc: "verdicts.id" }]]);
    expect(seen.limit).toEqual([1]);
  });

  it("writes nothing when the verdict matches the last row", async () => {
    const seen = fakeTx([{ verdict: "pending" }]);
    await expect(recordDoneVerdict(SCOPE, loaded({ c1: true }))).resolves.toEqual({
      status: "unchanged",
      digest: DIGEST,
      verdict: "pending",
    });
    expect(seen.values).toEqual([]);
  });

  it("appends a changed verdict with the criteria states and the commit", async () => {
    const seen = fakeTx([{ verdict: "pending" }], [{ id: "row-3" }]);
    const input = { ...loaded({ c1: true, c2: true }), commitSha: "4f2a9c1" };
    await expect(recordDoneVerdict(SCOPE, input)).resolves.toEqual({
      status: "recorded",
      id: "row-3",
      digest: DIGEST,
      verdict: "held",
    });
    expect(seen.values).toEqual([
      expect.objectContaining({
        verdict: "held",
        reasons: [],
        criteria: [
          { id: "c1", state: "held" },
          { id: "c2", state: "held" },
        ],
        commitSha: "4f2a9c1",
      }),
    ]);
  });

  it("stores each reason code once", async () => {
    const seen = fakeTx([{ verdict: "pending" }]);
    await recordDoneVerdict(SCOPE, loaded({ c1: false, c2: false }));
    expect(seen.values).toEqual([
      expect.objectContaining({
        verdict: "broken",
        reasons: ["CHECK_FAILED"],
        criteria: [
          { id: "c1", state: "failed" },
          { id: "c2", state: "failed" },
        ],
      }),
    ]);
  });

  it("keys a record with no lock by its computed digest, and breaks it", async () => {
    const seen = fakeTx([]);
    await expect(recordDoneVerdict(SCOPE, loaded({ c1: true, c2: true }, UNLOCKED))).resolves.toMatchObject({
      digest: DIGEST,
      verdict: "broken",
    });
    expect(seen.values).toEqual([expect.objectContaining({ recordDigest: DIGEST, reasons: ["LOCK_MISMATCH"] })]);
  });

  it("keeps the stored digest for a record edited after its lock", async () => {
    const seen = fakeTx([{ verdict: "held" }]);
    const edited: DoneRecord = { ...LOCKED, lineage: "aintel.platform.other" };
    await recordDoneVerdict(SCOPE, loaded({ c1: true, c2: true }, edited));
    expect(seen.values).toEqual([
      expect.objectContaining({ recordDigest: DIGEST, verdict: "broken", reasons: ["LOCK_MISMATCH"] }),
    ]);
  });

  it("throws when the insert returns no row", async () => {
    fakeTx([], []);
    await expect(recordDoneVerdict(SCOPE, loaded({}))).rejects.toThrow(
      `work.done_verdicts returned no row for ${DIGEST}`,
    );
  });
});

describe("workDoneVerdict", () => {
  function run() {
    const steps: string[] = [];
    const sendEvent = vi.fn<SendEvent>(() => Promise.resolve());
    const done = (captured.handler as Handler)({
      event: { data: EVENT_DATA },
      step: {
        run: async (name, fn) => {
          steps.push(name);
          return fn();
        },
        sendEvent,
      },
    });
    return { done, steps, sendEvent };
  }

  it("runs once per work order on each finished stage", () => {
    expect(captured.trigger).toEqual({ event: "work/stage.completed" });
    expect(captured.options).toEqual({
      id: "work.done.verdict",
      retries: 3,
      concurrency: { limit: 1, key: "event.data.work_order_id" },
    });
  });

  it("refuses to run without an evidence loader", async () => {
    const { done, steps } = run();
    await expect(done).rejects.toBeInstanceOf(NonRetriableError);
    await expect(done).rejects.toThrow("setDoneEvidenceLoader");
    expect(steps).toEqual([]);
  });

  it("sends nothing when the work order has no locked done record", async () => {
    const load = vi.fn(() => Promise.resolve(null));
    setDoneEvidenceLoader(load);
    const { done, steps, sendEvent } = run();
    await expect(done).resolves.toEqual({ status: "no_record" });
    expect(load).toHaveBeenCalledWith(EVENT_DATA);
    expect(steps).toEqual(["record-verdict"]);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("sends nothing when the verdict did not change", async () => {
    fakeTx([{ verdict: "pending" }]);
    setDoneEvidenceLoader(() => Promise.resolve(loaded({})));
    const { done, sendEvent } = run();
    await expect(done).resolves.toEqual({ status: "unchanged", digest: DIGEST, verdict: "pending" });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("sends work/done.verdict once per new row", async () => {
    fakeTx([{ verdict: "pending" }], [{ id: "row-7" }]);
    setDoneEvidenceLoader(() => Promise.resolve(loaded({ c1: true, c2: true })));
    const { done, steps, sendEvent } = run();
    await expect(done).resolves.toEqual({ status: "recorded", id: "row-7", digest: DIGEST, verdict: "held" });
    expect(steps).toEqual(["record-verdict"]);
    expect(sendEvent).toHaveBeenCalledWith("send-verdict", {
      name: "work/done.verdict",
      id: "work-done-verdict:row-7",
      data: { org_id: ORG, workspace_id: WORKSPACE, record_digest: DIGEST, verdict: "held" },
    });
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(SCOPE, expect.any(Function));
  });
});
