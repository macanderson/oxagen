// work.done.verdict.test.ts: the verdict row a finished stage appends, the
// check run it records (F13, #4638), and the work/done.verdict event it sends.
import { lockDigest, type DoneRecord } from "@oxagen/done-record";
import { NonRetriableError } from "@oxagen/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkStageCompletedEventData } from "../events";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** The mocked tables, shared by the schema mock and the fake transaction. */
const tables = vi.hoisted(() => ({
  verdicts: {
    id: "verdicts.id",
    orgId: "verdicts.org_id",
    workspaceId: "verdicts.workspace_id",
    createdAt: "verdicts.created_at",
    recordDigest: "verdicts.record_digest",
    verdict: "verdicts.verdict",
  },
  orders: {
    id: "orders.id",
    publicId: "orders.public_id",
    orgId: "orders.org_id",
    workspaceId: "orders.workspace_id",
  },
  checks: {
    orderId: "checks.order_id",
    sessionId: "checks.session_id",
  },
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
    workDoneVerdicts: tables.verdicts,
    workOrders: tables.orders,
    workDoneChecks: tables.checks,
  },
  withTenantDb: mocks.withTenantDb,
  // One identity for both seams, so a role gate that reads through withOrgDb
  // stays inside the mock (check:db-mock-seams, ADR-086).
  withOrgDb: mocks.withTenantDb,
}));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
  or: (...args: unknown[]) => ({ or: args }),
  desc: (column: unknown) => ({ desc: column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?"), values }),
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mocks.runInTenantScope }));
vi.mock("../logger", () => ({ logger: mocks.logger }));

const { doneCheckResult, recordDoneVerdict, setDoneEvidenceLoader } = await import("./work.done.verdict");
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

const ORDER = "0193a8f0-0000-7000-8000-000000000003";
const SESSION = "0193a8f0-0000-7000-8000-000000000004";

const EVENT_DATA: WorkStageCompletedEventData = {
  org_id: ORG,
  workspace_id: WORKSPACE,
  work_order_id: ORDER,
  role: "Fix",
  session_id: SESSION,
};

/** The stage whose end ran the check. */
const CHECK = { workOrderId: ORDER, sessionId: SESSION, role: "Fix" };

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

/**
 * A transaction whose last verdict row is `last`, whose verdict insert returns
 * `inserted`, and whose work order lookup finds `order`.
 */
function fakeTx(
  last: { verdict: string }[],
  inserted: { id: string }[] = [{ id: "row-2" }],
  order: { id: string }[] = [{ id: ORDER }],
) {
  const seen = {
    executed: [] as unknown[],
    where: [] as unknown[],
    orderBy: [] as unknown[],
    limit: [] as unknown[],
    /** Verdict rows. */
    values: [] as unknown[],
    /** The work order lookup's filter. */
    orderWhere: [] as unknown[],
    /** Check run rows, and each one's conflict target. */
    checks: [] as unknown[],
    conflicts: [] as unknown[],
  };
  const tx = {
    execute: (query: unknown) => {
      seen.executed.push(query);
      return Promise.resolve();
    },
    select: () => ({
      from: (table: unknown) => ({
        where: (where: unknown) => {
          if (table === tables.orders) {
            seen.orderWhere.push(where);
            return { limit: () => Promise.resolve(order) };
          }
          seen.where.push(where);
          return {
            orderBy: (...orderBy: unknown[]) => {
              seen.orderBy.push(orderBy);
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
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (table === tables.checks) {
          seen.checks.push(values);
          return {
            onConflictDoNothing: (config: unknown) => {
              seen.conflicts.push(config);
              return Promise.resolve();
            },
          };
        }
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
    await expect(recordDoneVerdict(SCOPE, loaded({}), CHECK)).resolves.toEqual({
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
    await recordDoneVerdict(SCOPE, loaded({}), CHECK);
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
    await expect(recordDoneVerdict(SCOPE, loaded({ c1: true }), CHECK)).resolves.toEqual({
      status: "unchanged",
      digest: DIGEST,
      verdict: "pending",
    });
    expect(seen.values).toEqual([]);
  });

  it("appends a changed verdict with the criteria states and the commit", async () => {
    const seen = fakeTx([{ verdict: "pending" }], [{ id: "row-3" }]);
    const input = { ...loaded({ c1: true, c2: true }), commitSha: "4f2a9c1" };
    await expect(recordDoneVerdict(SCOPE, input, CHECK)).resolves.toEqual({
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
    await recordDoneVerdict(SCOPE, loaded({ c1: false, c2: false }), CHECK);
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
    await expect(recordDoneVerdict(SCOPE, loaded({ c1: true, c2: true }, UNLOCKED), CHECK)).resolves.toMatchObject({
      digest: DIGEST,
      verdict: "broken",
    });
    expect(seen.values).toEqual([expect.objectContaining({ recordDigest: DIGEST, reasons: ["LOCK_MISMATCH"] })]);
  });

  it("keeps the stored digest for a record edited after its lock", async () => {
    const seen = fakeTx([{ verdict: "held" }]);
    const edited: DoneRecord = { ...LOCKED, lineage: "aintel.platform.other" };
    await recordDoneVerdict(SCOPE, loaded({ c1: true, c2: true }, edited), CHECK);
    expect(seen.values).toEqual([
      expect.objectContaining({ recordDigest: DIGEST, verdict: "broken", reasons: ["LOCK_MISMATCH"] }),
    ]);
  });

  it("records a check run with its work order, verdict, result, and time", async () => {
    const seen = fakeTx([]);
    await recordDoneVerdict(SCOPE, loaded({}), CHECK);
    expect(seen.checks).toEqual([
      {
        orgId: ORG,
        workspaceId: WORKSPACE,
        orderId: ORDER,
        recordDigest: DIGEST,
        verdict: "pending",
        result: "pending",
        checkedAt: { sql: "clock_timestamp()", values: [] },
        sessionId: SESSION,
        role: "Fix",
      },
    ]);
    // One row per work order and stage session, so a retried step adds none.
    expect(seen.conflicts).toEqual([{ target: ["checks.order_id", "checks.session_id"] }]);
  });

  it("records a check run when the verdict did not change", async () => {
    const seen = fakeTx([{ verdict: "pending" }]);
    await recordDoneVerdict(SCOPE, loaded({ c1: true }), CHECK);
    expect(seen.values).toEqual([]);
    expect(seen.checks).toEqual([expect.objectContaining({ verdict: "pending", result: "pending" })]);
  });

  it("records a passing check run for a held record and a failing one for a broken record", async () => {
    const held = fakeTx([{ verdict: "pending" }]);
    await recordDoneVerdict(SCOPE, loaded({ c1: true, c2: true }), CHECK);
    expect(held.checks).toEqual([expect.objectContaining({ verdict: "held", result: "passed" })]);

    const broken = fakeTx([{ verdict: "held" }]);
    await recordDoneVerdict(SCOPE, loaded({ c1: false, c2: true }), CHECK);
    expect(broken.checks).toEqual([expect.objectContaining({ verdict: "broken", result: "failed" })]);
  });

  it("finds the work order by its id or public id in the event's workspace", async () => {
    const byId = fakeTx([]);
    await recordDoneVerdict(SCOPE, loaded({}), CHECK);
    expect(byId.orderWhere).toEqual([
      {
        and: [
          { eq: ["orders.org_id", ORG] },
          { eq: ["orders.workspace_id", WORKSPACE] },
          { or: [{ eq: ["orders.id", ORDER] }, { eq: ["orders.public_id", ORDER] }] },
        ],
      },
    ]);

    const byPublicId = fakeTx([]);
    await recordDoneVerdict(SCOPE, loaded({}), { ...CHECK, workOrderId: "wo_01K5ZQ4M8T2DXW" });
    expect(byPublicId.orderWhere).toEqual([
      {
        and: [
          { eq: ["orders.org_id", ORG] },
          { eq: ["orders.workspace_id", WORKSPACE] },
          { eq: ["orders.public_id", "wo_01K5ZQ4M8T2DXW"] },
        ],
      },
    ]);
    expect(byPublicId.checks).toEqual([expect.objectContaining({ orderId: ORDER })]);
  });

  it("refuses a work order the workspace does not hold, and writes nothing", async () => {
    const seen = fakeTx([], [{ id: "row-2" }], []);
    const done = recordDoneVerdict(SCOPE, loaded({}), CHECK);
    await expect(done).rejects.toBeInstanceOf(NonRetriableError);
    await expect(done).rejects.toThrow(`names work order ${ORDER}`);
    expect(seen.checks).toEqual([]);
    expect(seen.values).toEqual([]);
  });

  it("gives each verdict its check result", () => {
    expect(doneCheckResult("held")).toBe("passed");
    expect(doneCheckResult("proven")).toBe("passed");
    expect(doneCheckResult("broken")).toBe("failed");
    expect(doneCheckResult("pending")).toBe("pending");
  });

  it("throws when the insert returns no row", async () => {
    fakeTx([], []);
    await expect(recordDoneVerdict(SCOPE, loaded({}), CHECK)).rejects.toThrow(
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

  it("records the check run under the event's work order, session, and role", async () => {
    const seen = fakeTx([{ verdict: "pending" }]);
    setDoneEvidenceLoader(() => Promise.resolve(loaded({})));
    const { done } = run();
    await done;
    expect(seen.checks).toEqual([
      expect.objectContaining({ orderId: ORDER, sessionId: SESSION, role: "Fix", result: "pending" }),
    ]);
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
