import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listIdleSessions: vi.fn(),
  closeIdleSession: vi.fn(),
  createFunction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../lib/tacho-idle-close", () => ({
  listIdleSessions: mocks.listIdleSessions,
  closeIdleSession: mocks.closeIdleSession,
  idleCutoff: (now: Date) => new Date(now.getTime() - 12 * 60 * 60 * 1000),
}));
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
let config: { concurrency?: { limit: number } } | null = null;
let trigger: { cron?: string } | null = null;
mocks.createFunction.mockImplementation(
  (opts: typeof config, on: typeof trigger, fn: Handler) => {
    config = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

await import("./tacho.session-idle-close");

const sendEvent = vi.fn(async () => {});
const step = {
  run: (_: string, fn: () => Promise<unknown>) => fn(),
  sendEvent,
};

const ORG = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const WS = "0192d4a8-7c1e-7a00-8000-0000000000a2";

function idle(publicId: string, parentSessionUuid: string | null = null) {
  return { publicId, orgId: ORG, workspaceId: WS, parentSessionUuid };
}

describe("tacho.session-idle-close", () => {
  beforeEach(() => {
    mocks.listIdleSessions.mockReset();
    mocks.closeIdleSession.mockReset();
    mocks.warn.mockReset();
    sendEvent.mockClear();
  });

  it("runs every fifteen minutes, one pass at a time", () => {
    expect(trigger).toEqual({ cron: "*/15 * * * *" });
    expect(config?.concurrency).toEqual({ limit: 1 });
  });

  it("closes each idle session and asks for the final rollup of each closed run", async () => {
    mocks.listIdleSessions.mockResolvedValue([
      idle("tse_root"),
      idle("tse_child", "0192d4a8-7c1e-7a00-8000-0000000000f1"),
    ]);
    mocks.closeIdleSession.mockImplementation(
      async (session: ReturnType<typeof idle>) => ({
        publicId: session.publicId,
        orgId: ORG,
        workspaceId: WS,
        isRoot: session.parentSessionUuid === null,
      }),
    );
    const out = await handler!({ event: { data: {} }, step });

    const [listed] = mocks.listIdleSessions.mock.calls[0] as [
      { cutoff: Date; limit: number },
    ];
    expect(listed.limit).toBe(500);
    expect(mocks.closeIdleSession).toHaveBeenCalledTimes(2);
    // A subagent's frames are its root's cost: only the run gets an event.
    expect(sendEvent).toHaveBeenCalledWith("request-rollups", [
      {
        name: "cost/run.sealed",
        data: { runId: "tse_root", orgId: ORG, workspaceId: WS },
      },
    ]);
    expect(out).toEqual({ found: 2, closed: 2, runs: 1 });
  });

  it("skips a session that moved since the scan and sends nothing for it", async () => {
    mocks.listIdleSessions.mockResolvedValue([idle("tse_root")]);
    mocks.closeIdleSession.mockResolvedValue(null);
    const out = await handler!({ event: { data: {} }, step });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ found: 1, closed: 0, runs: 0 });
  });

  it("logs a session that fails to close and carries on with the rest", async () => {
    mocks.listIdleSessions.mockResolvedValue([
      idle("tse_broken"),
      idle("tse_ok"),
    ]);
    mocks.closeIdleSession
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce({
        publicId: "tse_ok",
        orgId: ORG,
        workspaceId: WS,
        isRoot: true,
      });
    const out = await handler!({ event: { data: {} }, step });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ found: 2, closed: 1, runs: 1 });
  });
});
