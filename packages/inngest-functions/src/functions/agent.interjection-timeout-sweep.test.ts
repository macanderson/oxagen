// The backstop for the durable interjection timeout (#3941, D8): every five
// minutes it lists the repository questions still unsettled past their
// deadline and runs the deny step on each. These tests install a fake runner
// and a fake system transaction, and assert the predicate the scan builds.
//
// Guards and their negatives:
//   - the trigger is the five-minute cron, one pass at a time
//   - each listed row reaches the deny step with its tenant, its public id and
//     its deadline as an ISO string
//   - a deny that throws is logged and the next row is still denied
//   - nothing listed denies nothing, and a settled row counts as not settled
//   - the scan selects only unsettled repository questions past the cutoff:
//     no receipt, and unanswered or answered `deny` by the host
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
  withSystemDb: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {
    interjections: {
      publicId: "public_id",
      orgId: "org_id",
      workspaceId: "workspace_id",
      expiresAt: "expires_at",
      kind: "kind",
      receiptId: "receipt_id",
      answeredAt: "answered_at",
      path: "path",
    },
  },
}));
// Each operator returns a tagged tuple, so a test can assert the predicate
// the scan built: `and(isNull(x))` is ["and", ["isNull", "x"]].
vi.mock("drizzle-orm", () => {
  const op =
    (name: string) =>
    (...a: unknown[]) => [name, ...a];
  return {
    and: op("and"),
    or: op("or"),
    eq: op("eq"),
    isNull: op("isNull"),
    lt: op("lt"),
    asc: op("asc"),
  };
});
vi.mock("../logger", () => ({ logger: mocks.logger }));

import {
  type InterjectionDenyOutcome,
  type InterjectionTimeoutRunner,
  setInterjectionTimeoutRunner,
} from "../lib/interjection-timeout-runner";
import { DENY_GRACE_MS } from "./agent.interjection-timeout";
import {
  agentInterjectionTimeoutSweep,
  SWEEP_AFTER_MS,
  SWEEP_BATCH,
} from "./agent.interjection-timeout-sweep";

type Handler = (args: {
  step: { run: (id: string, fn: () => unknown) => unknown };
}) => Promise<unknown>;
const handler = agentInterjectionTimeoutSweep as unknown as Handler;
const step = { run: (_id: string, fn: () => unknown) => fn() };

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const NOW = new Date("2026-09-26T11:00:00.000Z");

type Row = {
  publicId: string;
  orgId: string;
  workspaceId: string;
  expiresAt: Date;
};
const row = (publicId: string, minutesAgo: number): Row => ({
  publicId,
  orgId: ORG,
  workspaceId: WS,
  expiresAt: new Date(NOW.getTime() - minutesAgo * 60_000),
});

/** What the scan built, recorded from the fake transaction. */
const scan: {
  where?: unknown;
  orderBy?: unknown;
  limit?: number;
  fields?: unknown;
} = {};

/** Serve `rows` from the system transaction and record the query. */
function listing(rows: Row[]): void {
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: (fields: unknown) => {
          scan.fields = fields;
          return {
            from: () => ({
              where: (where: unknown) => {
                scan.where = where;
                return {
                  orderBy: (orderBy: unknown) => {
                    scan.orderBy = orderBy;
                    return {
                      limit: async (limit: number) => {
                        scan.limit = limit;
                        return rows;
                      },
                    };
                  },
                };
              },
            }),
          };
        },
      }),
  );
}

const DENIED: InterjectionDenyOutcome = {
  outcome: "denied",
  receiptId: "rcp_0123abc",
  commandIds: ["tcm_0123abc"],
};

function install(
  deny: InterjectionTimeoutRunner["deny"],
): InterjectionTimeoutRunner["deny"] {
  const spy = vi.fn(deny);
  setInterjectionTimeoutRunner({
    resolve: vi.fn(async () => ({
      outcome: "skipped" as const,
      repository: null,
    })),
    deny: spy,
  });
  return spy;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.withSystemDb.mockReset();
  mocks.logger.info.mockClear();
  mocks.logger.warn.mockClear();
  for (const key of Object.keys(scan)) delete scan[key as keyof typeof scan];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent.interjection-timeout-sweep", () => {
  it("runs on a five-minute cron, one pass at a time", () => {
    expect(
      mocks.configs.find(
        (config) =>
          (config.options as { id: string }).id ===
          "agent/interjection-timeout-sweep",
      ),
    ).toEqual({
      options: {
        id: "agent/interjection-timeout-sweep",
        retries: 2,
        concurrency: { limit: 1 },
      },
      trigger: { cron: "*/5 * * * *" },
    });
  });

  it("waits well past the durable function's own second deny", () => {
    expect(SWEEP_AFTER_MS).toBeGreaterThan(DENY_GRACE_MS * 4);
  });

  it("denies each overdue question in its own tenant, by public id and ISO deadline", async () => {
    listing([row("inj_first", 40), row("inj_second", 10)]);
    const deny = install(async () => DENIED);

    await expect(handler({ step })).resolves.toEqual({
      found: 2,
      settled: 2,
      failed: 0,
    });
    expect(deny).toHaveBeenNthCalledWith(1, {
      orgId: ORG,
      workspaceId: WS,
      interjectionId: "inj_first",
      expiresAt: "2026-09-26T10:20:00.000Z",
    });
    expect(deny).toHaveBeenNthCalledWith(2, {
      orgId: ORG,
      workspaceId: WS,
      interjectionId: "inj_second",
      expiresAt: "2026-09-26T10:50:00.000Z",
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { interjections: ["inj_first", "inj_second"] },
      expect.stringContaining("the durable timeout missed"),
    );
  });

  it("selects only unsettled repository questions past the cutoff, oldest first", async () => {
    listing([]);
    install(async () => DENIED);

    await handler({ step });

    const cutoff = new Date(NOW.getTime() - SWEEP_AFTER_MS);
    expect(scan.where).toEqual([
      "and",
      ["eq", "kind", "repo_unknown"],
      ["isNull", "receipt_id"],
      ["or", ["isNull", "answered_at"], ["eq", "path", "deny"]],
      ["lt", "expires_at", cutoff],
    ]);
    expect(scan.orderBy).toEqual(["asc", "expires_at"]);
    expect(scan.limit).toBe(SWEEP_BATCH);
    expect(scan.fields).toEqual({
      publicId: "public_id",
      orgId: "org_id",
      workspaceId: "workspace_id",
      expiresAt: "expires_at",
    });
  });

  it("logs a deny that throws and still denies the next row (negative)", async () => {
    listing([row("inj_broken", 30), row("inj_after", 20)]);
    const deny = install(async (request) => {
      if (request.interjectionId === "inj_broken")
        throw new Error("tenant transaction failed");
      return DENIED;
    });

    await expect(handler({ step })).resolves.toEqual({
      found: 2,
      settled: 1,
      failed: 1,
    });
    expect(deny).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ interjectionId: "inj_broken" }),
      expect.stringContaining("the next pass retries it"),
    );
  });

  it("counts a question a person or an earlier run settled as not settled here (negative)", async () => {
    listing([row("inj_answered", 30)]);
    install(async () => ({
      outcome: "answered",
      receiptId: "rcp_0123abc",
      commandIds: [],
    }));

    await expect(handler({ step })).resolves.toEqual({
      found: 1,
      settled: 0,
      failed: 0,
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it("denies nothing when nothing is overdue (negative)", async () => {
    listing([]);
    const deny = install(async () => DENIED);

    await expect(handler({ step })).resolves.toEqual({
      found: 0,
      settled: 0,
      failed: 0,
    });
    expect(deny).not.toHaveBeenCalled();
  });

  it("warns when the batch is full, so the rest waits for the next pass", async () => {
    listing(
      Array.from({ length: SWEEP_BATCH }, (_, index) =>
        row(`inj_${index.toString(36)}`, 30),
      ),
    );
    install(async () => ({
      outcome: "answered",
      receiptId: null,
      commandIds: [],
    }));

    await handler({ step });

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { batch: SWEEP_BATCH },
      expect.stringContaining("the batch is full"),
    );
  });
});
