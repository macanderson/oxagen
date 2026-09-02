import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  updateReturning: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: mocks.getOrCreateRegistry,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: mocks.updateReturning,
            })),
          })),
        })),
      };
      return fn(tx);
    },
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaRegistryConfigHandler } from "./schema.registry.config";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_REGISTRY = {
  id: "reg-internal-id",
  publicId: "scr_abc",
  pinnedVersionId: null,
  draftVersionId: null,
  enforcementMode: "lenient",
  conformanceFloor: "0.50",
};

describe("schemaRegistryConfigHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);
  });

  // ── happy paths ───────────────────────────────────────────────────────────

  it("updates enforcementMode and returns updated config", async () => {
    mocks.updateReturning.mockResolvedValue([
      {
        publicId: "scr_abc",
        enforcementMode: "strict",
        conformanceFloor: "0.50",
      },
    ]);

    const result = await schemaRegistryConfigHandler(
      { enforcementMode: "strict" },
      CTX,
    );

    expect(result.registryId).toBe("scr_abc");
    expect(result.enforcementMode).toBe("strict");
    expect(result.conformanceFloor).toBe(0.5);
  });

  it("updates conformanceFloor and parses it as float", async () => {
    mocks.updateReturning.mockResolvedValue([
      {
        publicId: "scr_abc",
        enforcementMode: "lenient",
        conformanceFloor: "0.75",
      },
    ]);

    const result = await schemaRegistryConfigHandler(
      { conformanceFloor: 0.75 },
      CTX,
    );

    expect(result.conformanceFloor).toBe(0.75);
    expect(result.enforcementMode).toBe("lenient");
  });

  it("updates both enforcementMode and conformanceFloor together", async () => {
    mocks.updateReturning.mockResolvedValue([
      { publicId: "scr_abc", enforcementMode: "off", conformanceFloor: "0.00" },
    ]);

    const result = await schemaRegistryConfigHandler(
      { enforcementMode: "off", conformanceFloor: 0 },
      CTX,
    );

    expect(result.enforcementMode).toBe("off");
    expect(result.conformanceFloor).toBe(0);
  });

  it("calls getOrCreateRegistry with ctx.orgId, workspaceId, userId", async () => {
    mocks.updateReturning.mockResolvedValue([
      {
        publicId: "scr_abc",
        enforcementMode: "lenient",
        conformanceFloor: "0.50",
      },
    ]);

    await schemaRegistryConfigHandler({ enforcementMode: "lenient" }, CTX);

    expect(mocks.getOrCreateRegistry).toHaveBeenCalledWith(
      CTX.orgId,
      CTX.workspaceId,
      CTX.userId,
    );
  });

  // ── error path ────────────────────────────────────────────────────────────

  it("throws when update returns no row", async () => {
    mocks.updateReturning.mockResolvedValue([]);

    await expect(
      schemaRegistryConfigHandler({ enforcementMode: "strict" }, CTX),
    ).rejects.toThrow("Failed to update registry config");
  });

  it("throws when update returns undefined", async () => {
    mocks.updateReturning.mockResolvedValue(undefined);

    await expect(
      schemaRegistryConfigHandler({ enforcementMode: "strict" }, CTX),
    ).rejects.toThrow();
  });

  // ── partial update — undefined fields omitted ─────────────────────────────

  it("accepts empty input object without throwing", async () => {
    mocks.updateReturning.mockResolvedValue([
      {
        publicId: "scr_abc",
        enforcementMode: "lenient",
        conformanceFloor: "0.50",
      },
    ]);

    // No fields changed — just updatedByUserId touches the row.
    const result = await schemaRegistryConfigHandler({}, CTX);
    expect(result.registryId).toBe("scr_abc");
  });
});
