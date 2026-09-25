import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abandonSilentAssistantRuns: vi.fn(),
  listDedicatedPlaneScopes: vi.fn(),
  createFunction: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/assistant-run-abandon", () => ({
  abandonSilentAssistantRuns: mocks.abandonSilentAssistantRuns,
  listDedicatedPlaneScopes: mocks.listDedicatedPlaneScopes,
  abandonCutoff: (now: Date) => new Date(now.getTime() - 12 * 60 * 1000),
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.error },
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

const { ABANDON_BATCH, abandonedRollupEventId } = await import(
  "./evidence.assistant-run-abandon"
);

const steps: string[] = [];
const sendEvent = vi.fn(async () => {});
const step = {
  run: (name: string, fn: () => Promise<unknown>) => {
    steps.push(name);
    return fn();
  },
  sendEvent,
};

const ORG = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const WS = "0192d4a8-7c1e-7a00-8000-0000000000a2";
const DEDICATED_ORG = "0192d4a8-7c1e-7a00-8000-0000000000d1";
const DEDICATED_WS = "0192d4a8-7c1e-7a00-8000-0000000000d2";

const run = (publicId: string, orgId = ORG, workspaceId = WS) => ({
  publicId,
  orgId,
  workspaceId,
});

describe("evidence.assistant-run-abandon", () => {
  beforeEach(() => {
    mocks.abandonSilentAssistantRuns.mockReset();
    mocks.listDedicatedPlaneScopes.mockReset();
    mocks.listDedicatedPlaneScopes.mockResolvedValue([]);
    mocks.error.mockReset();
    sendEvent.mockClear();
    steps.length = 0;
  });

  it("runs every five minutes, one pass at a time", () => {
    expect(config?.id).toBe("evidence.assistant-run-abandon");
    expect(trigger).toEqual({ cron: "*/5 * * * *" });
    expect(config?.concurrency).toEqual({ limit: 1 });
  });

  it("seals the silent runs of the shared plane and asks for each final rollup", async () => {
    mocks.abandonSilentAssistantRuns.mockResolvedValue({
      found: 2,
      abandoned: [run("arun_one")],
    });
    const out = await handler!({ event: { data: {} }, step });

    const [args] = mocks.abandonSilentAssistantRuns.mock.calls[0] as [
      { cutoff: Date; limit: number; excludeOrgIds: string[] },
    ];
    expect(args.limit).toBe(ABANDON_BATCH);
    expect(args.excludeOrgIds).toEqual([]);
    expect(sendEvent).toHaveBeenCalledWith("request-rollups", [
      {
        name: "cost/run.sealed",
        id: "cost-run-sealed:arun_one:abandoned",
        data: { runId: "arun_one", orgId: ORG, workspaceId: WS },
      },
    ]);
    expect(out).toEqual({ found: 2, abandoned: 1 });
  });

  it("sends nothing when every run it found moved since the scan", async () => {
    mocks.abandonSilentAssistantRuns.mockResolvedValue({
      found: 1,
      abandoned: [],
    });
    const out = await handler!({ event: { data: {} }, step });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ found: 1, abandoned: 0 });
  });

  it("sweeps each dedicated workspace in its own step and leaves its organization out of the shared scan", async () => {
    mocks.listDedicatedPlaneScopes.mockResolvedValue([
      { orgId: DEDICATED_ORG, workspaceId: DEDICATED_WS },
    ]);
    mocks.abandonSilentAssistantRuns
      .mockResolvedValueOnce({ found: 0, abandoned: [] })
      .mockResolvedValueOnce({
        found: 1,
        abandoned: [run("arun_two", DEDICATED_ORG, DEDICATED_WS)],
      });
    const out = await handler!({ event: { data: {} }, step });

    const calls = mocks.abandonSilentAssistantRuns.mock.calls as Array<
      [{ excludeOrgIds?: string[]; scope?: unknown }]
    >;
    expect(calls[0]![0].excludeOrgIds).toEqual([DEDICATED_ORG]);
    expect(calls[1]![0].scope).toEqual({
      orgId: DEDICATED_ORG,
      workspaceId: DEDICATED_WS,
    });
    expect(steps).toEqual([
      "find-dedicated-workspaces",
      "abandon-shared-plane",
      `abandon-${DEDICATED_WS}`,
    ]);
    expect(out).toEqual({ found: 1, abandoned: 1 });
  });

  it("logs a dedicated plane it cannot reach and carries on", async () => {
    mocks.listDedicatedPlaneScopes.mockResolvedValue([
      { orgId: DEDICATED_ORG, workspaceId: DEDICATED_WS },
    ]);
    mocks.abandonSilentAssistantRuns
      .mockResolvedValueOnce({ found: 1, abandoned: [run("arun_one")] })
      .mockRejectedValueOnce(new Error("plane unreachable"));
    const out = await handler!({ event: { data: {} }, step });
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ found: 1, abandoned: 1 });
  });

  it("gives each run's rollup request a stable dedup id", () => {
    expect(abandonedRollupEventId("arun_one")).toBe(
      abandonedRollupEventId("arun_one"),
    );
    expect(abandonedRollupEventId("arun_one")).not.toBe(
      abandonedRollupEventId("arun_two"),
    );
  });
});
