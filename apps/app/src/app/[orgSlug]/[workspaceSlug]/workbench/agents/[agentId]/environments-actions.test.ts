/**
 * environments-actions.test.ts — unit tests for the agent-environment binding
 * server actions (agent.environment.* capability family).
 *
 * Covers:
 *   - reads (list bindings / environment options / template options) invoke the
 *     right capability with surface:"agent"
 *   - bind/unbind happy paths → ok:true, revalidatePath called
 *   - the Owner/Admin gate (canManage:false) → ok:false, invoke NOT called
 *   - invoke throwing → ok:false with the propagated message
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockResolveWorkbenchScope,
  mockInvoke,
  mockRunInTenantScope,
  mockRevalidatePath,
  scopeState,
} = vi.hoisted(() => {
  interface ScopeState {
    canManage: boolean;
  }
  const scopeState: ScopeState = { canManage: true };
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );
  return {
    mockResolveWorkbenchScope: vi.fn(),
    mockInvoke: vi.fn(),
    mockRunInTenantScope,
    mockRevalidatePath: vi.fn(),
    scopeState,
  };
});

vi.mock("@/lib/workbench/scope", () => ({
  resolveWorkbenchScope: mockResolveWorkbenchScope,
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/handlers/register", () => ({}));

import {
  readAgentBindingsAction,
  readEnvironmentOptionsAction,
  readTemplateOptionsAction,
  bindAgentEnvironmentAction,
  unbindAgentEnvironmentAction,
} from "./environments-actions";

const SCOPE = { orgSlug: "acme", workspaceSlug: "default" };
const AGENT = "agent_pub_1";

const BINDING = {
  id: "bnd_1",
  agentId: AGENT,
  environmentId: "env_1",
  environmentName: "Production",
  environmentSlug: "production",
  sandboxTemplateId: null,
  sandboxTemplateName: null,
  isPrimary: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  scopeState.canManage = true;
  mockResolveWorkbenchScope.mockImplementation(async () => ({
    ctx: {
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "user_1",
      surface: "app",
    },
    org: { id: "org_1" },
    ws: { id: "ws_1" },
    canManage: scopeState.canManage,
  }));
});

describe("readAgentBindingsAction", () => {
  it("invokes list_agent_environments and returns bindings", async () => {
    mockInvoke.mockResolvedValue({ bindings: [BINDING] });
    const out = await readAgentBindingsAction({ ...SCOPE, agentId: AGENT });
    expect(out).toEqual([BINDING]);
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_agent_environments",
      { agentId: AGENT },
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("readEnvironmentOptionsAction", () => {
  it("invokes list_environments", async () => {
    mockInvoke.mockResolvedValue({
      environments: [
        { id: "env_1", name: "Prod", slug: "prod", isDefault: true },
      ],
    });
    const out = await readEnvironmentOptionsAction(SCOPE);
    expect(out).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_environments",
      {},
      expect.any(Object),
      {
        surface: "agent",
      },
    );
  });
});

describe("readTemplateOptionsAction", () => {
  it("invokes list_sandbox_templates and projects options", async () => {
    mockInvoke.mockResolvedValue({
      templates: [
        {
          id: "tpl_1",
          environmentId: "env_1",
          name: "Base",
          slug: "base",
          isDefault: false,
          extra: "ignored",
        },
      ],
    });
    const out = await readTemplateOptionsAction(SCOPE);
    expect(out).toEqual([
      {
        id: "tpl_1",
        environmentId: "env_1",
        name: "Base",
        slug: "base",
        isDefault: false,
      },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_sandbox_templates",
      {},
      expect.any(Object),
      {
        surface: "agent",
      },
    );
  });
});

describe("bindAgentEnvironmentAction", () => {
  it("owner: invokes bind_agent_environment, returns binding, revalidates", async () => {
    mockInvoke.mockResolvedValue({ binding: BINDING });
    const res = await bindAgentEnvironmentAction({
      ...SCOPE,
      agentId: AGENT,
      environmentId: "env_1",
      sandboxTemplateId: null,
      isPrimary: true,
    });
    expect(res).toEqual({ ok: true, binding: BINDING });
    expect(mockInvoke).toHaveBeenCalledWith(
      "bind_agent_environment",
      {
        agentId: AGENT,
        environmentId: "env_1",
        sandboxTemplateId: null,
        isPrimary: true,
      },
      expect.any(Object),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/acme/default/workbench/agents/${AGENT}`,
    );
  });

  it("non-manager: role gate rejects, invoke NOT called", async () => {
    scopeState.canManage = false;
    const res = await bindAgentEnvironmentAction({
      ...SCOPE,
      agentId: AGENT,
      environmentId: "env_1",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invoke throws → ok:false with message", async () => {
    mockInvoke.mockRejectedValue(new Error("nope"));
    const res = await bindAgentEnvironmentAction({
      ...SCOPE,
      agentId: AGENT,
      environmentId: "env_1",
    });
    expect(res).toEqual({ ok: false, error: "nope" });
  });
});

describe("unbindAgentEnvironmentAction", () => {
  it("owner: invokes unbind_agent_environment", async () => {
    mockInvoke.mockResolvedValue({ ok: true });
    const res = await unbindAgentEnvironmentAction({
      ...SCOPE,
      agentId: AGENT,
      environmentId: "env_1",
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "unbind_agent_environment",
      { agentId: AGENT, environmentId: "env_1" },
      expect.any(Object),
      { surface: "agent" },
    );
  });

  it("non-manager: role gate rejects", async () => {
    scopeState.canManage = false;
    const res = await unbindAgentEnvironmentAction({
      ...SCOPE,
      agentId: AGENT,
      environmentId: "env_1",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
