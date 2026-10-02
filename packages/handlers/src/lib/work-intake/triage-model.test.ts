// The model client triage runs with (P1-03, #5103): the workspace's fast model
// through @oxagen/ai, charged as in-app assistant spend, and an answer that
// does not parse counted as an invalid output rather than an outage.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModelForOrg: vi.fn(),
}));
vi.mock("@oxagen/ai", () => ({
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  generateObjectFor: mocks.generateObjectFor,
  modelIdOf: (model: { id: string }) => model.id,
  selectModelForOrg: mocks.selectModelForOrg,
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
  mocks.selectModelForOrg.mockResolvedValue({ model: { id: "fast-model" }, fundedBy: "platform" });
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
        telemetry: { orgId: scope.orgId, workspaceId: scope.workspaceId, surface: "runner", messageId: null },
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
