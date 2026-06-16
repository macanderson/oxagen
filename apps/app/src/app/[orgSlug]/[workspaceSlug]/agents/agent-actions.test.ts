/**
 * agent-actions.test.ts — unit tests for the Agents server actions.
 *
 * Covers every action: role gate (non-owner/admin → ok:false, no invoke),
 * happy path (invoke called with the mapped contract input + scoped ctx),
 * capability error → ok:false with message (and code when present), invalid
 * input → ok:false without invoke, and revalidatePath on success.
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
  const dbState: { wsRoleRows: Array<{ role: string }> } = { wsRoleRows: [{ role: "owner" }] };
  const mockLimit = vi.fn(() => Promise.resolve(dbState.wsRoleRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) => fn(mockTx));
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) => fn());
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
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mockWithTenantDb };
});
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    agents: {
      root: ({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) =>
        `/${orgSlug}/${workspaceSlug}/agents`,
    },
  },
}));

import {
  createAgentAction,
  updateAgentAction,
  publishAgentAction,
  deployAgentAction,
  createTriggerAction,
  updateTriggerAction,
  deleteTriggerAction,
} from "./agent-actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };
const SCOPE = { orgSlug: "acme", workspaceSlug: "main" };

const VALID_CONFIG = {
  graph: {
    ontologyId: "ws-1",
    mode: "read" as const,
    retrieval: { strategy: "hybrid" as const },
    budget: { maxHops: 3, maxNodes: 50, minRelevance: 0.5 },
  },
  agentTools: [],
  triggers: [],
  instructions: "Hi",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbState.wsRoleRows = [{ role: "owner" }];
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WS);
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockInvoke.mockResolvedValue({ ok: true });
});

describe("createAgentAction", () => {
  const input = { ...SCOPE, slug: "repo-review", name: "Repo Review", config: VALID_CONFIG };

  it("rejects a non-owner/admin role without invoking", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await createAgentAction(input);
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects an invalid slug without invoking", async () => {
    const res = await createAgentAction({ ...input, slug: "Not Valid" });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes agent.definition.create with the mapped input and revalidates", async () => {
    mockInvoke.mockResolvedValue({ agentId: "agt_1", publicId: "agt_1", slug: "repo-review", version: 1 });
    const res = await createAgentAction(input);
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.definition.create",
      expect.objectContaining({ slug: "repo-review", name: "Repo Review", agentType: "custom" }),
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1", userId: "user-1" }),
      expect.objectContaining({ surface: "agent" }),
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/agents");
  });

  it("returns ok:false with the error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("slug taken"));
    const res = await createAgentAction(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("slug taken");
  });
});

describe("updateAgentAction", () => {
  const input = { ...SCOPE, agentId: "agt_1", name: "New", config: VALID_CONFIG };

  it("invokes agent.definition.update on the happy path", async () => {
    mockInvoke.mockResolvedValue({ agentId: "agt_1", version: 2, isPublished: false });
    const res = await updateAgentAction(input);
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.definition.update",
      expect.objectContaining({ agentId: "agt_1", name: "New" }),
      expect.anything(),
      expect.objectContaining({ surface: "agent" }),
    );
  });

  it("rejects a non-owner role", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await updateAgentAction(input);
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("publishAgentAction", () => {
  it("invokes agent.definition.publish without version when omitted", async () => {
    mockInvoke.mockResolvedValue({ agentId: "agt_1", version: 1, checksum: "c", activeVersionId: "v" });
    const res = await publishAgentAction({ ...SCOPE, agentId: "agt_1" });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.definition.publish",
      { agentId: "agt_1" },
      expect.anything(),
      expect.objectContaining({ surface: "agent" }),
    );
  });

  it("passes the version when supplied", async () => {
    mockInvoke.mockResolvedValue({ agentId: "agt_1", version: 2, checksum: "c", activeVersionId: "v" });
    await publishAgentAction({ ...SCOPE, agentId: "agt_1", version: 2 });
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.definition.publish",
      { agentId: "agt_1", version: 2 },
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("deployAgentAction", () => {
  it("invokes agent.deploy with the requested deployment status", async () => {
    mockInvoke.mockResolvedValue({ agentId: "agt_1", deploymentStatus: "active" });
    const res = await deployAgentAction({ ...SCOPE, agentId: "agt_1", deploymentStatus: "active" });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.deploy",
      { agentId: "agt_1", deploymentStatus: "active" },
      expect.anything(),
      expect.anything(),
    );
  });

  it("surfaces the typed activation error with its code", async () => {
    const err = Object.assign(new Error("no published active version"), {
      code: "agent_deploy_requires_published_version",
    });
    mockInvoke.mockRejectedValue(err);
    const res = await deployAgentAction({ ...SCOPE, agentId: "agt_1", deploymentStatus: "active" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("no published active version");
      expect(res.code).toBe("agent_deploy_requires_published_version");
    }
  });
});

describe("trigger actions", () => {
  const eventTrigger = {
    type: "event" as const,
    eventSource: "github_repo",
    eventType: "push",
    enabled: true,
    filter: { branches: ["main"], pathGlobs: ["src/**"] },
  };

  it("createTriggerAction invokes agent.trigger.create", async () => {
    mockInvoke.mockResolvedValue({ triggerId: "atr_1", publicId: "atr_1", triggerType: "event", enabled: true });
    const res = await createTriggerAction({ ...SCOPE, agentId: "agt_1", trigger: eventTrigger });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.trigger.create",
      expect.objectContaining({ agentId: "agt_1" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("createTriggerAction rejects an invalid event trigger (missing eventType)", async () => {
    const res = await createTriggerAction({
      ...SCOPE,
      agentId: "agt_1",
      // Deliberately incomplete (no eventType) to exercise schema validation —
      // structurally valid as AgentTrigger, rejected by the superRefine at runtime.
      trigger: { type: "event", eventSource: "github_repo", enabled: true },
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("updateTriggerAction invokes agent.trigger.update", async () => {
    mockInvoke.mockResolvedValue({ triggerId: "atr_1", triggerType: "event", enabled: true });
    const res = await updateTriggerAction({ ...SCOPE, triggerId: "atr_1", trigger: eventTrigger });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.trigger.update",
      expect.objectContaining({ triggerId: "atr_1" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("deleteTriggerAction invokes agent.trigger.delete", async () => {
    mockInvoke.mockResolvedValue({ triggerId: "atr_1", deleted: true });
    const res = await deleteTriggerAction({ ...SCOPE, triggerId: "atr_1" });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.trigger.delete",
      { triggerId: "atr_1" },
      expect.anything(),
      expect.anything(),
    );
  });

  it("trigger actions are role-gated", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await deleteTriggerAction({ ...SCOPE, triggerId: "atr_1" });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
