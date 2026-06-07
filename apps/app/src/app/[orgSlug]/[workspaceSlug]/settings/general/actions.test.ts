/**
 * actions.test.ts — unit tests for updateWorkspaceGeneralAction (change
 * workspace name/slug/description).
 *
 * Covers:
 *   - zod validation (rejects bad slugs before any DB work)
 *   - per-org slug-uniqueness guard on change (clean error, not a raw 23505)
 *   - happy paths for unchanged vs changed slug (revalidatePath fan-out)
 *   - description merge into the workspaces.settings JSONB
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database, @oxagen/tenancy,
 * next/cache. drizzle-orm operators stay real (build-only against the mock tx).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    conflictRows: [] as { id: string }[],
    updateValues: [] as Record<string, unknown>[],
  },
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => Promise.resolve(dbState.conflictRows),
        }),
      }),
    }),
    update: (_t: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_w: unknown) => {
          dbState.updateValues.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }),
  });
  return {
    schema: { workspaces: { settings: "workspaces.settings_sentinel" } },
    withTenantDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    ),
  };
});

import { updateWorkspaceGeneralAction } from "./actions";

const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "research" };

function base(overrides: Record<string, string> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "research",
    name: "Research",
    slug: "research",
    ...overrides,
  };
}

describe("updateWorkspaceGeneralAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.conflictRows = [];
    dbState.updateValues = [];
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
  });

  it("updates name/description when the slug is unchanged (no conflict query)", async () => {
    const result = await updateWorkspaceGeneralAction(
      base({ name: "Research Renamed", description: "team space" }),
    );

    expect(result).toEqual({ ok: true, slug: "research" });
    expect(dbState.updateValues).toHaveLength(1);
    expect(dbState.updateValues[0]).toMatchObject({ name: "Research Renamed" });
    // Unchanged slug → only the base settings paths are revalidated.
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research/settings/general",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/research/settings");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
  });

  it("updates the slug and revalidates old + new paths when changed", async () => {
    const result = await updateWorkspaceGeneralAction(base({ slug: "research-2" }));

    expect(result).toEqual({ ok: true, slug: "research-2" });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research-2/settings/general",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/research-2/settings");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(4);
  });

  it("rejects a slug already taken in the same org without writing", async () => {
    dbState.conflictRows = [{ id: "other-ws" }];

    const result = await updateWorkspaceGeneralAction(base({ slug: "taken" }));

    expect(result).toEqual({
      ok: false,
      error: "That slug is already taken in this organization.",
    });
    expect(dbState.updateValues).toHaveLength(0);
  });

  it("rejects an invalid slug before any DB work", async () => {
    const result = await updateWorkspaceGeneralAction(base({ slug: "Bad Slug!" }));

    expect(result.ok).toBe(false);
    expect(dbState.updateValues).toHaveLength(0);
  });

  it("rejects an empty name", async () => {
    const result = await updateWorkspaceGeneralAction(base({ name: "" }));

    expect(result.ok).toBe(false);
  });

  it("writes the workspace update including the merged settings expression", async () => {
    await updateWorkspaceGeneralAction(base({ description: "hello" }));

    expect(dbState.updateValues).toHaveLength(1);
    expect(dbState.updateValues[0]).toHaveProperty("settings");
    expect(dbState.updateValues[0]).toMatchObject({ name: "Research" });
  });
});
