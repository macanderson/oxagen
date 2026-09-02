/**
 * Unit tests for integration.sync handler.
 *
 * Verifies:
 * - Reads source connection and throws if not found
 * - Queues Inngest job with correct sync method from deliveryConfig
 * - Defaults syncMethod to "manual" when absent from deliveryConfig
 * - Returns jobId + queued status
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  inngestSend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./event-client", () => ({
  eventClient: { send: mocks.inngestSend },
}));

import { integrationSyncHandler } from "./integration.sync";

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

function makeConnRow(deliveryConfig: Record<string, unknown> | null = null) {
  return {
    id: "uuid-conn-sync-1",
    deliveryMethod: "webhook",
    deliveryConfig,
    status: "active",
  };
}

type TxLike = { select: ReturnType<typeof vi.fn> };

function setupDbReturning(row: ReturnType<typeof makeConnRow> | null) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: TxLike) => Promise<unknown>) => {
      const tx: TxLike = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(row ? [row] : []),
            }),
          }),
        }),
      };
      return fn(tx);
    },
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("integrationSyncHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTenantDb.mockReset();
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("throws when integration is not found", async () => {
    setupDbReturning(null);
    await expect(
      integrationSyncHandler(
        { integrationId: "intg_missing", mode: "incremental" },
        CTX,
      ),
    ).rejects.toThrow("integration.sync: integration not found: intg_missing");
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("queues an Inngest job and returns queued status", async () => {
    setupDbReturning(
      makeConnRow({ syncMethod: "polling", syncIntervalSeconds: 600 }),
    );
    const result = await integrationSyncHandler(
      { integrationId: "intg_abc", mode: "incremental" },
      CTX,
    );

    expect(result.status).toBe("queued");
    expect(result.integrationId).toBe("intg_abc");
    expect(result.mode).toBe("incremental");
    expect(typeof result.jobId).toBe("string");
    expect(result.jobId.length).toBeGreaterThan(0);
  });

  it("sends Inngest event with correct syncMethod from deliveryConfig", async () => {
    setupDbReturning(
      makeConnRow({ syncMethod: "polling", syncIntervalSeconds: 600 }),
    );
    await integrationSyncHandler(
      { integrationId: "intg_abc", mode: "incremental" },
      CTX,
    );

    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    const data = sentEvent["data"] as Record<string, unknown>;
    expect(data["syncMethod"]).toBe("polling");
    expect(data["syncIntervalSeconds"]).toBe(600);
    expect(data["orgId"]).toBe("org-1");
    expect(data["workspaceId"]).toBe("ws-1");
    expect(data["mode"]).toBe("incremental");
  });

  it("falls back to deliveryMethod when deliveryConfig.syncMethod is absent", async () => {
    // deliveryConfig is null → falls back to row.deliveryMethod ("webhook")
    setupDbReturning(makeConnRow(null));
    await integrationSyncHandler(
      { integrationId: "intg_abc", mode: "full" },
      CTX,
    );

    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    const data = sentEvent["data"] as Record<string, unknown>;
    // row.deliveryMethod = "webhook" (the makeConnRow default)
    expect(data["syncMethod"]).toBe("webhook");
  });

  it("defaults syncMethod to manual when both deliveryConfig and deliveryMethod are absent", async () => {
    // Set deliveryMethod to null to exercise the final fallback
    const row = { ...makeConnRow(null), deliveryMethod: null };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => {
        const tx: TxLike = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([row]),
              }),
            }),
          }),
        };
        return fn(tx);
      },
    );

    await integrationSyncHandler(
      { integrationId: "intg_abc", mode: "full" },
      CTX,
    );

    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    const data = sentEvent["data"] as Record<string, unknown>;
    expect(data["syncMethod"]).toBe("manual");
  });

  it("defaults syncIntervalSeconds to 300 when not specified", async () => {
    setupDbReturning(makeConnRow({ syncMethod: "polling" }));
    await integrationSyncHandler(
      { integrationId: "intg_abc", mode: "incremental" },
      CTX,
    );

    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    const data = sentEvent["data"] as Record<string, unknown>;
    expect(data["syncIntervalSeconds"]).toBe(300);
  });

  it("passes webhook syncMethod from deliveryConfig", async () => {
    setupDbReturning(makeConnRow({ syncMethod: "webhook" }));
    await integrationSyncHandler(
      { integrationId: "intg_abc", mode: "incremental" },
      CTX,
    );

    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    const data = sentEvent["data"] as Record<string, unknown>;
    expect(data["syncMethod"]).toBe("webhook");
  });
});
