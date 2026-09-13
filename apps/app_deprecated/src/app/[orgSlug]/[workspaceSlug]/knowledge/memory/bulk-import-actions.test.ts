/**
 * bulk-import-actions.test.ts — unit tests for the bulk-import server actions.
 *
 * Covers the action-layer logic that does NOT live in the handlers:
 *   parseImportAction:  empty/blank-doc guard, MAX_DOCS cap, MAX_DOC_CHARS cap,
 *                       workspace-member gate, happy path (invoke args), invoke error.
 *   commitImportAction: empty-drafts guard, MAX_DRAFTS cap, workspace-member gate,
 *                       happy path (revalidatePath), invoke error.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockWithTenantDb: vi.fn(),
  mockInvoke: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: { role: "owner" as string },
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
// Side-effect handler-registration imports — no-op in the unit env.
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
// withTenantDb ignores the query callback and returns the configured role row.
vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: { workspaceUsers: { role: {}, workspaceId: {}, userId: {} } },
}));

import { parseImportAction, commitImportAction } from "./bulk-import-actions";

const BASE = { orgSlug: "oxagen", workspaceSlug: "main" };

type MemoryClass = "OBSERVATION" | "RULE" | "FACT";

function draft(
  overrides: Partial<{
    lesson: string;
    memoryKind: string;
    memoryClass: MemoryClass;
    enforcementScore: number;
  }> = {},
) {
  return {
    lesson: "Never push to main.",
    memoryKind: "constraint",
    memoryClass: "RULE" as MemoryClass,
    enforcementScore: 95,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.role = "owner";
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockResolveWorkspace.mockResolvedValue({ id: "ws-1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockRunInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mockWithTenantDb.mockImplementation(async () => [{ role: dbState.role }]);
});

describe("parseImportAction", () => {
  it("rejects when no non-empty documents are supplied", async () => {
    const res = await parseImportAction({
      ...BASE,
      documents: [{ filename: "a.md", content: "   " }],
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("at least one non-empty"),
    });
    expect(mockResolveOrg).not.toHaveBeenCalled();
  });

  it("rejects more than 25 documents", async () => {
    const documents = Array.from({ length: 26 }, (_, i) => ({
      filename: `f${i}.md`,
      content: "x",
    }));
    const res = await parseImportAction({ ...BASE, documents });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("at most 25"),
    });
  });

  it("rejects a document over the 100k character cap", async () => {
    const res = await parseImportAction({
      ...BASE,
      documents: [{ filename: "big.md", content: "x".repeat(100_001) }],
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("too large"),
    });
  });

  it("denies a caller who is not a workspace member", async () => {
    dbState.role = "viewer";
    const res = await parseImportAction({
      ...BASE,
      documents: [{ filename: "a.md", content: "rule" }],
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes parse with cleaned documents + default anchor and returns drafts", async () => {
    mockInvoke.mockResolvedValue({
      drafts: [draft()],
      documentCount: 1,
      skipped: [],
    });
    const res = await parseImportAction({
      ...BASE,
      documents: [
        { filename: "a.md", content: "rule one" },
        { filename: "blank.md", content: "  " }, // dropped as blank
      ],
      defaultNodeRef: " team:platform ",
    });
    expect(res.ok).toBe(true);
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("parse_memory_import");
    expect(input).toEqual({
      documents: [{ filename: "a.md", content: "rule one" }],
      defaultNodeRef: "team:platform",
    });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("returns ok:false with the error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("gateway down"));
    const res = await parseImportAction({
      ...BASE,
      documents: [{ filename: "a.md", content: "rule" }],
    });
    expect(res).toEqual({ ok: false, error: "gateway down" });
  });
});

describe("commitImportAction", () => {
  it("rejects an empty drafts array", async () => {
    const res = await commitImportAction({ ...BASE, drafts: [] });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("at least one memory"),
    });
    expect(mockResolveOrg).not.toHaveBeenCalled();
  });

  it("rejects more than 200 drafts", async () => {
    const drafts = Array.from({ length: 201 }, () => draft());
    const res = await commitImportAction({ ...BASE, drafts });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("at most 200"),
    });
  });

  it("denies a non-workspace-member", async () => {
    dbState.role = "";
    const res = await commitImportAction({ ...BASE, drafts: [draft()] });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes commit, revalidates the list, and returns results on success", async () => {
    mockInvoke.mockResolvedValue({
      results: [{ lesson: "L", ok: true, memoryId: "m_1", error: null }],
      imported: 1,
      failed: 0,
    });
    const res = await commitImportAction({ ...BASE, drafts: [draft()] });
    expect(res).toEqual({
      ok: true,
      results: [{ lesson: "L", ok: true, memoryId: "m_1", error: null }],
      imported: 1,
      failed: 0,
    });
    expect(mockInvoke.mock.calls[0]?.[0]).toBe("commit_memory_import");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/oxagen/main/knowledge/memory",
    );
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    const res = await commitImportAction({ ...BASE, drafts: [draft()] });
    expect(res).toEqual({ ok: false, error: "neo4j down" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
