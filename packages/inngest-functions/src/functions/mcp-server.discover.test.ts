// mcp-server.discover.test.ts: one MCP server's discovery (lane M10, #4682).
// The runner and the step are doubles, so each case checks how the function
// reads the event and which errors it lets Inngest retry.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetriableError } from "@oxagen/functions";

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("../lib/mcp-server-discovery-runner", () => ({
  mcpServerDiscoveryRunner: () => ({ run: mocks.run, sweep: vi.fn() }),
}));

type Step = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};
type Handler = (ctx: { event: { data: unknown }; step: Step }) => Promise<unknown>;

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

const { discoveryData } = await import("./mcp-server.discover");

const stepNames: string[] = [];
const step: Step = {
  run: async (name, fn) => {
    stepNames.push(name);
    return fn();
  },
};

const DATA = {
  orgId: "org_1",
  workspaceId: "ws_1",
  server: "stripe",
  trigger: "list_changed",
  key: "org_1:ws_1:stripe",
};

const RESULT = {
  server: "stripe",
  status: "succeeded",
  outcome: "unchanged",
  toolCount: 3,
  withheld: [],
  pr: null,
  error: null,
};

beforeEach(() => {
  stepNames.length = 0;
});

describe("discoveryData", () => {
  it("reads every field and keeps requestedBy when the event has one", () => {
    expect(discoveryData({ ...DATA, requestedBy: "user_1" })).toEqual({
      ...DATA,
      requestedBy: "user_1",
    });
    expect(discoveryData(DATA)).toEqual(DATA);
  });

  it("drops an empty requestedBy", () => {
    expect(discoveryData({ ...DATA, requestedBy: "" })).toEqual(DATA);
  });

  it.each(["orgId", "workspaceId", "server", "trigger", "key"])(
    "returns null without %s",
    (field) => {
      expect(discoveryData({ ...DATA, [field]: undefined })).toBeNull();
    },
  );

  it("returns null for data that is not an object", () => {
    expect(discoveryData(null)).toBeNull();
    expect(discoveryData("stripe")).toBeNull();
  });
});

describe("mcpServerDiscover", () => {
  it("runs one discovery at a time per server, on the request event", () => {
    expect(options).toMatchObject({
      id: "mcp-server/discover",
      concurrency: { limit: 1, key: "event.data.key" },
    });
    expect(trigger).toEqual({ event: "mcp-server/discover.requested" });
  });

  it("runs the discovery in one step and returns its result", async () => {
    mocks.run.mockResolvedValueOnce(RESULT);

    await expect(handler!({ event: { data: DATA }, step })).resolves.toEqual(
      RESULT,
    );

    expect(stepNames).toEqual(["discover"]);
    expect(mocks.run).toHaveBeenCalledWith(DATA);
  });

  it("refuses an event with a missing field without a retry", async () => {
    await expect(
      handler!({ event: { data: { ...DATA, key: undefined } }, step }),
    ).rejects.toBeInstanceOf(NonRetriableError);

    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("turns a refusal the runner marked non-retriable into NonRetriableError", async () => {
    const refusal = Object.assign(new Error("unknown trigger"), {
      isNonRetriable: true,
    });
    mocks.run.mockRejectedValueOnce(refusal);

    const error = await handler!({ event: { data: DATA }, step }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(NonRetriableError);
    expect((error as Error).message).toBe("unknown trigger");
    expect((error as Error).cause).toBe(refusal);
  });

  it("keeps a non-retriable refusal's text when it is not an Error", async () => {
    mocks.run.mockRejectedValueOnce({ isNonRetriable: true });

    await expect(
      handler!({ event: { data: DATA }, step }),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("lets any other failure through so Inngest retries it", async () => {
    const failure = new Error("gateway timed out");
    mocks.run.mockRejectedValueOnce(failure);

    await expect(handler!({ event: { data: DATA }, step })).rejects.toBe(
      failure,
    );
  });
});
