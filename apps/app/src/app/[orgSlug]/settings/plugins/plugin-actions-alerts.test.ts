/**
 * plugin-actions-alerts.test.ts — unit tests for setAuthAlertsAction.
 *
 * Covers:
 *   - validation: invalid role in array (not Owner/Admin/Compliance/Billing) → ok:false
 *   - validation: empty roles array → ok:false
 *   - auth gate: member role → NOT_AUTHORIZED
 *   - happy path: ok:true, invoke called with sendEmail + roles
 *   - error: invoke throws → ok:false, error returned
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    roleRows: Array<{ role: string | null }>;
  }
  const dbState: DbState = { roleRows: [{ role: "owner" }] };

  const mockLimit = vi.fn(() => Promise.resolve(dbState.roleRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithTenantDb = vi.fn(
    (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn(
    (_scope: unknown, fn: () => unknown) => fn(),
  );

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockInvoke: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({ resolveOrg: mockResolveOrg }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withTenantDb: mockWithTenantDb,

  };
});
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { setAuthAlertsAction } from "./plugin-actions-alerts";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };

function setRole(role: string | null) {
  dbState.roleRows = role === null ? [] : [{ role }];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setAuthAlertsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("owner");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns not-authorized for a member role", async () => {
    setRole("member");
    const res = await setAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: ["Owner"],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("permission");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false for an invalid role string", async () => {
    const res = await setAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: false,
      roles: ["superuser"],
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false for an empty roles array (min(1))", async () => {
    const res = await setAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: [],
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and calls plugin.settings.set_auth_alerts on success", async () => {
    const res = await setAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: ["Owner", "Admin"],
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.settings.set_auth_alerts",
      { sendEmail: true, roles: ["Owner", "Admin"] },
      expect.objectContaining({ orgId: "org-1" }),
      { surface: "agent" },
    );
  });

  it("revalidates the plugins settings page on success", async () => {
    await setAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: false,
      roles: ["Compliance"],
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/settings/plugins");
  });

  it("returns ok:false with error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("channel not configured"));
    const res = await setAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: ["Billing"],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("channel not configured");
  });
});
