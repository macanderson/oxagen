/**
 * coding-agent-preferences-actions.test.ts — unit tests for
 * updateCodingAgentPreferencesAction.
 *
 * Covers:
 *   - zod validation rejects an empty orgSlug/workspaceSlug before invoke
 *   - IDOR guard: assertOrgMember is called before invoke
 *   - happy path: invoke called with update_workspace_user_preferences and
 *     NO surface override (contract's surfaces is ["api"] only — passing a
 *     surface would trip surface_denied; mirrors
 *     _shared/agent-prefs-actions.ts::setDefaultAgentAction)
 *   - all-null payload clears every field
 *   - invoke error → ok:false with error message
 *   - no workspace-role gate: a plain "member" role still succeeds (these are
 *     the caller's own personal defaults, not workspace governance)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockInvoke,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));

import { updateCodingAgentPreferencesAction } from "./coding-agent-preferences-actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };

function base(
  overrides: Partial<{
    defaultRepoConnectionId: string | null;
    defaultRepoSlug: string | null;
    defaultEnvironmentId: string | null;
    defaultAgentId: string | null;
  }> = {},
) {
  return {
    orgSlug: "acme",
    workspaceSlug: "main",
    defaultRepoConnectionId: "con-1",
    defaultRepoSlug: "acme/repo-a",
    defaultEnvironmentId: "env-1",
    defaultAgentId: "agt_1",
    ...overrides,
  };
}

describe("updateCodingAgentPreferencesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue({
      defaultRepoConnectionId: "con-1",
      defaultRepoSlug: "acme/repo-a",
      defaultEnvironmentId: "env-1",
      defaultAgentId: "agt_1",
      repoDefaultPrompted: true,
    });
  });

  it("rejects an empty orgSlug before invoking", async () => {
    const res = await updateCodingAgentPreferencesAction({
      ...base(),
      orgSlug: "",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("asserts org membership (IDOR guard) before invoking", async () => {
    await updateCodingAgentPreferencesAction(base());
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockInvoke.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockAssertOrgMember.mock.invocationCallOrder[0]!,
    );
  });

  it("invokes update_workspace_user_preferences with NO surface override on the happy path", async () => {
    const res = await updateCodingAgentPreferencesAction(base());
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_workspace_user_preferences",
      {
        defaultRepoConnectionId: "con-1",
        defaultRepoSlug: "acme/repo-a",
        defaultEnvironmentId: "env-1",
        defaultAgentId: "agt_1",
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
    );
    // Exactly 3 positional args — no 4th { surface } opts object, matching the
    // app-only contract's surfaces:["api"] precedent (setDefaultAgentAction).
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("sends an all-null payload to clear every field", async () => {
    await updateCodingAgentPreferencesAction(
      base({
        defaultRepoConnectionId: null,
        defaultRepoSlug: null,
        defaultEnvironmentId: null,
        defaultAgentId: null,
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_workspace_user_preferences",
      {
        defaultRepoConnectionId: null,
        defaultRepoSlug: null,
        defaultEnvironmentId: null,
        defaultAgentId: null,
      },
      expect.anything(),
    );
  });

  it("does not gate on workspace role — a plain member can save their own defaults", async () => {
    // No workspace-role lookup exists in this action at all; assertOrgMember
    // resolving is the only gate. Simulate a "member" caller by simply
    // confirming assertOrgMember resolving lets the save through.
    mockAssertOrgMember.mockResolvedValue(undefined);
    const res = await updateCodingAgentPreferencesAction(base());
    expect(res.ok).toBe(true);
  });

  it("returns ok:false with error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("preferences rejected"));
    const res = await updateCodingAgentPreferencesAction(base());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("preferences rejected");
  });
});
