/**
 * actions.test.ts — unit tests for the newly added Knowledge → Memory server
 * actions: listMemoryCitationsAction (agent.memory_citation.list) and
 * attachMemoryEvidenceAction (agent.memory_evidence.attach).
 *
 * The pre-existing CRUD/promote actions in this file are covered elsewhere
 * (memories-client.test.tsx exercises them through the client); this file
 * scopes to the two capabilities added for the Citations view and Evidence
 * attach panel, following the same mocking pattern as
 * bulk-import-actions.test.ts.
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

import {
  listMemoryCitationsAction,
  attachMemoryEvidenceAction,
  promoteMemoryAction,
  dismissPromotionAction,
  demoteMemoryAction,
  suggestRationalesAction,
} from "./actions";

const BASE = { orgSlug: "oxagen", workspaceSlug: "main" };

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

describe("listMemoryCitationsAction", () => {
  it("rejects a blank execution id without calling invoke", async () => {
    const res = await listMemoryCitationsAction({
      ...BASE,
      executionId: "   ",
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("execution id"),
    });
    expect(mockResolveOrg).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("denies a caller who is not a workspace member", async () => {
    dbState.role = "viewer";
    const res = await listMemoryCitationsAction({
      ...BASE,
      executionId: "exec-1",
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes list_memory_citations with the trimmed id and optional filters", async () => {
    mockInvoke.mockResolvedValue({
      citations: [
        {
          citationId: "cit-1",
          memoryId: "mem-1",
          lesson: "Never push to main.",
          influence: "DECISIVE",
          compliance: "VIOLATION",
          enforcementAtCite: 95,
          expectedValue: "PR opened",
          observedValue: "direct push",
          agentRationale: "Deadline pressure.",
        },
      ],
    });
    const res = await listMemoryCitationsAction({
      ...BASE,
      executionId: "  exec-1  ",
      compliance: "VIOLATION",
      influenceIn: ["DECISIVE", "CONTRIBUTING"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.citations).toHaveLength(1);
      expect(res.citations[0]?.compliance).toBe("VIOLATION");
    }
    const [cap, callInput, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("list_memory_citations");
    expect(callInput).toEqual({
      executionId: "exec-1",
      compliance: "VIOLATION",
      influenceIn: ["DECISIVE", "CONTRIBUTING"],
    });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("omits optional filters from the invoke input when not supplied", async () => {
    mockInvoke.mockResolvedValue({ citations: [] });
    await listMemoryCitationsAction({ ...BASE, executionId: "exec-2" });
    const [, callInput] = mockInvoke.mock.calls[0] ?? [];
    expect(callInput).toEqual({ executionId: "exec-2" });
  });

  it("returns ok:false with the error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    const res = await listMemoryCitationsAction({
      ...BASE,
      executionId: "exec-1",
    });
    expect(res).toEqual({ ok: false, error: "neo4j down" });
  });
});

describe("attachMemoryEvidenceAction", () => {
  const validInput = {
    ...BASE,
    memoryId: "mem-1",
    sourceKind: "HUMAN_CONFIRM" as const,
    strength: 0.6,
  };

  it("rejects a blank memory id without calling invoke", async () => {
    const res = await attachMemoryEvidenceAction({
      ...validInput,
      memoryId: "  ",
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("memory"),
    });
    expect(mockResolveOrg).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects a strength outside 0-1 without calling invoke", async () => {
    const res = await attachMemoryEvidenceAction({
      ...validInput,
      strength: 1.5,
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("between 0 and 1"),
    });
    expect(mockResolveOrg).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("denies a caller who is not a workspace member", async () => {
    dbState.role = "";
    const res = await attachMemoryEvidenceAction(validInput);
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes attach_memory_evidence, revalidates the list, and returns the new score", async () => {
    mockInvoke.mockResolvedValue({ evidenceId: "ev-1", confidenceScore: 72 });
    const res = await attachMemoryEvidenceAction({
      ...validInput,
      detail: "  Confirmed by a human reviewer.  ",
      refutes: false,
    });
    expect(res).toEqual({ ok: true, evidenceId: "ev-1", confidenceScore: 72 });
    const [cap, callInput, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("attach_memory_evidence");
    expect(callInput).toEqual({
      memoryId: "mem-1",
      sourceKind: "HUMAN_CONFIRM",
      strength: 0.6,
      detail: "Confirmed by a human reviewer.",
      refutes: false,
    });
    expect(opts).toEqual({ surface: "agent" });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/oxagen/main/knowledge/memory",
    );
  });

  it("omits detail from the invoke input when blank", async () => {
    mockInvoke.mockResolvedValue({ evidenceId: "ev-2", confidenceScore: 40 });
    await attachMemoryEvidenceAction({ ...validInput, detail: "   " });
    const [, callInput] = mockInvoke.mock.calls[0] ?? [];
    expect(callInput).toEqual({
      memoryId: "mem-1",
      sourceKind: "HUMAN_CONFIRM",
      strength: 0.6,
      refutes: false,
    });
  });

  it("returns ok:false when invoke throws and does not revalidate", async () => {
    mockInvoke.mockRejectedValue(new Error("write failed"));
    const res = await attachMemoryEvidenceAction(validInput);
    expect(res).toEqual({ ok: false, error: "write failed" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("promoteMemoryAction", () => {
  const promoteInput = {
    ...BASE,
    memoryId: "mem-1",
    toClass: "FACT" as const,
    enforcementScore: 80,
    rationale: "Confirmed by two independent runs",
    basedOnEvidenceIds: ["ev-1", "ev-2"],
  };

  it("denies a caller who is not a workspace member (never invokes promote_memory)", async () => {
    dbState.role = "viewer";
    const res = await promoteMemoryAction(promoteInput);
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("invokes promote_memory with the full input, revalidates, and returns the promoted memory", async () => {
    const promoted = { id: "mem-1", memoryClass: "FACT" };
    mockInvoke.mockResolvedValue(promoted);
    const res = await promoteMemoryAction(promoteInput);
    expect(mockInvoke).toHaveBeenCalledWith(
      "promote_memory",
      {
        memoryId: "mem-1",
        toClass: "FACT",
        enforcementScore: 80,
        rationale: "Confirmed by two independent runs",
        basedOnEvidenceIds: ["ev-1", "ev-2"],
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/oxagen/main/knowledge/memory",
    );
    expect(res).toEqual({ ok: true, memory: promoted });
  });

  it("omits enforcementScore and basedOnEvidenceIds from the invoke input when not supplied", async () => {
    mockInvoke.mockResolvedValue({ id: "mem-1" });
    await promoteMemoryAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "RULE",
      rationale: "Recurring preference",
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "promote_memory",
      { memoryId: "mem-1", toClass: "RULE", rationale: "Recurring preference" },
      expect.any(Object),
      { surface: "agent" },
    );
  });

  it("returns ok:false when invoke throws and does not revalidate (FACT promotion never silently applies)", async () => {
    mockInvoke.mockRejectedValue(new Error("promotion rejected"));
    const res = await promoteMemoryAction(promoteInput);
    expect(res).toEqual({ ok: false, error: "promotion rejected" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("omits rationale from the invoke input entirely when not supplied (rationale is optional)", async () => {
    mockInvoke.mockResolvedValue({ id: "mem-1" });
    await promoteMemoryAction({ ...BASE, memoryId: "mem-1", toClass: "RULE" });
    expect(mockInvoke).toHaveBeenCalledWith(
      "promote_memory",
      { memoryId: "mem-1", toClass: "RULE" },
      expect.any(Object),
      { surface: "agent" },
    );
  });

  it("omits rationale when it is blank after trimming", async () => {
    mockInvoke.mockResolvedValue({ id: "mem-1" });
    await promoteMemoryAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "RULE",
      rationale: "   ",
    });
    const [, callInput] = mockInvoke.mock.calls[0] ?? [];
    expect(callInput).toEqual({ memoryId: "mem-1", toClass: "RULE" });
  });
});

describe("dismissPromotionAction", () => {
  it("denies a caller who is not a workspace member", async () => {
    dbState.role = "viewer";
    const res = await dismissPromotionAction({ ...BASE, memoryId: "mem-1" });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes dismiss_memory_promotion, revalidates, and returns the dismissed flag", async () => {
    mockInvoke.mockResolvedValue({ memoryId: "mem-1", dismissed: true });
    const res = await dismissPromotionAction({ ...BASE, memoryId: "mem-1" });
    expect(mockInvoke).toHaveBeenCalledWith(
      "dismiss_memory_promotion",
      { memoryId: "mem-1" },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/oxagen/main/knowledge/memory",
    );
    expect(res).toEqual({ ok: true, memoryId: "mem-1", dismissed: true });
  });

  it("passes restore:true through to the invoke input when undoing a dismissal", async () => {
    mockInvoke.mockResolvedValue({ memoryId: "mem-1", dismissed: false });
    const res = await dismissPromotionAction({
      ...BASE,
      memoryId: "mem-1",
      restore: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "dismiss_memory_promotion",
      { memoryId: "mem-1", restore: true },
      expect.any(Object),
      { surface: "agent" },
    );
    expect(res).toEqual({ ok: true, memoryId: "mem-1", dismissed: false });
  });

  it("returns ok:false when invoke throws and does not revalidate", async () => {
    mockInvoke.mockRejectedValue(new Error("dismiss failed"));
    const res = await dismissPromotionAction({ ...BASE, memoryId: "mem-1" });
    expect(res).toEqual({ ok: false, error: "dismiss failed" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("demoteMemoryAction", () => {
  it("denies a caller who is not a workspace member (never invokes demote_memory)", async () => {
    dbState.role = "viewer";
    const res = await demoteMemoryAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "OBSERVATION",
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes demote_memory with enforcement + rationale for a RULE target, and revalidates", async () => {
    const demoted = { id: "mem-1", memoryClass: "RULE" };
    mockInvoke.mockResolvedValue(demoted);
    const res = await demoteMemoryAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "RULE",
      enforcementScore: 40,
      rationale: "No longer holds broadly.",
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "demote_memory",
      {
        memoryId: "mem-1",
        toClass: "RULE",
        enforcementScore: 40,
        rationale: "No longer holds broadly.",
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/oxagen/main/knowledge/memory",
    );
    expect(res).toEqual({ ok: true, memory: demoted });
  });

  it("omits enforcementScore for an OBSERVATION target even if supplied", async () => {
    mockInvoke.mockResolvedValue({ id: "mem-1", memoryClass: "OBSERVATION" });
    await demoteMemoryAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "OBSERVATION",
      enforcementScore: 40,
    });
    const [, callInput] = mockInvoke.mock.calls[0] ?? [];
    expect(callInput).toEqual({ memoryId: "mem-1", toClass: "OBSERVATION" });
  });

  it("omits rationale when not supplied", async () => {
    mockInvoke.mockResolvedValue({ id: "mem-1" });
    await demoteMemoryAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "OBSERVATION",
    });
    const [, callInput] = mockInvoke.mock.calls[0] ?? [];
    expect(callInput).toEqual({ memoryId: "mem-1", toClass: "OBSERVATION" });
  });

  it("returns ok:false when invoke throws and does not revalidate", async () => {
    mockInvoke.mockRejectedValue(new Error("demotion rejected"));
    const res = await demoteMemoryAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "OBSERVATION",
    });
    expect(res).toEqual({ ok: false, error: "demotion rejected" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("suggestRationalesAction", () => {
  it("denies a caller who is not a workspace member", async () => {
    dbState.role = "";
    const res = await suggestRationalesAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "RULE",
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("workspace member"),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes suggest_promotion_rationales and does not revalidate (read-only)", async () => {
    mockInvoke.mockResolvedValue({
      rationales: ["Cited five times.", "Consistent across sessions."],
    });
    const res = await suggestRationalesAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "FACT",
      count: 3,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "suggest_promotion_rationales",
      { memoryId: "mem-1", toClass: "FACT", count: 3 },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      rationales: ["Cited five times.", "Consistent across sessions."],
    });
  });

  it("omits count from the invoke input when not supplied", async () => {
    mockInvoke.mockResolvedValue({ rationales: ["A reason."] });
    await suggestRationalesAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "OBSERVATION",
    });
    const [, callInput] = mockInvoke.mock.calls[0] ?? [];
    expect(callInput).toEqual({ memoryId: "mem-1", toClass: "OBSERVATION" });
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("ai gateway down"));
    const res = await suggestRationalesAction({
      ...BASE,
      memoryId: "mem-1",
      toClass: "RULE",
    });
    expect(res).toEqual({ ok: false, error: "ai gateway down" });
  });
});
