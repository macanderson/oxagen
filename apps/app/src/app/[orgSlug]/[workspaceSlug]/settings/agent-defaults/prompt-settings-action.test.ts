/**
 * prompt-settings-action.test.ts — unit tests for updatePromptSettingsAction.
 *
 * Covers:
 *   - role gate: non-owner/admin workspace role → ok:false, no invoke
 *   - happy path: ok:true, invoke called with prompt.settings.write + mapped input
 *   - invoke error → ok:false with message
 *   - enterprise tier-denied error → ok:false, tierDenied:true
 *   - revalidatePath called on success
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
} = vi.hoisted(() => {
  const dbState: { wsRoleRows: Array<{ role: string }> } = {
    wsRoleRows: [{ role: "owner" }],
  };
  const mockLimit = vi.fn(() => Promise.resolve(dbState.wsRoleRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );
  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockResolveWorkspace: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockInvoke: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
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
vi.mock("@/lib/routes", () => ({
  workspace: {
    settings: {
      agentDefaults: ({
        orgSlug,
        workspaceSlug,
      }: {
        orgSlug: string;
        workspaceSlug: string;
      }) => `/${orgSlug}/${workspaceSlug}/settings/agent-defaults`,
    },
  },
}));

import { updatePromptSettingsAction } from "./prompt-settings-action";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };
const BASE = {
  orgSlug: "acme",
  workspaceSlug: "main",
  additionalInstructions: "Be concise.",
  overrides: null,
  autoImprovePrompts: true,
};

describe("updatePromptSettingsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue({
      additionalInstructions: "Be concise.",
      overrides: {},
      autoImprovePrompts: true,
    });
  });

  it("rejects a non-owner/admin workspace role without invoking", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await updatePromptSettingsAction(BASE);
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes prompt.settings.write with the mapped input on the happy path", async () => {
    const res = await updatePromptSettingsAction(BASE);
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_prompt_settings",
      {
        additionalInstructions: "Be concise.",
        overrides: null,
        autoImprovePrompts: true,
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      expect.objectContaining({ surface: expect.any(String) }),
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/settings/agent-defaults",
    );
  });

  it("returns ok:false when the capability throws", async () => {
    mockInvoke.mockRejectedValue(new Error("boom"));
    const res = await updatePromptSettingsAction(BASE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("boom");
  });

  it("flags tierDenied when overrides are rejected for a non-enterprise plan", async () => {
    mockInvoke.mockRejectedValue(
      new Error("tier 'build' is below required 'enterprise'"),
    );
    const res = await updatePromptSettingsAction({
      ...BASE,
      overrides: { "svg.generate": "flat brand style" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.tierDenied).toBe(true);
  });
});
