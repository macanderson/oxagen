// mcp-server.sync.test.ts: the hourly discovery sweep (lane M10, #4682). The
// runner and the step are doubles, so each case checks what the function
// sends.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  sweep: vi.fn(),
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("../lib/mcp-server-discovery-runner", () => ({
  mcpServerDiscoveryRunner: () => ({ run: vi.fn(), sweep: mocks.sweep }),
}));

type Step = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: (label: string, event: unknown) => Promise<void>;
};
type Handler = (ctx: { step: Step }) => Promise<unknown>;

let handler: Handler | null = null;
let options: Record<string, unknown> | null = null;
let trigger: unknown = null;

mocks.createFunction.mockImplementation(
  (opts: Record<string, unknown>, on: unknown, fn: Handler) => {
    options = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

await import("./mcp-server.sync");

const sendEvent = vi.fn(async (_label: string, _event: unknown) => {});
const stepNames: string[] = [];
const step: Step = {
  run: async (name, fn) => {
    stepNames.push(name);
    return fn();
  },
  sendEvent,
};

const REQUEST = {
  name: "mcp-server/discover.requested" as const,
  data: {
    orgId: "org_1",
    workspaceId: "ws_1",
    server: "stripe",
    trigger: "schedule",
    key: "org_1:ws_1:stripe",
  },
  id: "mcp-discovery:schedule:org_1:ws_1:stripe:2026-09-28T15",
};

beforeEach(() => {
  stepNames.length = 0;
});

describe("mcpServerSync", () => {
  it("runs hourly, one sweep at a time", () => {
    expect(options).toMatchObject({
      id: "mcp-server/sync",
      concurrency: { limit: 1 },
    });
    expect(trigger).toEqual({ cron: "0 * * * *" });
  });

  it("sends every request the sweep plans, in one step", async () => {
    mocks.sweep.mockResolvedValueOnce([REQUEST]);

    await expect(handler!({ step })).resolves.toEqual({ requested: 1 });

    expect(stepNames).toEqual(["plan-discoveries"]);
    expect(mocks.sweep).toHaveBeenCalledWith(expect.any(Date));
    expect(sendEvent).toHaveBeenCalledWith("request-discoveries", [REQUEST]);
  });

  it("sends nothing when the sweep plans nothing", async () => {
    mocks.sweep.mockResolvedValueOnce([]);

    await expect(handler!({ step })).resolves.toEqual({ requested: 0 });

    expect(sendEvent).not.toHaveBeenCalled();
  });
});
