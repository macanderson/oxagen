/**
 * ingestion.connection-poll — the generic per-connection poll.
 *
 * Mocks the DB, the connector registry, the credential resolver, and telemetry;
 * uses the REAL pure sync helpers (@oxagen/ingestion/sync). Asserts the
 * observable contract: which entity.received events get dispatched into the
 * pipeline, that the connection is finalized, and that a completed/failed
 * telemetry event is emitted. Health/backoff math is unit-tested separately in
 * @oxagen/ingestion/sync.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RawRecord } from "@oxagen/ingestion/connectors";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  getConnector: vi.fn(),
  resolveConnectionAuth: vi.fn(),
  insertEvents: vi.fn(),
  createFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {},
}));
vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: mocks.getConnector,
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: mocks.insertEvents }));
vi.mock("../lib/resolve-connection-auth", () => ({
  resolveConnectionAuth: mocks.resolveConnectionAuth,
}));
vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

let capturedHandler:
  | ((ctx: {
      event: { data: Record<string, unknown> };
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

await import("./ingestion.connection-poll");

// Records dispatched via step.sendEvent across the run.
let sentEvents: Array<{ id: string; events: unknown }> = [];

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: async (id: string, events: unknown) => {
      sentEvents.push({ id, events });
    },
  };
}

/** Queue DB execute() results: [conn, mappings, ...finalize]. */
function setupDb(conn: Record<string, unknown> | null, recordTypes: string[]) {
  const execMock = vi
    .fn()
    .mockResolvedValueOnce(conn ? [conn] : [])
    .mockResolvedValueOnce(
      recordTypes.map((source_record_type) => ({ source_record_type })),
    )
    .mockResolvedValue([]);
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: execMock }),
  );
  return execMock;
}

function makeConnector(
  poll: (rt: string, cursor: string | null) => AsyncIterable<RawRecord>,
) {
  return {
    connectorId: "linear",
    defaultPollIntervalSeconds: 900,
    connectionConfigSchema: {
      safeParse: (v: unknown) => ({ success: true, data: v }),
    },
    poll: (_a: unknown, _c: unknown, rt: string, cursor: string | null) =>
      poll(rt, cursor),
    cursorOf: (_rt: string, raw: unknown) =>
      (raw as { updatedAt?: string }).updatedAt ?? null,
  };
}

async function* yieldRecords(
  rt: string,
  stamps: string[],
): AsyncIterable<RawRecord> {
  for (let i = 0; i < stamps.length; i++) {
    yield {
      sourceRecordType: rt,
      externalId: String(i + 1),
      raw: { id: String(i + 1), updatedAt: stamps[i] },
      receivedAt: "2026-07-04T00:00:00Z",
    };
  }
}

const eventData = {
  connectionId: "11111111-1111-1111-1111-111111111111",
  orgId: "22222222-2222-2222-2222-222222222222",
  workspaceId: "33333333-3333-3333-3333-333333333333",
  connectorId: "linear",
};

beforeEach(() => {
  vi.clearAllMocks();
  sentEvents = [];
  mocks.insertEvents.mockResolvedValue(undefined);
  mocks.resolveConnectionAuth.mockResolvedValue({
    auth: { scheme: "bearer_token", token: "t" },
    deliveryConfig: {},
  });
});

describe("ingestion-connection-poll — skip cases", () => {
  it("skips when the connection is not found / not connected", async () => {
    setupDb(null, []);
    mocks.getConnector.mockReturnValue(
      makeConnector((rt) => yieldRecords(rt, [])),
    );
    const result = await capturedHandler!({
      event: { data: eventData },
      step: makeStep(),
    });
    expect(result).toEqual({ skipped: true, reason: "not_connected" });
    expect(sentEvents).toHaveLength(0);
  });
});

describe("ingestion-connection-poll — happy path", () => {
  beforeEach(() => {
    setupDb({ cursor: {}, consecutive_failure_count: 0, status: "connected" }, [
      "issue",
    ]);
    mocks.getConnector.mockReturnValue(
      makeConnector((rt) =>
        yieldRecords(rt, ["2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z"]),
      ),
    );
  });

  it("dispatches one entity.received per polled record into the pipeline", async () => {
    await capturedHandler!({ event: { data: eventData }, step: makeStep() });
    const emitted = sentEvents.filter((e) => e.id.startsWith("emit-"));
    const allEvents = emitted.flatMap(
      (e) => e.events as Array<{ name: string; data: unknown }>,
    );
    expect(allEvents).toHaveLength(2);
    expect(allEvents[0]!.name).toBe("ingestion/entity.received");
    expect(allEvents[0]!.data).toMatchObject({
      connectorType: "linear",
      sourceRecordType: "issue",
      orgId: eventData.orgId,
    });
  });

  it("emits a completed telemetry event and returns ok", async () => {
    const result = await capturedHandler!({
      event: { data: eventData },
      step: makeStep(),
    });
    expect(result).toMatchObject({ ok: true, records: 2, recordTypes: 1 });
    const [rows] = mocks.insertEvents.mock.calls[0] as [
      Array<{ event_type: string }>,
    ];
    expect(rows[0]!.event_type).toBe("connector.poll.completed");
  });

  it("finalizes the connection (writes back to Postgres)", async () => {
    const exec = setupDb(
      { cursor: {}, consecutive_failure_count: 0, status: "connected" },
      ["issue"],
    );
    await capturedHandler!({ event: { data: eventData }, step: makeStep() });
    // load(conn) + load(mappings) + finalize UPDATE = 3 execute calls.
    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("ingestion-connection-poll — failure path", () => {
  it("marks a failed telemetry event when the credential cannot be resolved", async () => {
    setupDb({ cursor: {}, consecutive_failure_count: 0, status: "connected" }, [
      "issue",
    ]);
    mocks.getConnector.mockReturnValue(
      makeConnector((rt) => yieldRecords(rt, [])),
    );
    mocks.resolveConnectionAuth.mockResolvedValue(null);

    const result = await capturedHandler!({
      event: { data: eventData },
      step: makeStep(),
    });
    expect(result).toMatchObject({ ok: false });
    const [rows] = mocks.insertEvents.mock.calls[0] as [
      Array<{ event_type: string; payload: string }>,
    ];
    expect(rows[0]!.event_type).toBe("connector.poll.failed");
    expect(JSON.parse(rows[0]!.payload).error).toBe("no_usable_credential");
    // No records dispatched on a credential failure.
    expect(sentEvents.filter((e) => e.id.startsWith("emit-"))).toHaveLength(0);
  });

  it("dispatches already-fetched records even when a later poll throws", async () => {
    setupDb({ cursor: {}, consecutive_failure_count: 1, status: "connected" }, [
      "issue",
      "project",
    ]);
    mocks.getConnector.mockReturnValue(
      makeConnector((rt) => {
        if (rt === "issue") return yieldRecords(rt, ["2026-05-01T00:00:00Z"]);
        return (async function* () {
          throw new Error("linear.poll: GraphQL API 500");
        })();
      }),
    );
    const result = await capturedHandler!({
      event: { data: eventData },
      step: makeStep(),
    });
    expect(result).toMatchObject({ ok: false });
    // The one issue fetched before the project poll failed is still dispatched.
    const emitted = sentEvents
      .filter((e) => e.id.startsWith("emit-"))
      .flatMap((e) => e.events as unknown[]);
    expect(emitted).toHaveLength(1);
    const [rows] = mocks.insertEvents.mock.calls[0] as [
      Array<{ event_type: string }>,
    ];
    expect(rows[0]!.event_type).toBe("connector.poll.failed");
  });
});
