// The model client triage runs with (P1-03, #5103): the workspace's fast model
// through @oxagen/ai, charged as in-app assistant spend, held to the
// workspace's daily budget for work orders first (#5426), and an answer that
// does not parse counted as an invalid output rather than an outage.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModelForOrg: vi.fn(),
  assertUnderWorkspaceLaneBudget: vi.fn(),
}));
vi.mock("@oxagen/ai", () => ({
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  generateObjectFor: mocks.generateObjectFor,
  modelIdOf: (model: { id: string }) => model.id,
  selectModelForOrg: mocks.selectModelForOrg,
}));
// The budget gate reads Postgres inside the tenant scope. Here it answers
// without one, so the test proves the client's order and not the gate.
vi.mock("@oxagen/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/billing")>()),
  assertUnderWorkspaceLaneBudget: mocks.assertUnderWorkspaceLaneBudget,
}));

const { aiTriageModelClient, triageOutputSchema } = await import("./triage-run");

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
  mocks.assertUnderWorkspaceLaneBudget.mockReset();
  mocks.selectModelForOrg.mockResolvedValue({ model: { id: "fast-model" }, fundedBy: "platform" });
  mocks.assertUnderWorkspaceLaneBudget.mockResolvedValue(undefined);
});

describe("aiTriageModelClient", () => {
  it("asks the fast tier, charges assistant tokens, names the lane, and leaves the cost unknown", async () => {
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
        // `capabilityName` names the lane on the usage row, because a durable
        // job's call has no capability in scope (#5426).
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

  it("holds the call to the workspace's work-order budget before choosing a model", async () => {
    const order: string[] = [];
    mocks.assertUnderWorkspaceLaneBudget.mockImplementation(async () => {
      order.push("budget");
    });
    mocks.selectModelForOrg.mockImplementation(async () => {
      order.push("model");
      return { model: { id: "fast-model" }, fundedBy: "platform" };
    });
    mocks.generateObjectFor.mockResolvedValue({ object: { schema: "triage/v1" }, usage: {} });
    await aiTriageModelClient(scope).complete(request);
    expect(mocks.assertUnderWorkspaceLaneBudget).toHaveBeenCalledWith({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      lane: "work",
    });
    expect(order).toEqual(["budget", "model"]);
  });

  it("passes a spent budget through untouched, so the durable step records the reason", async () => {
    const spent = new Error("The workspace's daily budget for work orders is spent");
    spent.name = "WorkspaceBudgetSpentError";
    mocks.assertUnderWorkspaceLaneBudget.mockRejectedValue(spent);
    await expect(aiTriageModelClient(scope).complete(request)).rejects.toBe(spent);
    expect(mocks.selectModelForOrg).not.toHaveBeenCalled();
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
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
