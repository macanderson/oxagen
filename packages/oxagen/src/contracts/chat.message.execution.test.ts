import { describe, it, expect } from "vitest";
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
