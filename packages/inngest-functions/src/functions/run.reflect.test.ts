// `run.reflect`: the durable job that stores what a sealed run recorded
// (ADR-206). The runner is `@oxagen/handlers`' own (memory/runner.ts); here it
// is a fake, so the test holds the job's contract: one capture per run at a
// time, a digest only when capture asks for one, a curate request at 20
// waiting memories, and a bad event refused without a retry.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: { info: mocks.info, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Step = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: (name: string, event: unknown) => Promise<unknown>;
};
type Handler = (ctx: { event: { data: unknown }; step: Step }) => Promise<unknown>;
let handler: Handler | null = null;
let config: { concurrency?: { key: string }; id?: string } | null = null;
let trigger: { event?: string } | null = null;
mocks.createFunction.mockImplementation(
  (opts: typeof config, on: typeof trigger, fn: Handler) => {
    config = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

const { setMemoryRunner } = await import("../lib/memory-runner");
await import("./run.reflect");

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const sendEvent = vi.fn(async () => undefined);
const steps: string[] = [];
const step: Step = {
  run: (name, fn) => {
    steps.push(name);
    return fn();
  },
  sendEvent,
};
const run = (data: unknown) => {
  if (handler === null) throw new Error("run.reflect registered no handler");
  return handler({ event: { data }, step });
};

const captured = (over: Record<string, unknown> = {}) => ({
  outcome: "captured",
  memories: 2,
  reflected: true,
  digest: false,
  waiting: 3,
  ...over,
});

describe("run.reflect", () => {
  const capture = vi.fn();
  const digest = vi.fn();
  beforeEach(() => {
    capture.mockReset();
    digest.mockReset();
    sendEvent.mockClear();
    mocks.info.mockClear();
    steps.length = 0;
    setMemoryRunner({
      capture,
      digest,
      curate: vi.fn(),
      workspaces: vi.fn(),
    });
  });

  it("captures one run at a time, on the event every seal sends", () => {
    expect(config?.id).toBe("run.reflect");
    expect(config?.concurrency?.key).toBe("event.data.runId");
    expect(trigger?.event).toBe("cost/run.sealed");
  });

  it("captures the run in its own scope and writes no digest when the agent reflected", async () => {
    capture.mockResolvedValue(captured());
    await expect(run({ ...SCOPE, runId: "tse_abc" })).resolves.toEqual({
      runId: "tse_abc",
      outcome: "captured",
      memories: 2,
      reflected: true,
      digest: null,
      curate: false,
    });
    expect(capture).toHaveBeenCalledWith(SCOPE, "tse_abc");
    expect(digest).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(steps).toEqual(["capture"]);
  });

  it("writes a digest reflection in its own step when capture asks for one", async () => {
    capture.mockResolvedValue(captured({ reflected: false, digest: true }));
    digest.mockResolvedValue("written");
    await expect(run({ ...SCOPE, runId: "tse_abc" })).resolves.toMatchObject({
      digest: "written",
    });
    expect(digest).toHaveBeenCalledWith(SCOPE, "tse_abc");
    expect(steps).toEqual(["capture", "digest"]);
  });

  it("asks the curator to run once 20 memories wait, and not at 19", async () => {
    capture.mockResolvedValueOnce(captured({ waiting: 19 }));
    await run({ ...SCOPE, runId: "tse_abc" });
    expect(sendEvent).not.toHaveBeenCalled();

    capture.mockResolvedValueOnce(captured({ waiting: 20 }));
    await expect(run({ ...SCOPE, runId: "tse_def" })).resolves.toMatchObject({
      curate: true,
    });
    expect(sendEvent).toHaveBeenCalledWith("request-curate", {
      name: "memory/curate.requested",
      data: { ...SCOPE, reason: "waiting" },
    });
  });

  it("stops at a run no store holds, or one that is live again, and says so", async () => {
    capture
      .mockResolvedValueOnce(captured({ outcome: "not_found", waiting: 40 }))
      .mockResolvedValueOnce(captured({ outcome: "live", digest: true }));
    await expect(run({ ...SCOPE, runId: "arun_gone" })).resolves.toEqual({
      runId: "arun_gone",
      outcome: "not_found",
    });
    await expect(run({ ...SCOPE, runId: "tse_live" })).resolves.toEqual({
      runId: "tse_live",
      outcome: "live",
    });
    expect(digest).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledTimes(2);
  });

  it("refuses an event that names no run or no scope, without a retry (negative)", async () => {
    for (const data of [{}, { ...SCOPE }, { runId: "tse_abc" }, null])
      await expect(run(data)).rejects.toMatchObject({
        name: "NonRetriableError",
      });
    expect(capture).not.toHaveBeenCalled();
  });

  it("lets a degraded store fail the step so Inngest retries", async () => {
    capture.mockRejectedValue(new Error("clickhouse down"));
    await expect(run({ ...SCOPE, runId: "tse_abc" })).rejects.toThrow(
      "clickhouse down",
    );
  });
});
