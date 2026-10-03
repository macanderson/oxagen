// The model client triage runs with (P1-03, #5103): the workspace's fast model
// through @oxagen/ai, charged as in-app assistant spend, and an answer that
// does not parse counted as an invalid output rather than an outage. Before
// any of that it checks the workspace's own daily budget for work orders
// (#5426).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModelForOrg: vi.fn(),
  laneBudget: vi.fn(),
}));
vi.mock("@oxagen/ai", () => ({
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  generateObjectFor: mocks.generateObjectFor,
  modelIdOf: (model: { id: string }) => model.id,
  selectModelForOrg: mocks.selectModelForOrg,
}));
// The lane gate is replaced, so each case says what the budget answers. The
// real gate would read the database, find no tenant scope, and fail open.
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return { ...real, assertUnderWorkspaceLaneBudget: mocks.laneBudget };
});

const { aiTriageModelClient, triageOutputSchema } = await import("./triage-run");
const { WorkspaceBudgetSpentError } = await import("@oxagen/billing");

const scope = { orgId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002" };
const request = { system: "rules", prompt: "<triage-input>{}</triage-input>", schema: {} };

function named(name: string): Error {
  const error = new Error("parse");
  error.name = name;
  return error;
}

beforeEach(() => {
  mocks.generateObjectFor.mockReset();
  mocks.selectModelForOrg.mockReset();
  mocks.selectModelForOrg.mockResolvedValue({ model: { id: "fast-model" }, fundedBy: "platform" });
  mocks.laneBudget.mockReset();
  mocks.laneBudget.mockResolvedValue(undefined);
});

describe("aiTriageModelClient", () => {
  it("asks the fast tier, charges assistant tokens, and leaves the cost unknown", async () => {
    mocks.generateObjectFor.mockResolvedValue({ object: { schema: "triage/v1" }, usage: {} });
    const response = await aiTriageModelClient(scope).complete(request);
    expect(response).toEqual({ output: { schema: "triage/v1" }, model: "fast-model", costUsd: null });
    expect(mocks.selectModelForOrg).toHaveBeenCalledWith(scope.orgId, { tier: "fast" });
    expect(mocks.generateObjectFor).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeReason: "consume_assistant_tokens",
        fundedBy: "platform",
        schema: triageOutputSchema,
        system: "rules",
        prompt: request.prompt,
        maxRetries: 0,
        telemetry: {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          surface: "runner",
          messageId: null,
          capabilityName: "work_triage",
        },
      }),
    );
  });

  it("answers no output when the model's answer does not parse", async () => {
    mocks.generateObjectFor.mockRejectedValue(named("AI_NoObjectGeneratedError"));
    expect(await aiTriageModelClient(scope).complete(request)).toEqual({ output: null, model: "fast-model", costUsd: null });
  });

  it("passes any other error through, so the durable step retries", async () => {
    mocks.generateObjectFor.mockRejectedValue(new Error("credit admission refused"));
    await expect(aiTriageModelClient(scope).complete(request)).rejects.toThrow("credit admission refused");
  });
});

// #5426: work orders spend on their own lane. The gate runs before a model is
// chosen, so a spent lane costs nothing more.
describe("aiTriageModelClient and the work lane's daily budget", () => {
  it("checks the work lane for the item's workspace before it picks a model", async () => {
    mocks.generateObjectFor.mockResolvedValue({ object: { schema: "triage/v1" }, usage: {} });
    await aiTriageModelClient(scope).complete(request);
    expect(mocks.laneBudget).toHaveBeenCalledTimes(1);
    expect(mocks.laneBudget).toHaveBeenCalledWith({ orgId: scope.orgId, workspaceId: scope.workspaceId, lane: "work" });
    const gateOrder = mocks.laneBudget.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const pickOrder = mocks.selectModelForOrg.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(gateOrder).toBeLessThan(pickOrder);
  });

  it("refuses once the work lane is spent, in words a person can read, and calls no model (negative)", async () => {
    mocks.laneBudget.mockRejectedValue(new WorkspaceBudgetSpentError("work", 1, 1.25));
    const refusal = aiTriageModelClient(scope).complete(request);
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceBudgetSpentError);
    await expect(refusal).rejects.toMatchObject({ code: "workspace_budget_spent", lane: "work", budgetUsd: 1, spentUsd: 1.25 });
    await expect(refusal).rejects.toThrow(/daily budget for work orders is spent: \$1\.25 of \$1\.00 today\. It resets at 00:00 UTC\./);
    expect(mocks.selectModelForOrg).not.toHaveBeenCalled();
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });
});
