/**
 * general-action.test.ts — unit tests for updateOrgGeneralAction (change org
 * name/slug/avatar).
 *
 * Covers the security-critical branches that the action enforces server-side:
 *   - zod validation of name + slug (rejects bad slugs before any DB read)
 *   - role re-read from DB (owner/admin only; forbidden otherwise)
 *   - global slug-uniqueness guard on change (clean error, not a raw 23505)
 *   - the "conflict is myself" allowance (slug row resolves to the same org)
 *   - happy paths for unchanged and changed slug (revalidatePath fan-out)
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database, @oxagen/tenancy,
 * next/cache. drizzle-orm operators stay real (they only build, never execute,
 * against the routed mock tx).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertOrgMember,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    roleRows: [] as { role: string }[],
    conflictRows: [] as { id: string }[],
    updateValues: [] as Record<string, unknown>[],
  },
}));

const SENTINEL = vi.hoisted(() => ({
  orgUsers: "orgUsers_sentinel" as const,
  organizations: "organizations_sentinel" as const,
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    select: (_cols: unknown) => ({
      from: (table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => {
            if (table === SENTINEL.orgUsers)
              return Promise.resolve(dbState.roleRows);
            if (table === SENTINEL.organizations)
              return Promise.resolve(dbState.conflictRows);
            return Promise.resolve([]);
          },
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
    // The action records slug-change history via tx.insert(orgSlugHistory) — a
    // no-op insert keeps the slug-change path from throwing "tx.insert is not a
    // function". (Tests assert on updateValues + revalidatePath, not inserts.)
    insert: (_t: unknown) => ({
      values: (_values: Record<string, unknown>) => Promise.resolve(undefined),
    }),
  });
  return {
    schema: {
      orgUsers: SENTINEL.orgUsers,
      organizations: SENTINEL.organizations,
    },
    withTenantDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    ),
  };
});

import { updateOrgGeneralAction } from "./general-action";

const ORG = { id: "org-1", slug: "acme" };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("updateOrgGeneralAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.roleRows = [{ role: "owner" }];
    dbState.conflictRows = [];
    dbState.updateValues = [];
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("updates name only when the slug is unchanged and revalidates a single path", async () => {
    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme Renamed", slug: "acme" }),
    );

    expect(result).toEqual({ ok: true, slug: "acme" });
    expect(dbState.updateValues).toHaveLength(1);
    expect(dbState.updateValues[0]).toMatchObject({
      name: "Acme Renamed",
      slug: "acme",
      updatedByUserId: "user-1",
    });
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/settings/general");
  });

  it("updates the slug and revalidates both old and new paths when changed", async () => {
    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "acme-corp" }),
    );

    expect(result).toEqual({ ok: true, slug: "acme-corp" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/settings/general");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme-corp/settings/general",
    );
  });

  it("rejects a slug already taken by a different org without writing", async () => {
    dbState.conflictRows = [{ id: "other-org" }];

    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "taken" }),
    );

    expect(result).toEqual({ ok: false, error: "That slug is already taken." });
    expect(dbState.updateValues).toHaveLength(0);
  });

  it("allows a slug change when the only conflicting row is the same org", async () => {
    dbState.conflictRows = [{ id: ORG.id }];

    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "acme-corp" }),
    );

    expect(result).toEqual({ ok: true, slug: "acme-corp" });
    expect(dbState.updateValues).toHaveLength(1);
  });

  it("returns Forbidden when the caller is not owner/admin and never writes", async () => {
    dbState.roleRows = [{ role: "member" }];

    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "acme" }),
    );

    expect(result).toEqual({ ok: false, error: "Forbidden" });
    expect(dbState.updateValues).toHaveLength(0);
  });

  it("returns Forbidden when no membership row is found (empty role)", async () => {
    dbState.roleRows = [];

    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "acme" }),
    );

    expect(result).toEqual({ ok: false, error: "Forbidden" });
  });

  it("rejects an invalid slug before any DB role read", async () => {
    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "Bad Slug!" }),
    );

    expect(result.ok).toBe(false);
    expect(dbState.updateValues).toHaveLength(0);
  });

  it("rejects an empty name", async () => {
    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "", slug: "acme" }),
    );

    expect(result.ok).toBe(false);
  });

  it("persists avatarUrl as null when omitted/blank", async () => {
    await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "acme", avatarUrl: "" }),
    );

    expect(dbState.updateValues[0]).toMatchObject({ avatarUrl: null });
  });

  it("returns a friendly error when an unexpected error is thrown", async () => {
    mockResolveOrg.mockRejectedValue(new Error("boom"));

    const result = await updateOrgGeneralAction(
      "acme",
      form({ name: "Acme", slug: "acme" }),
    );

    expect(result).toEqual({ ok: false, error: "boom" });
  });
});
