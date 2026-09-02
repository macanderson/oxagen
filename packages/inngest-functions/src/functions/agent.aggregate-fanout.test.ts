import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the kernel invoke so no real handler/DB runs. The aggregate capability
// returns a non-blocking snapshot; here we control what it reports.
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { agentAggregateFanout } from "./agent.aggregate-fanout";

type StepCalls = {
  waitForEvent: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
};

function makeStep(completionEvent: unknown): StepCalls {
  return {
    waitForEvent: vi.fn(async () => completionEvent),
    run: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    sendEvent: vi.fn(async () => undefined),
  };
}

const BASE_AGG = {
  fanoutId: "fan_1",
  status: "completed" as const,
  totalChildren: 3,
  completedChildren: 3,
  aggregatedData: { a: 1 },
  conflicts: [],
  timeline: [],
  children: [],
  aggregatedDataTruncated: false,
  recheckAfterMs: null,
  firstError: null,
};

// The inngest function handler is exposed as `.fn` on the created function.
const handler = (
  agentAggregateFanout as unknown as {
    fn: (args: {
      event: { data: Record<string, unknown> };
      step: StepCalls;
    }) => Promise<unknown>;
  }
).fn;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(BASE_AGG);
});

describe("agent.aggregate-fanout", () => {
  it("waits for the fanout-completed event, reads the aggregate, and emits aggregated", async () => {
    const step = makeStep({
      name: "agent/subagent.fanout.completed",
      data: { fanoutId: "fan_1" },
    });
    const out = (await handler({
      event: {
        data: {
          orgId: "org_1",
          workspaceId: "ws_1",
          fanoutId: "fan_1",
          timeoutMs: 60_000,
        },
      },
      step,
    })) as { fanoutId: string; status: string; timedOut: boolean };

    // Parks on the completion event, matched by fanoutId.
    expect(step.waitForEvent).toHaveBeenCalledWith(
      "await-fanout-completed",
      expect.objectContaining({
        event: "agent/subagent.fanout.completed",
        match: "data.fanoutId",
      }),
    );
    // Reads the snapshot via the kernel and emits the aggregated event.
    expect(mocks.invoke).toHaveBeenCalledWith(
      "aggregate_subagents",
      expect.objectContaining({ fanoutId: "fan_1" }),
      expect.objectContaining({
        orgId: "org_1",
        workspaceId: "ws_1",
        surface: "runner",
      }),
    );
    expect(step.sendEvent).toHaveBeenCalledWith(
      "emit-aggregated",
      expect.objectContaining({ name: "agent/subagent.aggregated" }),
    );
    expect(out.status).toBe("completed");
    expect(out.timedOut).toBe(false);
  });

  it("reports timedOut when the wait elapses (event is null) and still emits the snapshot", async () => {
    mocks.invoke.mockResolvedValue({
      ...BASE_AGG,
      status: "running",
      completedChildren: 1,
    });
    const step = makeStep(null); // waitForEvent timed out

    const out = (await handler({
      event: {
        data: {
          orgId: "org_1",
          workspaceId: "ws_1",
          fanoutId: "fan_1",
          timeoutMs: 1000,
        },
      },
      step,
    })) as { timedOut: boolean; status: string };

    expect(out.timedOut).toBe(true);
    expect(out.status).toBe("running");
    expect(step.sendEvent).toHaveBeenCalled();
  });

  it("clamps the wait window to the contract maximum (30 min)", async () => {
    const step = makeStep({
      name: "agent/subagent.fanout.completed",
      data: { fanoutId: "fan_1" },
    });
    await handler({
      event: {
        data: {
          orgId: "org_1",
          workspaceId: "ws_1",
          fanoutId: "fan_1",
          timeoutMs: 999_999_999,
        },
      },
      step,
    });
    const opts = step.waitForEvent.mock.calls[0]?.[1] as { timeout: string };
    expect(opts.timeout).toBe(`${30 * 60}s`);
  });
});
