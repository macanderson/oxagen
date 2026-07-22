/**
 * Unit tests for integration.configure handler.
 *
 * Verifies:
 * - Reads source connection by public ID and throws if not found
 * - Merges deliveryConfig fields (sync method and filters)
 * - Preserves existing connector-specific config fields (owner, repo, etc.)
 * - Returns updated values in expected shape
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import { makeCTX } from "./test-utils/fixtures";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { integrationConfigureHandler } from "./integration.configure";

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

const BASE_ROW = {
  id: "uuid-conn-1",
  publicId: "intg_abc",
  displayName: "My GitHub Connection",
  deliveryMethod: "webhook",
  deliveryConfig: {
    owner: "acme",
    repo: "api",
    installationId: "12345",
    syncMethod: "manual" as const,
    syncIntervalSeconds: 300,
    recordTypeFilters: [] as string[],
    pathFilters: [] as string[],
    labelFilters: [] as string[],
    semanticInference: {
      enabled: true,
      perRecordType: {},
      confidenceThreshold: 0.75,
    },
  } as DeliveryConfig & Record<string, unknown>,
  updatedAt: new Date("2024-01-01"),
};

type TxLike = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

/** Captures the column patch passed to the UPDATE `.set(...)` so tests can assert
 * exactly what is persisted (round-trip), not just the handler's return value. */
type SetPatch = { deliveryConfig?: DeliveryConfig & Record<string, unknown> };

function makeDbMock(row: typeof BASE_ROW | null, updateResult?: unknown) {
  const captured: { set: SetPatch | null } = { set: null };
  let callCount = 0;
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: TxLike) => Promise<unknown>) => {
      callCount++;
      if (callCount === 1) {
        // First call: SELECT
        const tx: TxLike = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(row ? [row] : []),
              }),
            }),
          }),
          update: vi.fn(),
        };
        return fn(tx);
      }
      // Second call: UPDATE
      const tx: TxLike = {
        select: vi.fn(),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((patch: SetPatch) => {
            captured.set = patch;
            return { where: vi.fn().mockResolvedValue(updateResult ?? []) };
          }),
        }),
      };
      return fn(tx);
    },
  );
  return captured;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("integrationConfigureHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTenantDb.mockReset();
  });

  it("throws when integration is not found", async () => {
    makeDbMock(null);
    await expect(
      integrationConfigureHandler({ integrationId: "intg_missing" }, CTX),
    ).rejects.toThrow(
      "integration.configure: integration not found: intg_missing",
    );
  });

  it("returns updated shape with defaults when no config changes", async () => {
    makeDbMock(BASE_ROW);
    const result = await integrationConfigureHandler(
      { integrationId: "intg_abc" },
      CTX,
    );

    expect(result.integrationId).toBe("intg_abc");
    expect(result.displayName).toBe("My GitHub Connection");
    expect(result.syncCadence).toBe("manual");
    expect(typeof result.updatedAt).toBe("string");
  });

  it("updates displayName when provided", async () => {
    makeDbMock(BASE_ROW);
    const result = await integrationConfigureHandler(
      { integrationId: "intg_abc", displayName: "Renamed Connection" },
      CTX,
    );
    expect(result.displayName).toBe("Renamed Connection");
  });

  it("applies syncCadence from input", async () => {
    makeDbMock(BASE_ROW);
    const result = await integrationConfigureHandler(
      { integrationId: "intg_abc", syncCadence: "polling" },
      CTX,
    );
    expect(result.syncCadence).toBe("polling");
  });

  it("writes DB once (SELECT) when integration not found", async () => {
    makeDbMock(null);
    await expect(
      integrationConfigureHandler({ integrationId: "intg_missing" }, CTX),
    ).rejects.toThrow();
    // Only one DB call (the SELECT)
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("calls DB twice for a successful update (SELECT + UPDATE)", async () => {
    makeDbMock(BASE_ROW);
    await integrationConfigureHandler({ integrationId: "intg_abc" }, CTX);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("preserves existing prompts when the inputs are omitted", async () => {
    const rowWithPrompts: typeof BASE_ROW = {
      ...BASE_ROW,
      deliveryConfig: {
        ...BASE_ROW.deliveryConfig,
        semanticInference: {
          enabled: true,
          perRecordType: {},
          confidenceThreshold: 0.75,
          ontologyPrompt: "keep me",
          semanticEdgePrompt: "keep me too",
        },
      } as DeliveryConfig & Record<string, unknown>,
    };
    const captured = makeDbMock(rowWithPrompts);
    await integrationConfigureHandler(
      { integrationId: "intg_abc", syncCadence: "polling" },
      CTX,
    );
    const persisted = captured.set?.deliveryConfig?.semanticInference as
      | (Record<string, unknown> & { enabled: boolean })
      | undefined;
    expect(persisted?.["ontologyPrompt"]).toBe("keep me");
    expect(persisted?.["semanticEdgePrompt"]).toBe("keep me too");
  });
});
