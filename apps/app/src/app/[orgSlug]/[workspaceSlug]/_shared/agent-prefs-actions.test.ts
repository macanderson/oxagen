/**
 * agent-prefs-actions.test.ts — unit tests for setDefaultAgentAction.
 *
 * Mocking strategy mirrors conversation-actions.test.ts:
 *   - getSessionOrRedirect, resolveOrg, resolveWorkspace, assertOrgMember → vi.mock
 *   - invoke from @oxagen/oxagen → vi.mock
 *   - @oxagen/handlers/register → side-effect import stub
 *
 * Coverage:
 *   1. invalid input (empty-string agentId) → safeParse fails → {ok:false},
 *      invoke NOT called
 *   2. success → {ok:true} and invoke called with
 *      update_workspace_user_preferences + {defaultAgentId} (config-derived name)
 *   3. assertOrgMember throws (the IDOR guard — apps/app skips the IAM kernel so
 *      this is the sole auth gate) → {ok:false}, invoke NOT called
 *   4. invoke throws → {ok:false} with the error message
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports of the module under test.
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  resolveWorkspace: vi.fn(),
  assertOrgMember: vi.fn(),
}));

vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

// Side-effect import — just needs to not throw.
vi.mock("@oxagen/handlers/register", () => ({}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  setDefaultAgentAction,
  type AgentPrefsActionCtx,
} from "./agent-prefs-actions";

import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";

// Import the contract to derive its name (config-derived, never hardcoded).
import { userWorkspacePreferencesWrite } from "@oxagen/oxagen/contracts/user.workspace_preferences.write";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx: AgentPrefsActionCtx = { orgSlug: "acme", workspaceSlug: "prod" };
const mockSession = { user: { id: "user-1" } };
const mockOrg = { id: "org-1", publicId: "pub-1", name: "Acme", slug: "acme" };
const mockWs = {
  id: "ws-1",
  publicId: "pub-ws-1",
  orgId: "org-1",
  name: "Prod",
  slug: "prod",
};

function setupHappyPath() {
  vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
  vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
  vi.mocked(resolveWorkspace).mockResolvedValue(mockWs as never);
  vi.mocked(assertOrgMember).mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyPath();
});

// ---------------------------------------------------------------------------
// 1. Invalid input — empty-string agentId fails the contract's .min(1)
// ---------------------------------------------------------------------------

describe("setDefaultAgentAction — invalid input", () => {
  it("empty-string agentId → safeParse fails → {ok:false} WITHOUT calling invoke", async () => {
    const result = await setDefaultAgentAction(ctx, "");
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    // Fails before any org/workspace resolution too.
    expect(resolveOrg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Success — invoke dispatched with the config-derived name + {defaultAgentId}
// ---------------------------------------------------------------------------

describe("setDefaultAgentAction — success", () => {
  it("valid agentId → invoke called with update_workspace_user_preferences + {defaultAgentId}", async () => {
    vi.mocked(invoke).mockResolvedValue({} as never);
    const result = await setDefaultAgentAction(ctx, "agt_code");
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    const [capabilityName, input] = vi.mocked(invoke).mock.calls[0]!;
    // Config-derived: the imported contract name, not a hardcoded string.
    expect(capabilityName).toBe(userWorkspacePreferencesWrite.name);
    expect(input).toEqual({ defaultAgentId: "agt_code" });
  });

  it("null agentId (clear) is valid → invoke called with {defaultAgentId: null}", async () => {
    vi.mocked(invoke).mockResolvedValue({} as never);
    const result = await setDefaultAgentAction(ctx, null);
    expect(result.ok).toBe(true);
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect(input).toEqual({ defaultAgentId: null });
  });
});

// ---------------------------------------------------------------------------
// 3. assertOrgMember throws — the IDOR guard rejects → {ok:false}, no invoke
// ---------------------------------------------------------------------------

describe("setDefaultAgentAction — membership guard", () => {
  it("assertOrgMember throws → {ok:false} and invoke NOT called", async () => {
    vi.mocked(assertOrgMember).mockRejectedValue(new Error("Not a member"));
    const result = await setDefaultAgentAction(ctx, "agt_code");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Not a member");
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. invoke throws → {ok:false} with the error message
// ---------------------------------------------------------------------------

describe("setDefaultAgentAction — invoke failure", () => {
  it("invoke throws → {ok:false} with the error message", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("handler panic"));
    const result = await setDefaultAgentAction(ctx, "agt_code");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("handler panic");
  });

  it("non-Error throw → {ok:false} with the fallback message", async () => {
    vi.mocked(invoke).mockRejectedValue("boom");
    const result = await setDefaultAgentAction(ctx, "agt_code");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Failed to set default agent");
  });
});
