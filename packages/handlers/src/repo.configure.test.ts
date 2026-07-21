import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { repoConfigureHandler } from "./repo.configure";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

type Existing = {
  id: string;
  displayName: string;
  deliveryConfig: Record<string, unknown> | null;
  deliveryMethod: string | null;
} | null;

function setup(existing: Existing, setSpy = vi.fn()) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(existing ? [existing] : []),
            }),
          }),
        }),
        update: () => ({
          set: (v: { deliveryConfig?: Record<string, unknown> }) => {
            setSpy(v.deliveryConfig);
            return { where: () => Promise.resolve() };
          },
        }),
      }),
  );
  return { setSpy };
}

describe("repo.configure handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists exclude globs into pipeline filters and include globs into companion keys", async () => {
    const { setSpy } = setup({
      id: "c1",
      displayName: "acme/app",
      deliveryConfig: { owner: "acme", repo: "app" },
      deliveryMethod: "webhook",
    });

    const out = await repoConfigureHandler(
      {
        repoId: "con_1",
        recordTypes: ["pull_request", "issue"],
        pathFilters: {
          include: ["src/**"],
          exclude: ["node_modules/**", "dist/**"],
        },
        labelFilters: { include: ["bug"], exclude: ["wontfix"] },
        syncCadence: "polling",
        pollingIntervalSeconds: 600,
      },
      CTX,
    );

    expect(out.repoId).toBe("con_1");
    expect(out.displayName).toBe("acme/app");
    expect(out.recordTypes).toEqual(["pull_request", "issue"]);
    expect(out.pathFilters).toEqual({
      include: ["src/**"],
      exclude: ["node_modules/**", "dist/**"],
    });
    expect(out.labelFilters).toEqual({
      include: ["bug"],
      exclude: ["wontfix"],
    });
    expect(out.syncCadence).toBe("polling");
    expect(out.pollingIntervalSeconds).toBe(600);

    // The persisted deliveryConfig keeps the pipeline-read string[] exclude lists,
    // companion include keys, and preserves connector-specific fields.
    const persisted = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted["pathFilters"]).toEqual(["node_modules/**", "dist/**"]);
    expect(persisted["pathFiltersInclude"]).toEqual(["src/**"]);
    expect(persisted["labelFilters"]).toEqual(["wontfix"]);
    expect(persisted["labelFiltersInclude"]).toEqual(["bug"]);
    expect(persisted["recordTypeFilters"]).toEqual(["pull_request", "issue"]);
    expect(persisted["syncMethod"]).toBe("polling");
    expect(persisted["syncIntervalSeconds"]).toBe(600);
    // connector-specific fields survive the merge
    expect(persisted["owner"]).toBe("acme");
    expect(persisted["repo"]).toBe("app");
  });

  it("preserves prior filter values when an input filter is omitted", async () => {
    setup({
      id: "c1",
      displayName: "acme/app",
      deliveryConfig: {
        recordTypeFilters: ["commit"],
        pathFilters: ["vendor/**"],
        pathFiltersInclude: ["lib/**"],
        syncMethod: "manual",
      },
      deliveryMethod: "webhook",
    });

    const out = await repoConfigureHandler({ repoId: "con_1" }, CTX);

    expect(out.recordTypes).toEqual(["commit"]);
    expect(out.pathFilters).toEqual({
      include: ["lib/**"],
      exclude: ["vendor/**"],
    });
    expect(out.syncCadence).toBe("manual");
  });

  it("returns null filters when neither include nor exclude is configured", async () => {
    setup({
      id: "c1",
      displayName: "acme/app",
      deliveryConfig: null,
      deliveryMethod: "webhook",
    });
    const out = await repoConfigureHandler(
      { repoId: "con_1", syncCadence: "manual" },
      CTX,
    );
    expect(out.pathFilters).toBeNull();
    expect(out.labelFilters).toBeNull();
    expect(out.recordTypes).toEqual([]);
    expect(out.pollingIntervalSeconds).toBeNull();
  });

  it("round-trips fieldMappings into deliveryConfig", async () => {
    const { setSpy } = setup({
      id: "c1",
      displayName: "acme/app",
      deliveryConfig: null,
      deliveryMethod: "webhook",
    });
    await repoConfigureHandler(
      {
        repoId: "con_1",
        fieldMappings: { title: "name", body: "description" },
        syncCadence: "manual",
      },
      CTX,
    );
    const persisted = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted["fieldMappings"]).toEqual({
      title: "name",
      body: "description",
    });
  });

  it("throws 404 when the connection does not exist", async () => {
    setup(null);
    await expect(
      repoConfigureHandler({ repoId: "con_missing" }, CTX),
    ).rejects.toThrow("Repository connection not found");
  });
});
