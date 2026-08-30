import { describe, expect, it, vi, beforeEach } from "vitest";

// The first dynamic import of @oxagen/database cold-compiles a heavy module graph
// (schema barrel + drizzle) which can exceed the 5s default timeout on a cold CI
// cache and flake the first lazy-import test. Raise the per-file timeout to match
// the repo's established lazy-import pattern (packages/database/src/client.test.ts).
vi.setConfig({ testTimeout: 30_000 });

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: (...args: unknown[]) =>
    mocks.getOrCreateRegistry(...args),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: vi.fn(),
  };
});

import { schemaSetupHandler } from "./schema.setup";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const MOCK_RECOMMENDATION = {
  proposal: {
    schemas: [
      {
        name: "Person",
        displayName: "Person",
        labels: [
          {
            name: "Human",
            description: "A human being",
            properties: [
              {
                key: "name",
                dataType: "string",
                required: true,
                description: "Full name",
              },
            ],
          },
        ],
        relationshipTypes: [
          {
            name: "KNOWS",
            startLabel: "Human",
            endLabel: "Human",
            description: "Knows relationship",
          },
        ],
      },
    ],
  },
  rationale: "Recommended schema based on your data",
  sampledCount: 150,
};

const MOCK_REGISTRY = {
  id: "reg_1",
  pinnedVersionId: null,
  draftVersionId: "draft_1",
};

describe("schemaSetupHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateRegistry.mockResolvedValue(MOCK_REGISTRY);

    // By default, first invoke call = schema.recommend
    // Subsequent invoke calls = schema.label.upsert / schema.relationship.upsert / schema.toggle / schema.registry.config
    mocks.invoke.mockImplementation(async (capability: string) => {
      if (capability === "recommend_schema") {
        return MOCK_RECOMMENDATION;
      }
      // All other invocations return a simple success shape
      return { success: true };
    });
  });

  // ── interactive mode (noInteractive=false or undefined) ───────────────────

  it("returns counts from recommendation in interactive mode (default)", async () => {
    const result = await schemaSetupHandler({}, CTX);

    // Should return proposal counts without applying anything
    expect(result.schemasCreated).toBe(1);
    expect(result.labelsCreated).toBe(1);
    expect(result.relationshipTypesCreated).toBe(1);
    // In interactive mode, should NOT invoke schema.label.upsert etc.
    const invokeCalls = mocks.invoke.mock.calls.map((c) => c[0]);
    expect(invokeCalls).not.toContain("upsert_schema_label");
    expect(invokeCalls).not.toContain("upsert_schema_relationship");
    expect(invokeCalls).not.toContain("toggle_schema");
  });

  it("returns pinnedVersionId=null in interactive mode when registry has none", async () => {
    const result = await schemaSetupHandler({ noInteractive: false }, CTX);
    expect(result.pinnedVersionId).toBeNull();
  });

  it("resolves pinnedVersionId in interactive mode when registry has a pinned version", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_id",
      draftVersionId: "draft_1",
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ publicId: "scv_pinned_pub" }]),
            }),
          }),
        }),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    const result = await schemaSetupHandler({ noInteractive: false }, CTX);
    expect(result.pinnedVersionId).toBe("scv_pinned_pub");
  });

  it("uses sampleLimit from input in schema.recommend call", async () => {
    await schemaSetupHandler({ sampleLimit: 500 }, CTX);

    const recommendCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "recommend_schema",
    );
    expect(recommendCall).toBeDefined();
    expect(recommendCall![1]).toMatchObject({ sampleLimit: 500 });
  });

  it("defaults sampleLimit to 200 when not provided", async () => {
    await schemaSetupHandler({}, CTX);

    const recommendCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "recommend_schema",
    );
    expect(recommendCall![1]).toMatchObject({ sampleLimit: 200 });
  });

  // ── non-interactive mode (noInteractive=true) ────────────────────────────

  it("applies recommendation in non-interactive mode", async () => {
    // Need a second getOrCreateRegistry call for updatedRegistry
    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY) // initial
      .mockResolvedValueOnce(MOCK_REGISTRY); // after apply (updatedRegistry)

    const result = await schemaSetupHandler({ noInteractive: true }, CTX);

    const invokeCalls = mocks.invoke.mock.calls.map((c) => c[0] as string);
    expect(invokeCalls).toContain("recommend_schema");
    expect(invokeCalls).toContain("upsert_schema_label");
    expect(invokeCalls).toContain("upsert_schema_relationship");
    expect(invokeCalls).toContain("toggle_schema");
    expect(result.schemasCreated).toBe(1);
    expect(result.labelsCreated).toBe(1);
    expect(result.relationshipTypesCreated).toBe(1);
  });

  it("invokes schema.label.upsert with correct args per label", async () => {
    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    await schemaSetupHandler({ noInteractive: true }, CTX);

    const labelUpsertCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "upsert_schema_label",
    );
    expect(labelUpsertCall).toBeDefined();
    expect(labelUpsertCall![1]).toMatchObject({
      schemaName: "Person",
      name: "Human",
      displayName: "Human",
      description: "A human being",
    });
  });

  it("invokes schema.relationship.upsert with correct args per rel", async () => {
    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    await schemaSetupHandler({ noInteractive: true }, CTX);

    const relUpsertCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "upsert_schema_relationship",
    );
    expect(relUpsertCall).toBeDefined();
    expect(relUpsertCall![1]).toMatchObject({
      schemaName: "Person",
      name: "KNOWS",
      startLabel: "Human",
      endLabel: "Human",
    });
  });

  it("invokes schema.toggle with enabled=true per schema", async () => {
    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    await schemaSetupHandler({ noInteractive: true }, CTX);

    const toggleCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "toggle_schema",
    );
    expect(toggleCall).toBeDefined();
    expect(toggleCall![1]).toMatchObject({
      schemaName: "Person",
      enabled: true,
    });
  });

  it("invokes schema.registry.config when enforcement is provided", async () => {
    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    await schemaSetupHandler(
      { noInteractive: true, enforcement: "strict" },
      CTX,
    );

    const configCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "get_registry_config",
    );
    expect(configCall).toBeDefined();
    expect(configCall![1]).toMatchObject({ enforcementMode: "strict" });
  });

  it("does NOT invoke schema.registry.config when enforcement is not provided", async () => {
    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    await schemaSetupHandler({ noInteractive: true }, CTX);

    const configCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "get_registry_config",
    );
    expect(configCall).toBeUndefined();
  });

  it("handles empty proposal (0 schemas) in non-interactive mode", async () => {
    mocks.invoke.mockImplementation(async (capability: string) => {
      if (capability === "recommend_schema") {
        return {
          proposal: { schemas: [] },
          rationale: "No data found",
          sampledCount: 0,
        };
      }
      return { success: true };
    });

    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    const result = await schemaSetupHandler({ noInteractive: true }, CTX);
    expect(result.schemasCreated).toBe(0);
    expect(result.labelsCreated).toBe(0);
    expect(result.relationshipTypesCreated).toBe(0);
  });

  it("handles multiple schemas in proposal in non-interactive mode", async () => {
    mocks.invoke.mockImplementation(async (capability: string) => {
      if (capability === "recommend_schema") {
        return {
          proposal: {
            schemas: [
              {
                name: "Person",
                displayName: "Person",
                labels: [
                  { name: "Human", description: null, properties: [] },
                  { name: "Bot", description: null, properties: [] },
                ],
                relationshipTypes: [
                  { name: "KNOWS", startLabel: "Human", endLabel: "Human" },
                ],
              },
              {
                name: "Organization",
                displayName: "Organization",
                labels: [
                  { name: "Company", description: null, properties: [] },
                ],
                relationshipTypes: [],
              },
            ],
          },
          rationale: "Two schemas detected",
          sampledCount: 300,
        };
      }
      return { success: true };
    });

    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    const result = await schemaSetupHandler({ noInteractive: true }, CTX);
    expect(result.schemasCreated).toBe(2);
    expect(result.labelsCreated).toBe(3);
    expect(result.relationshipTypesCreated).toBe(1);
  });

  it("resolves updatedRegistry pinnedVersionId after apply in non-interactive mode", async () => {
    const updatedRegistry = {
      id: "reg_1",
      pinnedVersionId: "pinned_internal_after",
      draftVersionId: "draft_2",
    };

    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY) // initial
      .mockResolvedValueOnce(updatedRegistry); // after apply

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ publicId: "scv_new_pin" }]),
            }),
          }),
        }),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    const result = await schemaSetupHandler({ noInteractive: true }, CTX);
    expect(result.pinnedVersionId).toBe("scv_new_pin");
  });

  // ── toSurface helper ─────────────────────────────────────────────────────

  it("passes mcp surface through to invoke when ctx.surface is mcp", async () => {
    const mcpCtx = { ...CTX, surface: "mcp" as const };

    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    await schemaSetupHandler({ noInteractive: true }, mcpCtx);

    const recommendCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "recommend_schema",
    );
    expect(recommendCall![3]).toMatchObject({ surface: "mcp" });
  });

  it("falls back to api surface for unknown surface value", async () => {
    const unknownCtx = {
      ...CTX,
      surface: "unknown_surface" as unknown as typeof CTX.surface,
    };

    mocks.getOrCreateRegistry
      .mockResolvedValueOnce(MOCK_REGISTRY)
      .mockResolvedValueOnce(MOCK_REGISTRY);

    await schemaSetupHandler({ noInteractive: true }, unknownCtx);

    const recommendCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "recommend_schema",
    );
    expect(recommendCall![3]).toMatchObject({ surface: "api" });
  });
});
