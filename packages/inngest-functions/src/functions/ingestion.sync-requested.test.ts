/**
 * ingestion.sync-requested Inngest function tests.
 *
 * Strategy: mock withSystemDb, inngest.send, and global fetch. Assert:
 *   - skips when connection is not found
 *   - skips when connection is being deleted
 *   - dispatches ingestion/github.initial-sync for GitHub connections
 *   - skips connector dispatch when owner/repo missing from deliveryConfig
 *   - logs "unsupported" for non-GitHub connectors (no throw)
 *   - stamps last_sync_at in all non-skip paths
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  inngestSend: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {},
}));

vi.mock("../inngest", () => ({
  inngest: {
    createFunction: mocks.inngestCreateFunction,
    send: mocks.inngestSend,
  },
}));

vi.mock("../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

// ── Capture the Inngest handler ───────────────────────────────────────────────
let capturedHandler:
  | ((ctx: {
      event: { data: Record<string, unknown> };
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
  },
);

await import("./ingestion.sync-requested");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: {
      jobId: "job_test-1",
      connectionId: "conn-uuid-1",
      orgId: "org-uuid-1",
      workspaceId: "ws-uuid-1",
      integrationId: "int_pub_1",
      mode: "full",
      syncMethod: "manual",
      syncIntervalSeconds: 300,
      requestedAt: "2026-06-10T00:00:00.000Z",
      ...overrides,
    },
  };
}

function makeConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "conn-uuid-1",
    connector_id: "github",
    delivery_method: "webhook",
    delivery_config: {
      owner: "oxagen",
      repo: "platform",
      defaultBranch: "main",
    },
    status: "active",
    ...overrides,
  };
}

// ── Helper: set up withSystemDb to return the given connection row first,
//    then succeed (empty result) for subsequent calls (e.g. last_sync_at update)
function setupDb(row: Record<string, unknown> | null) {
  let callCount = 0;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      const rows = callCount === 1 && row !== null ? [row] : [];
      return fn({ execute: vi.fn().mockResolvedValue(rows) });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inngestSend.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ingestionSyncRequested — skip cases", () => {
  it("returns skipped=true when connection is not found", async () => {
    setupDb(null);

    const result = await capturedHandler!({
      event: makeEvent(),
      step: makeStep(),
    });

    expect(result).toEqual({ skipped: true, reason: "connection_not_found" });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-uuid-1" }),
      expect.stringContaining("not found"),
    );
  });

  it("returns skipped=true when connection status is 'deleting'", async () => {
    setupDb(makeConnection({ status: "deleting" }));

    const result = await capturedHandler!({
      event: makeEvent(),
      step: makeStep(),
    });

    expect(result).toEqual({ skipped: true, reason: "connection_deleted" });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("returns skipped=true when connection status is 'deleted'", async () => {
    setupDb(makeConnection({ status: "deleted" }));

    const result = await capturedHandler!({
      event: makeEvent(),
      step: makeStep(),
    });

    expect(result).toEqual({ skipped: true, reason: "connection_deleted" });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

describe("ingestionSyncRequested — GitHub connector", () => {
  it("dispatches ingestion/github.initial-sync with correct payload", async () => {
    setupDb(makeConnection());

    await capturedHandler!({ event: makeEvent(), step: makeStep() });

    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ingestion/github.initial-sync",
        data: expect.objectContaining({
          connectionId: "conn-uuid-1",
          orgId: "org-uuid-1",
          workspaceId: "ws-uuid-1",
          owner: "oxagen",
          repo: "platform",
          defaultBranch: "main",
        }),
      }),
    );
  });

  it("uses 'main' as defaultBranch when deliveryConfig omits it", async () => {
    setupDb(
      makeConnection({ delivery_config: { owner: "acme", repo: "api" } }),
    );

    await capturedHandler!({ event: makeEvent(), step: makeStep() });

    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ defaultBranch: "main" }),
      }),
    );
  });

  it("stamps last_sync_at and returns connection info", async () => {
    setupDb(makeConnection());

    const result = await capturedHandler!({
      event: makeEvent(),
      step: makeStep(),
    });

    expect(result).toMatchObject({
      connectionId: "conn-uuid-1",
      connectorId: "github",
      mode: "full",
      syncMethod: "manual",
      jobId: "job_test-1",
    });
    // withSystemDb is called twice: resolve + update last_sync_at
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("skips connector dispatch but still stamps last_sync_at when owner is missing", async () => {
    setupDb(makeConnection({ delivery_config: { repo: "platform" } }));

    const result = await capturedHandler!({
      event: makeEvent(),
      step: makeStep(),
    });

    // Not skipped overall; just skips the send
    expect(result).toMatchObject({
      connectionId: "conn-uuid-1",
      connectorId: "github",
    });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-uuid-1" }),
      expect.stringContaining("missing owner/repo"),
    );
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });
});

describe("ingestionSyncRequested — non-GitHub connector", () => {
  it("logs 'does not support sync dispatch yet' without throwing", async () => {
    setupDb(makeConnection({ connector_id: "linear" }));

    const result = await capturedHandler!({
      event: makeEvent(),
      step: makeStep(),
    });

    expect(mocks.inngestSend).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: "linear" }),
      expect.stringContaining("does not support sync dispatch yet"),
    );
    expect(result).toMatchObject({ connectorId: "linear" });
  });

  it("still stamps last_sync_at for non-GitHub connectors", async () => {
    setupDb(makeConnection({ connector_id: "slack" }));

    await capturedHandler!({ event: makeEvent(), step: makeStep() });

    // Resolve + last_sync_at update
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });
});
