import { afterEach, describe, it, expect, vi } from "vitest";
import { chatMessageExecution } from "./chat.message.execution";
import { getCapability } from "../registry";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

const validInput = {
  agentId: VALID_UUID,
  agentVersionId: VALID_UUID,
  originType: "chat" as const,
  originId: VALID_UUID,
  messageId: VALID_UUID,
  status: "completed" as const,
  inputPayload: { prompt: "Hello" },
};

describe("chat.message.execution capability", () => {
  it("is registered", () => {
    expect(getCapability("get_message_execution")).toBeDefined();
  });

  it("parses a valid input", () => {
    expect(() => chatMessageExecution.input.parse(validInput)).not.toThrow();
  });

  it("rejects originType other than 'chat'", () => {
    expect(() =>
      chatMessageExecution.input.parse({
        ...validInput,
        originType: "workflow_run",
      }),
    ).toThrow();
  });

  it("rejects a non-UUID messageId", () => {
    expect(() =>
      chatMessageExecution.input.parse({
        ...validInput,
        messageId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("defaults updateMessageMetadata to true when omitted", () => {
    const result = chatMessageExecution.input.parse(validInput);
    expect(result.updateMessageMetadata).toBe(true);
  });

  it("accepts updateMessageMetadata: false explicitly", () => {
    const result = chatMessageExecution.input.parse({
      ...validInput,
      updateMessageMetadata: false,
    });
    expect(result.updateMessageMetadata).toBe(false);
  });

  it("parses a valid output", () => {
    expect(() =>
      chatMessageExecution.output.parse({
        executionId: VALID_UUID,
        status: "completed",
        createdAt: new Date(),
      }),
    ).not.toThrow();
  });

  it("rejects output missing executionId", () => {
    expect(() =>
      chatMessageExecution.output.parse({
        status: "completed",
        createdAt: new Date(),
      }),
    ).toThrow();
  });

  it("is exposed on api and mcp surfaces only", () => {
    const cap = getCapability("get_message_execution");
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.surfaces).not.toContain("agent");
  });

  it("has defaultEffect of 'allow'", () => {
    expect(chatMessageExecution.defaultEffect).toBe("allow");
  });
});

/**
 * Recording an execution is the platform writing its own audit trail. It runs
 * after the work it describes, spends no model tokens, and must not be the
 * thing that fails when an org's balance does.
 *
 * These drive the real kernel against the real registry entry rather than
 * reading the flag back off the contract: the flag is only worth anything if
 * `invoke()` honours it, and the flag and the kernel's skip predicate are two
 * separate pieces of code that a refactor can part.
 */
describe("chat.message.execution is bookkeeping, not a governed action", () => {
  const ORG = "00000000-0000-0000-0000-0000000000a1";
  const WS = "00000000-0000-0000-0000-0000000000a2";
  const ctx = {
    orgId: ORG,
    workspaceId: WS,
    userId: "u",
    apiKeyId: null,
    requestId: "req-exec",
    surface: "api" as const,
    messageId: null,
  };
  const output = {
    executionId: VALID_UUID,
    status: "completed",
    createdAt: new Date(),
  };

  afterEach(async () => {
    const k = await import("../kernel");
    k.clearBillingAdmissionGate();
    k.clearUsageRecorder();
    k.clearHandlersForTests();
  });

  it("declares noBillingGate", () => {
    expect(
      (chatMessageExecution as { noBillingGate?: boolean }).noBillingGate,
    ).toBe(true);
  });

  it("is still recorded when the org has no credit left", async () => {
    const k = await import("../kernel");
    const gate = vi.fn(async () => {
      throw new Error("insufficient credits");
    });
    k.setBillingAdmissionGate(gate);
    k.registerHandler(
      chatMessageExecution.name,
      async () => async () => output,
    );

    // Top-level, the way the assistant turn reaches it: `prepared.run()` runs
    // under `runOutsideGovernedAction`, so this invoke has no enclosing frame.
    await expect(
      k.runOutsideGovernedAction(() =>
        k.invoke(chatMessageExecution.name, validInput, ctx, {
          surface: "api",
        }),
      ),
    ).resolves.toMatchObject({ executionId: VALID_UUID });
    // The gate refusing here is the one path that makes `list_executions` and
    // `get_execution_trace` answer "nothing happened" for a turn that did.
    expect(gate).not.toHaveBeenCalled();
  });

  it("accrues no governed action for the platform's own audit write", async () => {
    const k = await import("../kernel");
    const recorder = vi.fn();
    k.setUsageRecorder(recorder);
    k.registerHandler(
      chatMessageExecution.name,
      async () => async () => output,
    );

    await k.runOutsideGovernedAction(() =>
      k.invoke(chatMessageExecution.name, validInput, ctx, { surface: "api" }),
    );

    // The turn's tool calls are the governed actions (ADR-053 §1). Charging a
    // GAU for the receipt written afterwards bills the customer for our record.
    expect(recorder).not.toHaveBeenCalled();
  });
});
