// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_RECENT_AGENTS,
  recentAgentsKey,
  readRecentAgentIds,
  pushRecentAgentId,
} from "./recent-agents";

beforeEach(() => {
  window.localStorage.clear();
});

describe("recentAgentsKey", () => {
  it("scopes the key to the workspace slug", () => {
    expect(recentAgentsKey("acme")).toBe("oxagen:chat-session:v1:recent-agents:acme");
  });

  it("falls back to a shared bucket when workspaceSlug is undefined", () => {
    expect(recentAgentsKey(undefined)).toBe("oxagen:chat-session:v1:recent-agents:_");
  });
});

describe("readRecentAgentIds", () => {
  it("returns an empty array when nothing is stored", () => {
    expect(readRecentAgentIds("acme")).toEqual([]);
  });

  it("returns the persisted list", () => {
    window.localStorage.setItem(
      recentAgentsKey("acme"),
      JSON.stringify(["agt_1", "agt_2"]),
    );
    expect(readRecentAgentIds("acme")).toEqual(["agt_1", "agt_2"]);
  });

  it("returns an empty array for malformed JSON", () => {
    window.localStorage.setItem(recentAgentsKey("acme"), "not-json{{");
    expect(readRecentAgentIds("acme")).toEqual([]);
  });

  it("returns an empty array for a non-array value", () => {
    window.localStorage.setItem(recentAgentsKey("acme"), JSON.stringify({ foo: "bar" }));
    expect(readRecentAgentIds("acme")).toEqual([]);
  });

  it("filters out non-string entries", () => {
    window.localStorage.setItem(
      recentAgentsKey("acme"),
      JSON.stringify(["agt_1", 42, null, "agt_2"]),
    );
    expect(readRecentAgentIds("acme")).toEqual(["agt_1", "agt_2"]);
  });
});

describe("pushRecentAgentId", () => {
  it("adds a new agent to the front", () => {
    pushRecentAgentId("acme", "agt_1");
    expect(pushRecentAgentId("acme", "agt_2")).toEqual(["agt_2", "agt_1"]);
  });

  it("de-dupes and moves an existing agent to the front", () => {
    pushRecentAgentId("acme", "agt_1");
    pushRecentAgentId("acme", "agt_2");
    expect(pushRecentAgentId("acme", "agt_1")).toEqual(["agt_1", "agt_2"]);
  });

  it("caps the list at MAX_RECENT_AGENTS", () => {
    let result: string[] = [];
    for (let i = 0; i < MAX_RECENT_AGENTS + 3; i++) {
      result = pushRecentAgentId("acme", `agt_${i}`);
    }
    expect(result).toHaveLength(MAX_RECENT_AGENTS);
    // Most-recent-first: the last pushed id leads.
    expect(result[0]).toBe(`agt_${MAX_RECENT_AGENTS + 2}`);
  });

  it("persists across reads", () => {
    pushRecentAgentId("acme", "agt_1");
    expect(readRecentAgentIds("acme")).toEqual(["agt_1"]);
  });

  it("scopes recency separately per workspace", () => {
    pushRecentAgentId("acme", "agt_1");
    pushRecentAgentId("other", "agt_2");
    expect(readRecentAgentIds("acme")).toEqual(["agt_1"]);
    expect(readRecentAgentIds("other")).toEqual(["agt_2"]);
  });
});
