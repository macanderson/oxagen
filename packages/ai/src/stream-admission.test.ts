import { describe, expect, it, vi } from "vitest";
import { CREDIT_REASONS } from "@oxagen/billing";
const mocks = vi.hoisted(() => ({ admit: vi.fn(), record: vi.fn() }));
vi.mock("./record-token-usage", () => ({
  admitTokenUsage: mocks.admit,
  recordTokenUsage: mocks.record,
}));
import { streamAgentReply } from "./stream";

describe("real SDK admission boundary", () => {
  it("does not call the provider when prepareStep admission rejects", async () => {
    mocks.admit.mockRejectedValue(new Error("durable admission unavailable"));
    const doStream = vi.fn(async () => {
      throw new Error("provider must not run");
    });
    const result = streamAgentReply({
      model: {
        specificationVersion: "v3",
        provider: "witness",
        modelId: "witness",
        supportedUrls: {},
        doStream,
        doGenerate: async () => {
          throw new Error("not a generation call");
        },
      },
      messages: [{ role: "user", content: "admission witness" }],
      telemetry: {
        orgId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        messageId: "00000000-0000-4000-8000-000000000003",
        surface: "api",
      },
      fundedBy: "platform",
      chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
      maxRetries: 0,
    });
    const errors: unknown[] = [];
    for await (const part of result.fullStream)
      if (part.type === "error") errors.push(part.error);
    expect(mocks.admit).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      expect.objectContaining({ message: "durable admission unavailable" }),
    ]);
    expect(doStream).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
