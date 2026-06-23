/**
 * actions.test.ts — unit tests for createWorkspaceAction.
 *
 * Covers:
 *   - role gate: member → forbidden (only owner/admin allowed)
 *   - Zod: invalid slug (spaces) → error before any insert
 *   - reserved slug "new-workspace" → reserved error
 *   - duplicate slug (existing row found) → already-taken error
 *   - slug conflict on insert (23505) → already-taken error
 *   - happy path: returns ok:true with workspaceSlug
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertOrgMember,
  mockRunInTenantScope,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    membershipRole: string;
    existingSlugRows: { id: string }[];
    insertReturning: { id: string; slug: string }[];
    insertError: Error | null;
    // Tracks the withTenantDb call index across the full action invocation.
    // Reset in beforeEach so each test starts fresh.
    tenantCallIdx: number;
  }
  const dbState: DbState = {
    membershipRole: "owner",
    existingSlugRows: [],
    insertReturning: [{ id: "ws-1", slug: "main" }],
    insertError: null,
    tenantCallIdx: 0,
  };

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));

// Mock @oxagen/database — withTenantDb tracks call count via dbState.tenantCallIdx
// (reset in beforeEach). The action calls withTenantDb twice:
//   call 1 → membership role lookup (returns [{role}])
//   call 2 → existing slug pre-check (returns existingSlugRows)
// withSystemDb handles the actual workspace + membership inserts.
vi.mock("@oxagen/database", () => {
  const makeTenantTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => {
            dbState.tenantCallIdx++;
            if (dbState.tenantCallIdx === 1) {
              // First call: membership role lookup
              return Promise.resolve([{ role: dbState.membershipRole }]);
            }
            // Second call: existing slug pre-check
            return Promise.resolve(dbState.existingSlugRows);
          },
        }),
      }),
    }),
  });

  // The workspace insert calls .returning(); workspaceUsers insert does NOT.
  // Make `.values()` itself a thenable so `await tx.insert(t).values(v)` works.
  let systemInsertCallIdx = 0;
  const makeSystemTx = () => ({
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => {
        systemInsertCallIdx++;
        const callIdx = systemInsertCallIdx;
        return {
          returning: () => {
            if (dbState.insertError) throw dbState.insertError;
            if (callIdx === 1) return Promise.resolve(dbState.insertReturning);
            return Promise.resolve([]);
          },
          // Make `.values()` directly awaitable for inserts without .returning()
          then: (
            resolve: (v: undefined) => unknown,
            _reject: (e: unknown) => unknown,
          ) => Promise.resolve(undefined).then(resolve),
        };
      },
    }),
  });

  return {
    withTenantDb: vi.fn(
      (fn: (tx: ReturnType<typeof makeTenantTx>) => unknown) => {
        return fn(makeTenantTx());
      },
    ),
    withSystemDb: vi.fn(
      async (fn: (tx: ReturnType<typeof makeSystemTx>) => unknown) => {
        systemInsertCallIdx = 0;
        return fn(makeSystemTx());
      },
    ),
    schema: {
      orgUsers: { orgId: "ou_org", userId: "ou_user", role: "ou_role" },
      workspaces: {
        id: "ws_id",
        orgId: "ws_orgId",
        slug: "ws_slug",
        name: "ws_name",
      },
      workspaceUsers: { workspaceId: "wsu_wsId", userId: "wsu_user" },
    },
    // Mirror the real @oxagen/database isUniqueViolation: walk the (drizzle-
    // wrapped) cause chain for a Postgres unique_violation (SQLSTATE 23505).
    isUniqueViolation: (err: unknown): boolean => {
      let cur: unknown = err;
      for (let depth = 0; cur != null && depth < 5; depth++) {
        if (typeof cur === "object" && (cur as { code?: string }).code === "23505") return true;
        cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
      }
      return false;
    },
  };
});

// Mock the workspace.create contract — minimal input schema validation.
vi.mock("@oxagen/oxagen/contracts/workspace.create", () => ({
  workspaceCreate: {
    input: {
      safeParse: (raw: unknown) => {
        const r = raw as { name?: unknown; slug?: unknown };
        const name = typeof r?.name === "string" ? r.name.trim() : "";
        const slug = typeof r?.slug === "string" ? r.slug.trim() : "";
        if (!name || !slug || /\s/.test(slug)) {
          return { success: false, error: { issues: [{ message: "Invalid" }] } };
        }
        return { success: true, data: { name, slug } };
      },
    },
  },
}));

import { createWorkspaceAction } from "./actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.membershipRole = "owner";
    dbState.existingSlugRows = [];
    dbState.insertReturning = [{ id: "ws-1", slug: "main" }];
    dbState.insertError = null;
    dbState.tenantCallIdx = 0; // Reset per-test so call routing is deterministic
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("returns ok:false when the caller's role is member (not owner/admin)", async () => {
    dbState.membershipRole = "member";
    const res = await createWorkspaceAction("acme", form({ name: "Main", slug: "main" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("owner");
  });

  it("returns ok:false when the slug contains spaces (contract validation)", async () => {
    const res = await createWorkspaceAction(
      "acme",
      form({ name: "My Workspace", slug: "bad slug" }),
    );
    expect(res.ok).toBe(false);
  });

  it("returns ok:false for the reserved slug 'new-workspace'", async () => {
    const res = await createWorkspaceAction(
      "acme",
      form({ name: "New Workspace", slug: "new-workspace" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("reserved");
  });

  it("returns ok:false when a slug already exists in the org", async () => {
    dbState.existingSlugRows = [{ id: "existing-ws" }];
    const res = await createWorkspaceAction(
      "acme",
      form({ name: "Main", slug: "main" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already taken");
  });

  it("returns ok:false with duplicate-slug message on 23505 insert error", async () => {
    const pgErr = Object.assign(new Error("unique violation"), { code: "23505" });
    dbState.insertError = pgErr;
    const res = await createWorkspaceAction(
      "acme",
      form({ name: "Main", slug: "main" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already taken");
  });

  it("returns ok:true with workspaceSlug on a successful create", async () => {
    const res = await createWorkspaceAction(
      "acme",
      form({ name: "Main", slug: "main" }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.workspaceSlug).toBe("main");
  });
});
