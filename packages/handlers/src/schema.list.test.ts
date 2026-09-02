import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
});

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: (...args: unknown[]) =>
    mocks.getOrCreateRegistry(...args),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaListHandler } from "./schema.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

function makeTxWithSelects(schemaRows: object[], activationRows: object[]) {
  let selectCallCount = 0;
  return {
    select: () => {
      selectCallCount++;
      const num = selectCallCount;
      return {
        from: () => ({
          where: () => {
            if (num === 1) {
              // schemas select
              return Promise.resolve(schemaRows);
            }
            // activations select
            return Promise.resolve(activationRows);
          },
        }),
      };
    },
  };
}

describe("schemaListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty schemas when no version available (no pinned, no draft)", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const result = await schemaListHandler({}, CTX);
    expect(result).toEqual({ schemas: [] });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("returns empty schemas when version has no schema rows", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_1",
      draftVersionId: null,
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(makeTxWithSelects([], []));
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result).toEqual({ schemas: [] });
  });

  it("returns schemas with enabled=true by default (no activation row)", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_1",
      draftVersionId: null,
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(
          makeTxWithSelects(
            [
              {
                id: "schema_1",
                name: "Person",
                displayName: "Person",
                source: "user",
                connectorId: null,
              },
            ],
            [], // no activation rows → default enabled=true
          ),
        );
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result.schemas).toHaveLength(1);
    const [row] = result.schemas;
    expect(row).toMatchObject({
      schemaName: "Person",
      displayName: "Person",
      source: "user",
      connectorId: null,
      enabled: true,
    });
  });

  it("respects activation rows (enabled=false)", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_1",
      draftVersionId: null,
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(
          makeTxWithSelects(
            [
              {
                id: "schema_1",
                name: "Company",
                displayName: "Company",
                source: "recommended",
                connectorId: null,
              },
            ],
            [{ schemaName: "Company", enabled: false }],
          ),
        );
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result.schemas).toHaveLength(1);
    const [row] = result.schemas;
    expect(row?.enabled).toBe(false);
  });

  it("respects activation rows (enabled=true explicitly)", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_internal_1",
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(
          makeTxWithSelects(
            [
              {
                id: "schema_1",
                name: "Repo",
                displayName: "Repository",
                source: "connector",
                connectorId: "conn_1",
              },
            ],
            [{ schemaName: "Repo", enabled: true }],
          ),
        );
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result.schemas).toHaveLength(1);
    const [row] = result.schemas;
    expect(row?.enabled).toBe(true);
    expect(row?.connectorId).toBe("conn_1");
    expect(row?.source).toBe("connector");
  });

  it("returns multiple schemas with mixed enabled state", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_1",
      draftVersionId: null,
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(
          makeTxWithSelects(
            [
              {
                id: "s1",
                name: "Person",
                displayName: "Person",
                source: "user",
                connectorId: null,
              },
              {
                id: "s2",
                name: "Company",
                displayName: "Company",
                source: "recommended",
                connectorId: null,
              },
              {
                id: "s3",
                name: "Repo",
                displayName: "Repository",
                source: "connector",
                connectorId: "conn_1",
              },
            ],
            // Only Person has an explicit disabled activation; Company and Repo default to enabled
            [{ schemaName: "Person", enabled: false }],
          ),
        );
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result.schemas).toHaveLength(3);

    const personSchema = result.schemas.find((s) => s.schemaName === "Person");
    const companySchema = result.schemas.find(
      (s) => s.schemaName === "Company",
    );
    const repoSchema = result.schemas.find((s) => s.schemaName === "Repo");

    expect(personSchema?.enabled).toBe(false);
    expect(companySchema?.enabled).toBe(true);
    expect(repoSchema?.enabled).toBe(true);
  });

  it("prefers pinnedVersionId over draftVersionId for reads", async () => {
    // Registry has both pinned and draft — should use pinned
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_1",
      draftVersionId: "draft_internal_1",
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(makeTxWithSelects([], []));
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result).toEqual({ schemas: [] });
    // withTenantDb called once (not twice — confirming it used pinned directly)
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("uses draftVersionId when pinnedVersionId is null", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_internal_1",
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(
          makeTxWithSelects(
            [
              {
                id: "schema_1",
                name: "DraftSchema",
                displayName: "Draft Schema",
                source: "user",
                connectorId: null,
              },
            ],
            [],
          ),
        );
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result.schemas).toHaveLength(1);
    const [row] = result.schemas;
    expect(row?.schemaName).toBe("DraftSchema");
  });

  it("returns connectorId=null when schema has no connectorId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_1",
      draftVersionId: null,
    });

    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        return fn(
          makeTxWithSelects(
            // connectorId field is undefined (no field) — should be coerced to null
            [{ id: "s1", name: "Thing", displayName: "Thing", source: "user" }],
            [],
          ),
        );
      },
    );

    const result = await schemaListHandler({}, CTX);
    expect(result.schemas).toHaveLength(1);
    const [row] = result.schemas;
    expect(row?.connectorId).toBeNull();
  });
});
