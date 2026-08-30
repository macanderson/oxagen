import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  withTenantDbFn: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: mocks.getOrCreateRegistry,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDbFn,
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaRegistryGetHandler } from "./schema.registry.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_REGISTRY = {
  id: "reg-internal-id",
  publicId: "scr_abc",
  pinnedVersionId: null as string | null,
  draftVersionId: null as string | null,
  enforcementMode: "lenient",
  conformanceFloor: "0.50",
};

/**
 * Build an ordered-select tx. Each call to select() returns the next result in
 * the array. The chain is thenable so `await chain` works when .limit() is
 * absent, and .limit() / .where() are also terminal-Promise-returning.
 */
function buildSelectTx(results: unknown[][]): Record<string, unknown> {
  let idx = 0;
  const tx = {
    select: vi.fn(() => {
      const result = results[idx++] ?? [];
      const chain: Record<string, unknown> & PromiseLike<unknown> = {
        then: <T1 = unknown, T2 = never>(
          onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
          onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ): PromiseLike<T1 | T2> =>
          Promise.resolve(result).then(onfulfilled, onrejected),
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(result)),
        offset: vi.fn(() => Promise.resolve(result)),
      };
      return chain;
    }),
  };
  return tx;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("schemaRegistryGetHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── no versionId path ─────────────────────────────────────────────────────

  it("returns empty schemas when registry has no versionId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);
    // withTenantDb called once for the schema query, then once each for
    // resolvePublicId (pinnedVersionId=null and draftVersionId=null → skipped)
    mocks.withTenantDbFn.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(buildSelectTx([[]])),
    );

    const result = await schemaRegistryGetHandler({}, CTX);

    expect(result.schemas).toHaveLength(0);
    expect(result.registryId).toBe("scr_abc");
    expect(result.pinnedVersionId).toBeNull();
    expect(result.draftVersionId).toBeNull();
    expect(result.enforcementMode).toBe("lenient");
    expect(result.conformanceFloor).toBe(0.5);
  });

  // ── explicit versionId input resolves by publicId ─────────────────────────

  it("resolves version by publicId when input.versionId is provided", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);

    const schemaRow = {
      id: "schema-id-1",
      name: "core",
      displayName: "Core",
      source: "user",
      connectorId: null,
    };

    // First withTenantDb call: schema query tx
    // select() calls: resolveVersion(1), schemaRows(2), activations(3), labels(4), rels(5)
    mocks.withTenantDbFn.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(
          buildSelectTx([
            [{ id: "ver-internal-id" }], // resolve version row by publicId
            [schemaRow], // schemas
            [], // activations (none → enabled default)
            [], // labels
            [], // rels
          ]),
        ),
    );

    const result = await schemaRegistryGetHandler(
      { versionId: "scv_xyz" },
      CTX,
    );

    expect(result.schemas).toHaveLength(1);
    const [schema] = result.schemas;
    expect(schema!.schemaName).toBe("core");
    expect(schema!.source).toBe("user");
    expect(schema!.enabled).toBe(true); // missing activation → true
    expect(schema!.labels).toHaveLength(0);
    expect(schema!.relationshipTypes).toHaveLength(0);
  });

  // ── enabled/disabled activation map ──────────────────────────────────────

  it("marks schema as disabled when activation row says enabled=false", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);

    const schemaRow = {
      id: "s1",
      name: "experimental",
      displayName: "Exp",
      source: "user",
      connectorId: null,
    };
    const activationRow = { schemaName: "experimental", enabled: false };

    mocks.withTenantDbFn.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(
          buildSelectTx([
            [], // no version row match for publicId (passthrough)
            [schemaRow],
            [activationRow],
            [],
            [],
          ]),
        ),
    );

    const result = await schemaRegistryGetHandler(
      { versionId: "scv_xyz" },
      CTX,
    );
    expect(result.schemas[0]!.enabled).toBe(false);
  });

  // ── pinnedVersionId / draftVersionId resolvePublicId paths ───────────────

  it("resolves pinnedVersionId public id via separate withTenantDb call", async () => {
    const reg = { ...BASE_REGISTRY, pinnedVersionId: "ver-pinned-internal" };
    mocks.getOrCreateRegistry.mockResolvedValue(reg);

    // Call 1: schemas tx (versionId = pinnedVersionId → fall through)
    // Call 2: resolvePublicId(pinnedVersionId)
    let callCount = 0;
    mocks.withTenantDbFn.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          // schemas tx: no version row match → versionId = pinnedVersionId string
          return fn(
            buildSelectTx([
              [], // no publicId match → resolvedVersionId stays as pinnedVersionId
              [], // schemas
            ]),
          );
        }
        // resolvePublicId tx
        return fn(buildSelectTx([[{ publicId: "scv_pinned_public" }]]));
      },
    );

    const result = await schemaRegistryGetHandler({}, CTX);
    expect(result.pinnedVersionId).toBe("scv_pinned_public");
  });

  it("falls back to internal id when publicId row is not found", async () => {
    const reg = { ...BASE_REGISTRY, draftVersionId: "ver-draft-internal" };
    mocks.getOrCreateRegistry.mockResolvedValue(reg);

    let callCount = 0;
    mocks.withTenantDbFn.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn(buildSelectTx([[], []]));
        }
        // resolvePublicId → no row → fall back to internal id
        return fn(buildSelectTx([[]]));
      },
    );

    const result = await schemaRegistryGetHandler({}, CTX);
    expect(result.draftVersionId).toBe("ver-draft-internal");
  });

  // ── labels + rels populated correctly ────────────────────────────────────

  it("maps labels and relationship types under the correct schema", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);

    const schema1 = {
      id: "s1",
      name: "core",
      displayName: "Core",
      source: "connector",
      connectorId: "conn-1",
    };
    const label1 = {
      schemaId: "s1",
      name: "Person",
      displayName: "Person",
      description: "A person",
    };
    const rel1 = {
      schemaId: "s1",
      name: "KNOWS",
      displayName: "Knows",
      startLabel: "Person",
      endLabel: "Person",
    };

    mocks.withTenantDbFn.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(
          buildSelectTx([
            [], // version publicId lookup → no match
            [schema1],
            [], // activations
            [label1],
            [rel1],
          ]),
        ),
    );

    const result = await schemaRegistryGetHandler(
      { versionId: "scv_test" },
      CTX,
    );
    const [schema] = result.schemas;
    expect(schema!.labels).toHaveLength(1);
    expect(schema!.labels[0]!.name).toBe("Person");
    expect(schema!.relationshipTypes).toHaveLength(1);
    expect(schema!.relationshipTypes[0]!.name).toBe("KNOWS");
    expect(schema!.connectorId).toBe("conn-1");
    expect(schema!.source).toBe("connector");
  });
});
