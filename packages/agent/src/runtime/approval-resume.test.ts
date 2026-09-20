import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { z } from "zod";

const h = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  invoke: vi.fn(),
  roles: vi.fn(),
  tools: vi.fn(),
  budgets: vi.fn(),
  gate: vi.fn(),
  kill: vi.fn(),
  open: vi.fn(),
  seal: vi.fn(),
  started: vi.fn(),
  receipt: vi.fn(),
  schema: undefined as unknown,
}));
type Predicate = (row: Record<string, unknown>) => boolean;
vi.mock("drizzle-orm", () => ({
  eq: (key: string, value: unknown) => (row: Record<string, unknown>) =>
    row[key] === value,
  gt: (key: string, value: Date) => (row: Record<string, unknown>) =>
    (row[key] as Date) > value,
  lt: (key: string, value: Date) => (row: Record<string, unknown>) =>
    (row[key] as Date) < value,
  inArray: (key: string, values: unknown[]) => (row: Record<string, unknown>) =>
    values.includes(row[key]),
  isNull: (key: string) => (row: Record<string, unknown>) => row[key] == null,
  isNotNull: (key: string) => (row: Record<string, unknown>) =>
    row[key] != null,
  and:
    (...predicates: Predicate[]) =>
    (row: Record<string, unknown>) =>
      predicates.every((p) => p(row)),
  or:
    (...predicates: Predicate[]) =>
    (row: Record<string, unknown>) =>
      predicates.some((p) => p(row)),
}));
vi.mock("@oxagen/database", () => {
  const columns = new Proxy({}, { get: (_, key) => String(key) });
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: Predicate) => {
          const matched = predicate(h.row);
          if (matched) Object.assign(h.row, values);
          return Object.assign(Promise.resolve(), {
            returning: async () => (matched ? [{ ...h.row }] : []),
          });
        },
      }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ for: async () => [{ settings: {} }] }) }),
    }),
  };
  return {
    schema: { approvalRequests: columns, workspaces: columns },
    withTenantDb: async (fn: (arg: typeof tx) => unknown) => fn(tx),
    withSystemDb: async (fn: (arg: typeof tx) => unknown) => fn(tx),
  };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/iam", () => ({ bootstrapIAMRuntime: vi.fn() }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRoles: h.roles,
  resolveActorWorkspaceRoles: h.roles,
}));
vi.mock("@oxagen/billing", () => ({
  bootstrapBillingRuntime: vi.fn(),
  getSpendBudgetStatuses: h.budgets,
}));
vi.mock("@oxagen/plugins", () => ({ bootstrapEntitlementRuntime: vi.fn() }));
vi.mock("@oxagen/rules", async () => {
  const { createHash } = await import("node:crypto");
  return {
    DecisionRuleDeniedError: class extends Error {},
    DecisionRuleApprovalRequiredError: class extends Error {},
    bootstrapDecisionRulesRuntime: vi.fn(),
    createDecisionRulesGate: () => h.gate,
    inputDigest: (input: unknown) =>
      createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    ruleSetSchema: { parse: (input: unknown) => input },
  };
});
vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: class extends Error {},
  getCapability: () => ({
    name: "write_test",
    mode: h.row.mode ?? "sync",
    input: h.schema,
  }),
  invoke: h.invoke,
}));
vi.mock("./materialize-tools", () => ({ materializeTools: h.tools }));
vi.mock("./kill-switch-gate", () => ({
  createKillSwitchGate: () => ({ check: h.kill }),
}));
vi.mock("./assistant-run", () => ({ openAssistantRun: h.open }));

import { resumeApprovedCall } from "./approval-resume";
import {
  decryptApprovalResume,
  encryptApprovalResume,
  type ApprovalResumePayload,
} from "./approval-resume-payload";
const ref = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "10000000-0000-4000-8000-000000000002",
  workspaceId: "10000000-0000-4000-8000-000000000003",
};
const payload: ApprovalResumePayload = {
  version: 1,
  orgId: ref.orgId,
  workspaceId: ref.workspaceId,
  requesterUserId: "10000000-0000-4000-8000-000000000004",
  messageId: "10000000-0000-4000-8000-000000000005",
  capabilityName: "write_test",
  rawInput: { secret: "exact stored secret" },
  validatedDigest: createHash("sha256")
    .update(JSON.stringify({ secret: "exact stored secret", count: 1 }))
    .digest("hex"),
  riskLevel: "high",
};

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv(
    "AUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 17).toString("base64"),
  );
  h.schema = z.object({ secret: z.string(), count: z.number().default(1) });
  h.row = {
    ...ref,
    publicId: "apr_test",
    resolution: "approved",
    resumeStatus: "queued",
    resumePayload: await encryptApprovalResume(payload),
    capabilityName: payload.capabilityName,
    messageId: payload.messageId,
    inputDigest: payload.validatedDigest,
    runPublicId: "arun_original",
    expiresAt: new Date(Date.now() + 60_000),
    resumeStartedAt: null,
  };
  h.roles.mockResolvedValue(["Member"]);
  h.budgets.mockResolvedValue([]);
  h.tools.mockResolvedValue({ nameMap: { write_test: "write_test" } });
  h.kill.mockResolvedValue(null);
  h.open.mockResolvedValue({
    runId: "new-run",
    runPublicId: "arun_resumed",
    toolCallStarted: h.started,
    toolCall: h.receipt,
    seal: h.seal,
  });
});

describe("approved call resumption", () => {
  it("encrypts exact inputs and dispatches one claimed attempt under the original human", async () => {
    expect(JSON.stringify(h.row.resumePayload)).not.toContain(
      "exact stored secret",
    );
    expect((await decryptApprovalResume(h.row.resumePayload)).rawInput).toEqual(
      payload.rawInput,
    );
    expect(
      await Promise.all([resumeApprovedCall(ref), resumeApprovedCall(ref)]),
    ).toContain("succeeded");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith(
      "write_test",
      payload.rawInput,
      expect.objectContaining({
        userId: payload.requesterUserId,
        apiKeyId: null,
        messageId: payload.messageId,
      }),
      {
        surface: "agent",
        runId: "new-run",
        assertValidatedInput: expect.any(Function),
      },
    );
    expect(h.open.mock.calls[0]?.[0].instruction).toContain("arun_original");
    expect(h.row.resumeRunPublicId).toBe("arun_resumed");
    expect(JSON.stringify(h.started.mock.calls)).not.toContain(
      "exact stored secret",
    );
    expect(await resumeApprovedCall(ref)).toBe("not_claimed");
  });
  it.each(["denied", "expired"])(
    "does not execute a %s decision",
    async (resolution) => {
      h.row.resolution = resolution;
      expect(await resumeApprovedCall(ref)).toBe("not_claimed");
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );
  it("refuses revoked membership", async () => {
    h.roles.mockResolvedValue([]);
    expect(await resumeApprovedCall(ref)).toBe("failed");
    expect(h.row.resumeError).toBe("requester_access_revoked");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each(["tool", "budget", "rules", "kill"])(
    "rechecks fresh %s admission",
    async (kind) => {
      if (kind === "tool") h.tools.mockResolvedValue({ nameMap: {} });
      if (kind === "budget")
        h.budgets.mockResolvedValue([
          { budget: { enabled: true }, overLimit: true },
        ]);
      if (kind === "rules") h.gate.mockRejectedValue(new Error("new refusal"));
      if (kind === "kill") h.kill.mockResolvedValue({ reason: "workspace" });
      expect(await resumeApprovedCall(ref)).toBe("failed");
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );
  it("refuses changed validated defaults", async () => {
    h.schema = z.object({ secret: z.string(), count: z.number().default(2) });
    expect(await resumeApprovedCall(ref)).toBe("failed");
    expect(h.row.resumeError).toBe("input_schema_changed");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("rejects ciphertext copied from another workspace", async () => {
    h.row.resumePayload = await encryptApprovalResume({
      ...payload,
      workspaceId: payload.orgId,
    });
    expect(await resumeApprovedCall(ref)).toBe("failed");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("leaves an interrupted attempt indeterminate without retrying", async () => {
    h.row.resumeStatus = "running";
    h.row.resumeStartedAt = new Date(Date.now() - 16 * 60_000);
    expect(await resumeApprovedCall(ref)).toBe("not_claimed");
    expect(h.row.resumeStatus).toBe("indeterminate");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("does not retry an invocation whose external outcome is unknown", async () => {
    h.invoke.mockRejectedValue(new Error("connection lost after effect"));
    expect(await resumeApprovedCall(ref)).toBe("indeterminate");
    expect(await resumeApprovedCall(ref)).toBe("not_claimed");
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("does not invoke twice if sealing fails after the external call", async () => {
    h.seal.mockRejectedValue(new Error("ledger unavailable"));
    await expect(resumeApprovedCall(ref)).rejects.toThrow("ledger unavailable");
    expect(await resumeApprovedCall(ref)).toBe("not_claimed");
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("reports async dispatch without claiming external completion", async () => {
    h.row.mode = "async";
    expect(await resumeApprovedCall(ref)).toBe("dispatched");
    expect(h.receipt).toHaveBeenCalledWith(
      expect.objectContaining({ output: { status: "dispatched" } }),
    );
  });
  it("expires a queued approval before invocation", async () => {
    h.row.expiresAt = new Date(Date.now() - 1000);
    expect(await resumeApprovedCall(ref)).toBe("not_claimed");
    expect(h.row.resumeStatus).toBe("expired");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("refuses when encryption configuration is absent", async () => {
    vi.stubEnv("AUTH_TOKEN_ENCRYPTION_KEY", "");
    await expect(encryptApprovalResume(payload)).rejects.toMatchObject({
      reason: "encryption_key_missing",
    });
    expect(await resumeApprovedCall(ref)).toBe("failed");
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
