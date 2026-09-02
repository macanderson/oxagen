/**
 * ingestion.poll-scheduler — the cron that claims due connections and fans out
 * one ingestion/connection.poll per connection. Mocks the DB + connector
 * registry and asserts only pollable connectors are enqueued and the fan-out
 * shape is correct.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  listConnectors: vi.fn(),
  createFunction: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {},
}));
vi.mock("@oxagen/ingestion/connectors", () => ({
  listConnectors: mocks.listConnectors,
}));
vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

let capturedHandler:
  | ((ctx: {
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
        sendEvent: (id: string, events: unknown) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./ingestion.poll-scheduler");

let sentEvents: Array<{ id: string; events: unknown }> = [];

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: async (id: string, events: unknown) => {
      sentEvents.push({ id, events });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sentEvents = [];
});

describe("ingestion-poll-scheduler", () => {
  it("no-ops when no registered connector supports polling", async () => {
    mocks.listConnectors.mockReturnValue([
      { connectorId: "webhook-only" /* no poll */ },
    ]);
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ enqueued: 0, pollable: 0 });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("claims due connections and fans out one connection.poll per connection", async () => {
    mocks.listConnectors.mockReturnValue([
      { connectorId: "linear", poll: async function* () {} },
      { connectorId: "webhook-only" },
      { connectorId: "github", poll: async function* () {} },
    ]);
    const dueRows = [
      { id: "c1", org_id: "o1", workspace_id: "w1", connector_id: "linear" },
      { id: "c2", org_id: "o2", workspace_id: "w2", connector_id: "github" },
    ];
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: vi.fn().mockResolvedValue(dueRows) }),
    );

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ enqueued: 2, pollable: 2 });

    const dispatch = sentEvents.find(
      (e) => e.id === "dispatch-connection-polls",
    );
    expect(dispatch).toBeDefined();
    const events = dispatch!.events as Array<{
      name: string;
      data: Record<string, unknown>;
    }>;
    expect(events).toHaveLength(2);
    expect(events[0]!.name).toBe("ingestion/connection.poll");
    expect(events[0]!.data).toEqual({
      connectionId: "c1",
      orgId: "o1",
      workspaceId: "w1",
      connectorId: "linear",
    });
  });

  it("enqueues nothing when no connection is due", async () => {
    mocks.listConnectors.mockReturnValue([
      { connectorId: "linear", poll: async function* () {} },
    ]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: vi.fn().mockResolvedValue([]) }),
    );
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ enqueued: 0, pollable: 1 });
    expect(sentEvents).toHaveLength(0);
  });
});
