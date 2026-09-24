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
  return { runPublicId, orgId: ORG, workspaceId: WS };
}

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

    const [listed] = mocks.listIdleLedgerAttempts.mock.calls[0] as [
      { cutoff: Date; limit: number },
    ];
    expect(listed.limit).toBe(500);
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
    expect(out).toEqual({ found: 2, closed: 2 });
  });

  it("sends nothing for an attempt that moved since the scan", async () => {
    mocks.listIdleLedgerAttempts.mockResolvedValue([idle("arun_a")]);
    mocks.closeIdleLedgerAttempt.mockResolvedValue(null);
    const out = await handler!({ event: { data: {} }, step });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ found: 1, closed: 0 });
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
    expect(out).toEqual({ found: 2, closed: 1 });
  });
});
