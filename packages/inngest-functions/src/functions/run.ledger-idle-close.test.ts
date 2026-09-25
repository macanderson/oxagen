import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listIdleLedgerAttempts: vi.fn(),
  closeIdleLedgerAttempt: vi.fn(),
  ledgerStore: vi.fn(() => ({ sealAttempt: vi.fn() })),
  createFunction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/run-ledger", () => ({
  listIdleLedgerAttempts: mocks.listIdleLedgerAttempts,
  ledgerIdleCutoff: (now: Date) =>
    new Date(now.getTime() - 12 * 60 * 60 * 1000),
}));
vi.mock("../lib/ledger-idle-close", () => ({
  closeIdleLedgerAttempt: mocks.closeIdleLedgerAttempt,
}));
vi.mock("../lib/run-record", () => ({ ledgerStore: mocks.ledgerStore }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sendEvent: (label: string, event: unknown) => Promise<void>;
  };
}) => Promise<unknown>;
let handler: Handler | null = null;
let config: { id?: string; concurrency?: { limit: number } } | null = null;
let trigger: { cron?: string } | null = null;
mocks.createFunction.mockImplementation(
  (opts: typeof config, on: typeof trigger, fn: Handler) => {
    config = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

await import("./run.ledger-idle-close");

const sendEvent = vi.fn(async () => {});
const step = {
  run: (_: string, fn: () => Promise<unknown>) => fn(),
  sendEvent,
};

const ORG = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const WS = "0192d4a8-7c1e-7a00-8000-0000000000a2";

function idle(runPublicId: string) {
  return {
    runPublicId,
    attemptId: `attempt-${runPublicId}`,
    orgId: ORG,
    workspaceId: WS,
  };
}

type Listed = { cutoff: Date; limit: number; exclude: string[] };

describe("run.ledger-idle-close (#3988)", () => {
  beforeEach(() => {
    mocks.listIdleLedgerAttempts.mockReset();
    mocks.closeIdleLedgerAttempt.mockReset();
    mocks.warn.mockReset();
    sendEvent.mockClear();
  });

  it("runs every fifteen minutes, one pass at a time", () => {
    expect(config?.id).toBe("run.ledger-idle-close");
    expect(trigger).toEqual({ cron: "*/15 * * * *" });
    expect(config?.concurrency).toEqual({ limit: 1 });
  });

  it("seals each idle attempt and asks for the final rollup of each closed run", async () => {
    mocks.listIdleLedgerAttempts.mockResolvedValue([
      idle("arun_a"),
      idle("arun_b"),
    ]);
    mocks.closeIdleLedgerAttempt.mockImplementation(
      async (attempt: ReturnType<typeof idle>) => attempt,
    );
    const out = await handler!({ event: { data: {} }, step });

    const [listed] = mocks.listIdleLedgerAttempts.mock.calls[0] as [Listed];
    expect(listed.limit).toBe(500);
    expect(listed.exclude).toEqual([]);
    // A short page ends the pass: nothing idle is left to scan for.
    expect(mocks.listIdleLedgerAttempts).toHaveBeenCalledTimes(1);
    expect(Date.now() - listed.cutoff.getTime()).toBeGreaterThanOrEqual(
      12 * 60 * 60 * 1000,
    );
    expect(mocks.closeIdleLedgerAttempt).toHaveBeenCalledTimes(2);
    expect(sendEvent).toHaveBeenCalledWith("request-rollups", [
      {
        name: "cost/run.sealed",
        data: { runId: "arun_a", orgId: ORG, workspaceId: WS },
      },
      {
        name: "cost/run.sealed",
        data: { runId: "arun_b", orgId: ORG, workspaceId: WS },
      },
    ]);
    expect(out).toEqual({ found: 2, failed: 0, closed: 2 });
  });

  it("sends nothing for an attempt that moved since the scan", async () => {
    mocks.listIdleLedgerAttempts.mockResolvedValue([idle("arun_a")]);
    mocks.closeIdleLedgerAttempt.mockResolvedValue(null);
    const out = await handler!({ event: { data: {} }, step });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ found: 1, failed: 0, closed: 0 });
  });

  it("logs an attempt that fails to close and carries on with the rest", async () => {
    mocks.listIdleLedgerAttempts.mockResolvedValue([
      idle("arun_broken"),
      idle("arun_ok"),
    ]);
    mocks.closeIdleLedgerAttempt
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce(idle("arun_ok"));
    const out = await handler!({ event: { data: {} }, step });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("request-rollups", [
      {
        name: "cost/run.sealed",
        data: { runId: "arun_ok", orgId: ORG, workspaceId: WS },
      },
    ]);
    expect(out).toEqual({ found: 2, failed: 1, closed: 1 });
  });

  // F10: the scan is oldest first, so attempts whose close always fails
  // would fill every batch. The pass scans again past the ones it tried.
  it("scans past attempts it could not close, so they cannot fill every batch", async () => {
    const broken = Array.from({ length: 500 }, (_, i) => idle(`arun_bad${i}`));
    mocks.listIdleLedgerAttempts
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce([idle("arun_ok")]);
    mocks.closeIdleLedgerAttempt.mockImplementation(
      async (attempt: ReturnType<typeof idle>) => {
        if (attempt.runPublicId === "arun_ok") return attempt;
        throw new Error("sequence hole");
      },
    );
    const out = await handler!({ event: { data: {} }, step });

    expect(mocks.listIdleLedgerAttempts).toHaveBeenCalledTimes(2);
    const [second] = mocks.listIdleLedgerAttempts.mock.calls[1] as [Listed];
    expect(second.limit).toBe(500);
    expect(second.exclude).toEqual(broken.map((a) => a.attemptId));
    expect(sendEvent).toHaveBeenCalledWith("request-rollups", [
      {
        name: "cost/run.sealed",
        data: { runId: "arun_ok", orgId: ORG, workspaceId: WS },
      },
    ]);
    expect(out).toEqual({ found: 501, failed: 500, closed: 1 });
  });

  it("stops after a bounded number of scans when every close fails", async () => {
    let page = 0;
    mocks.listIdleLedgerAttempts.mockImplementation(async () => {
      page += 1;
      return Array.from({ length: 500 }, (_, i) => idle(`arun_p${page}_${i}`));
    });
    mocks.closeIdleLedgerAttempt.mockRejectedValue(new Error("archive down"));
    const out = await handler!({ event: { data: {} }, step });

    expect(mocks.listIdleLedgerAttempts).toHaveBeenCalledTimes(4);
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ found: 2000, failed: 2000, closed: 0 });
  });

  it("asks only for what is left of the batch on a later scan", async () => {
    const first = Array.from({ length: 500 }, (_, i) => idle(`arun_${i}`));
    mocks.listIdleLedgerAttempts
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([]);
    mocks.closeIdleLedgerAttempt.mockImplementation(
      async (attempt: ReturnType<typeof idle>) => {
        if (attempt.runPublicId === "arun_0") throw new Error("lock timeout");
        return attempt;
      },
    );
    const out = await handler!({ event: { data: {} }, step });

    const [second] = mocks.listIdleLedgerAttempts.mock.calls[1] as [Listed];
    expect(second.limit).toBe(1);
    expect(out).toEqual({ found: 500, failed: 1, closed: 499 });
  });
});
