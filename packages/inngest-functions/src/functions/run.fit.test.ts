// `run.fit`: the durable job that asks the installed runner for a sealed
// run's Model fit reading (#3893). The runner is `@oxagen/handlers`' own
// (lib/run-fit.ts); here it is a fake, so the test holds the job's contract:
// one reading per run at a time, a bad event refused without a retry, and a
// degraded store left to Inngest's retries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: { info: mocks.info, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  event: { data: unknown };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;
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

const { setRunFitRunner } = await import("../lib/run-fit-runner");
await import("./run.fit");

const step = { run: (_: string, fn: () => Promise<unknown>) => fn() };
const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const run = (data: unknown) => {
  if (handler === null) throw new Error("run.fit registered no handler");
  return handler({ event: { data }, step });
};

describe("run.fit", () => {
  const runner = vi.fn();
  beforeEach(() => {
    runner.mockReset();
    mocks.info.mockClear();
    setRunFitRunner(runner);
  });

  it("reads one run at a time, on the event the rollup sends", () => {
    expect(config?.id).toBe("run.fit");
    expect(config?.concurrency?.key).toBe("event.data.runId");
    expect(trigger?.event).toBe("run/fit.requested");
  });

  it("asks the runner for the run's reading in the run's own scope", async () => {
    runner.mockResolvedValue("written");
    await expect(run({ ...SCOPE, runId: "tse_abc" })).resolves.toEqual({
      runId: "tse_abc",
      outcome: "written",
    });
    expect(runner).toHaveBeenCalledWith(SCOPE, "tse_abc");
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("writes nothing for a run that is live again, or that no store holds, and says so", async () => {
    runner.mockResolvedValueOnce("live").mockResolvedValueOnce("not_found");
    await expect(run({ ...SCOPE, runId: "tse_live" })).resolves.toMatchObject({
      outcome: "live",
    });
    await expect(run({ ...SCOPE, runId: "arun_gone" })).resolves.toMatchObject(
      { outcome: "not_found" },
    );
    expect(mocks.info).toHaveBeenCalledTimes(2);
  });

  it("refuses an event that names no run or no scope, without a retry (negative)", async () => {
    for (const data of [{}, { ...SCOPE }, { runId: "tse_abc" }, null])
      await expect(run(data)).rejects.toMatchObject({
        name: "NonRetriableError",
      });
    expect(runner).not.toHaveBeenCalled();
  });

  it("lets a degraded store fail the step so Inngest retries", async () => {
    runner.mockRejectedValue(new Error("clickhouse down"));
    await expect(run({ ...SCOPE, runId: "tse_abc" })).rejects.toThrow(
      "clickhouse down",
    );
  });
});
