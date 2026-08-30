import { describe, expect, it } from "vitest";
import {
  A2A_ERROR,
  A2A_METHODS,
  A2A_TASK_STATES,
  A2A_TERMINAL_STATES,
  a2aArtifactUpdateEvent,
  a2aMessage,
  a2aMessageSendParams,
  a2aStatusUpdateEvent,
  a2aTask,
  a2aTaskState,
  getSkillId,
  jsonRpcError,
  jsonRpcRequest,
  jsonRpcResult,
} from "./protocol";

describe("A2A protocol wire types", () => {
  it("accepts the concrete JSON-RPC method names", () => {
    expect(A2A_METHODS.messageSend).toBe("message/send");
    expect(A2A_METHODS.messageStream).toBe("message/stream");
    expect(A2A_METHODS.tasksGet).toBe("tasks/get");
    expect(A2A_METHODS.tasksCancel).toBe("tasks/cancel");
    expect(A2A_METHODS.tasksResubscribe).toBe("tasks/resubscribe");
    expect(A2A_METHODS.authExtendedCard).toBe(
      "agent/getAuthenticatedExtendedCard",
    );
  });

  it("uses lowercase task-state wire strings and marks terminal states", () => {
    expect(a2aTaskState.parse("input-required")).toBe("input-required");
    expect(A2A_TASK_STATES).toContain("submitted");
    for (const s of ["completed", "canceled", "failed", "rejected"] as const) {
      expect(A2A_TERMINAL_STATES.has(s)).toBe(true);
    }
    expect(A2A_TERMINAL_STATES.has("working")).toBe(false);
  });

  it("parses a text-part message with the kind discriminator", () => {
    const msg = a2aMessage.parse({
      role: "user",
      parts: [{ kind: "text", text: "hi" }],
      messageId: "m1",
    });
    expect(msg.kind).toBe("message");
    expect(msg.parts[0]!.kind).toBe("text");
  });

  it("rejects a message with no parts", () => {
    expect(() =>
      a2aMessage.parse({ role: "user", parts: [], messageId: "m1" }),
    ).toThrow();
  });

  it("parses message/send params", () => {
    const parsed = a2aMessageSendParams.parse({
      message: {
        role: "user",
        parts: [{ kind: "text", text: "go" }],
        messageId: "m1",
      },
    });
    expect(parsed.message.messageId).toBe("m1");
  });

  it("validates a full Task with kind:task", () => {
    const task = a2aTask.parse({
      id: "a2a_1",
      contextId: "ctx_1",
      status: { state: "completed" },
      artifacts: [
        { artifactId: "art_1", parts: [{ kind: "text", text: "done" }] },
      ],
      history: [],
    });
    expect(task.kind).toBe("task");
    expect(task.status.state).toBe("completed");
  });

  it("validates status-update and artifact-update events", () => {
    expect(() =>
      a2aStatusUpdateEvent.parse({
        kind: "status-update",
        taskId: "a2a_1",
        contextId: "ctx_1",
        status: { state: "working" },
        final: false,
      }),
    ).not.toThrow();
    expect(() =>
      a2aArtifactUpdateEvent.parse({
        kind: "artifact-update",
        taskId: "a2a_1",
        contextId: "ctx_1",
        artifact: { artifactId: "art_1", parts: [{ kind: "text", text: "x" }] },
        append: true,
        lastChunk: false,
      }),
    ).not.toThrow();
  });

  it("parses a JSON-RPC request envelope", () => {
    const req = jsonRpcRequest.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {},
    });
    expect(req.method).toBe("message/send");
  });

  it("builds JSON-RPC result and error envelopes", () => {
    expect(jsonRpcResult(1, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    const err = jsonRpcError(2, A2A_ERROR.taskNotFound, "nope");
    expect(err).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32001, message: "nope" },
    });
    const withData = jsonRpcError(3, A2A_ERROR.invalidParams, "bad", [1]);
    expect(withData.error).toMatchObject({ code: -32602, data: [1] });
  });

  describe("getSkillId", () => {
    const base = {
      kind: "message" as const,
      role: "user" as const,
      parts: [{ kind: "text" as const, text: "hi" }],
      messageId: "m1",
    };

    it("reads a non-empty string skillId from metadata", () => {
      expect(
        getSkillId({ ...base, metadata: { skillId: "billing-bot" } }),
      ).toBe("billing-bot");
    });

    it("trims surrounding whitespace", () => {
      expect(
        getSkillId({ ...base, metadata: { skillId: "  qa-chat  " } }),
      ).toBe("qa-chat");
    });

    it("returns undefined when metadata is absent", () => {
      expect(getSkillId(base)).toBeUndefined();
    });

    it("returns undefined for a non-string skillId (never throws)", () => {
      expect(
        getSkillId({ ...base, metadata: { skillId: 42 } }),
      ).toBeUndefined();
    });

    it("returns undefined for an empty/whitespace-only skillId", () => {
      expect(
        getSkillId({ ...base, metadata: { skillId: "   " } }),
      ).toBeUndefined();
    });
  });
});
