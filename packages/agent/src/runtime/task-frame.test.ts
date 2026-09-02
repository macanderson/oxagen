/**
 * Unit tests for task-frame.ts — builds a TaskFrame from CapabilityContext
 * and message history for the Engram context compiler.
 *
 * No external dependencies: all imports are type-only so no mocks are needed.
 */
import { describe, expect, it } from "vitest";
import { buildTaskFrame } from "./task-frame";
import type { CapabilityContext } from "../types";

const BASE_CTX: CapabilityContext = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner",
  messageId: null,
};

describe("buildTaskFrame — namespace", () => {
  it("maps orgId and workspaceId into namespace", () => {
    const frame = buildTaskFrame(BASE_CTX, []);
    expect(frame.namespace).toEqual({ org: "org_test", workspace: "ws_test" });
  });

  it("reflects different orgId / workspaceId values", () => {
    const frame = buildTaskFrame(
      { ...BASE_CTX, orgId: "org_2", workspaceId: "ws_2" },
      [],
    );
    expect(frame.namespace.org).toBe("org_2");
    expect(frame.namespace.workspace).toBe("ws_2");
  });
});

describe("buildTaskFrame — fixed fields", () => {
  it("modelId is always 'default'", () => {
    expect(buildTaskFrame(BASE_CTX, []).modelId).toBe("default");
  });

  it("recentEventIds is always an empty array", () => {
    const frame = buildTaskFrame(BASE_CTX, [
      { role: "user", content: "hello" },
    ]);
    expect(frame.recentEventIds).toEqual([]);
  });

  it("workingSet is always an empty array", () => {
    expect(buildTaskFrame(BASE_CTX, []).workingSet).toEqual([]);
  });

  it("agentId is always undefined", () => {
    expect(buildTaskFrame(BASE_CTX, []).agentId).toBeUndefined();
  });
});

describe("buildTaskFrame — sessionId", () => {
  it("sessionId is undefined when messageId is null", () => {
    const frame = buildTaskFrame({ ...BASE_CTX, messageId: null }, []);
    expect(frame.sessionId).toBeUndefined();
  });

  it("sessionId equals messageId when messageId is set", () => {
    const frame = buildTaskFrame({ ...BASE_CTX, messageId: "msg_abc" }, []);
    expect(frame.sessionId).toBe("msg_abc");
  });
});

describe("buildTaskFrame — taskDescription (extractTaskDescription)", () => {
  it("returns empty string when messages array is empty", () => {
    expect(buildTaskFrame(BASE_CTX, []).taskDescription).toBe("");
  });

  it("returns empty string when there are no user messages", () => {
    const messages = [{ role: "assistant", content: "I can help you." }];
    expect(buildTaskFrame(BASE_CTX, messages).taskDescription).toBe("");
  });

  it("returns content of a single user message", () => {
    const messages = [
      { role: "user", content: "what is the capital of France?" },
    ];
    expect(buildTaskFrame(BASE_CTX, messages).taskDescription).toBe(
      "what is the capital of France?",
    );
  });

  it("returns the LAST user message, not the first", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ];
    expect(buildTaskFrame(BASE_CTX, messages).taskDescription).toBe(
      "second question",
    );
  });

  it("skips trailing assistant messages and finds the last user message", () => {
    const messages = [
      { role: "user", content: "user turn" },
      { role: "assistant", content: "assistant turn" },
    ];
    expect(buildTaskFrame(BASE_CTX, messages).taskDescription).toBe(
      "user turn",
    );
  });

  it("handles interleaved roles and returns the last user message", () => {
    const messages = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ];
    expect(buildTaskFrame(BASE_CTX, messages).taskDescription).toBe("q3");
  });

  it("truncates content at 2000 characters", () => {
    const longContent = "x".repeat(3000);
    const frame = buildTaskFrame(BASE_CTX, [
      { role: "user", content: longContent },
    ]);
    expect(frame.taskDescription).toHaveLength(2000);
    expect(frame.taskDescription).toBe("x".repeat(2000));
  });

  it("does not truncate content shorter than 2000 chars", () => {
    const content = "short message with some words";
    const frame = buildTaskFrame(BASE_CTX, [{ role: "user", content }]);
    expect(frame.taskDescription).toBe(content);
  });

  it("handles content of exactly 2000 characters without truncation", () => {
    const content = "y".repeat(2000);
    const frame = buildTaskFrame(BASE_CTX, [{ role: "user", content }]);
    expect(frame.taskDescription).toBe(content);
    expect(frame.taskDescription).toHaveLength(2000);
  });
});
