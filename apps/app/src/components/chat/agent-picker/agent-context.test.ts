// @vitest-environment jsdom
/**
 * agent-context.test.ts — persistence (mirrors pinned-context) + the
 * initial-selection resolution priority.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  agentStorageKey,
  readStoredAgentId,
  writeStoredAgentId,
  resolveInitialAgentId,
  DRAFT_PREFIX,
} from "./agent-context";

afterEach(() => window.localStorage.clear());

describe("agentStorageKey", () => {
  it("uses the conversation id when present", () => {
    expect(agentStorageKey("ws", "conv_1")).toBe(
      "oxagen:chat-agent:conv:conv_1",
    );
  });

  it("uses a workspace-scoped draft key for a new chat", () => {
    expect(agentStorageKey("acme", null)).toBe(`${DRAFT_PREFIX}acme`);
  });

  it("falls back to '_' when the workspace slug is undefined", () => {
    expect(agentStorageKey(undefined, null)).toBe(`${DRAFT_PREFIX}_`);
  });
});

describe("read/writeStoredAgentId", () => {
  it("round-trips an agent id", () => {
    const key = agentStorageKey("ws", "conv_1");
    writeStoredAgentId(key, "agt_abc");
    expect(readStoredAgentId(key)).toBe("agt_abc");
  });

  it("clears the key when written null", () => {
    const key = agentStorageKey("ws", "conv_1");
    writeStoredAgentId(key, "agt_abc");
    writeStoredAgentId(key, null);
    expect(readStoredAgentId(key)).toBeNull();
  });

  it("returns null for an unset key", () => {
    expect(readStoredAgentId(agentStorageKey("ws", "conv_missing"))).toBeNull();
  });

  it("ignores a legacy JSON-shaped value (defensive)", () => {
    const key = agentStorageKey("ws", "conv_1");
    window.localStorage.setItem(key, '{"repoKey":"x"}');
    expect(readStoredAgentId(key)).toBeNull();
  });
});

describe("resolveInitialAgentId", () => {
  it("prefers the URL binding above everything", () => {
    expect(
      resolveInitialAgentId({
        boundAgentId: "agt_bound",
        persistedAgentId: "agt_persisted",
        workspaceDefaultAgentId: "agt_default",
        isNewConversation: true,
      }),
    ).toBe("agt_bound");
  });

  it("prefers the persisted selection over the workspace default", () => {
    expect(
      resolveInitialAgentId({
        boundAgentId: null,
        persistedAgentId: "agt_persisted",
        workspaceDefaultAgentId: "agt_default",
        isNewConversation: true,
      }),
    ).toBe("agt_persisted");
  });

  it("uses the workspace default only for a new conversation", () => {
    expect(
      resolveInitialAgentId({
        boundAgentId: null,
        persistedAgentId: null,
        workspaceDefaultAgentId: "agt_default",
        isNewConversation: true,
      }),
    ).toBe("agt_default");
  });

  it("does NOT apply the workspace default to an existing conversation", () => {
    expect(
      resolveInitialAgentId({
        boundAgentId: null,
        persistedAgentId: null,
        workspaceDefaultAgentId: "agt_default",
        isNewConversation: false,
      }),
    ).toBeNull();
  });

  it("resolves to null (default assistant) when nothing applies", () => {
    expect(
      resolveInitialAgentId({
        boundAgentId: null,
        persistedAgentId: null,
        workspaceDefaultAgentId: null,
        isNewConversation: true,
      }),
    ).toBeNull();
  });
});
