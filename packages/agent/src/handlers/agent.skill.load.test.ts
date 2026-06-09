import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock withTenantDb as a queue-based stub so successive calls return
// different query results without complex chain-counting.
const mocks = vi.hoisted(() => ({
  dbCallResults: [] as unknown[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    const nextResult = mocks.dbCallResults.shift();
    return fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => nextResult,
            orderBy: async () => nextResult,
          }),
          orderBy: async () => nextResult,
        }),
      }),
    });
  },

  };
});

import { agentSkillLoadHandler } from "./agent.skill.load";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

function enqueue(...results: unknown[]) {
  mocks.dbCallResults.push(...results);
}

describe("agent.skill.load handler", () => {
  beforeEach(() => {
    mocks.dbCallResults = [];
  });

  it("returns loaded=false when skill not found", async () => {
    enqueue([]); // skill query returns nothing
    const result = await agentSkillLoadHandler({ skillSlug: "missing" }, CTX);
    expect(result.loaded).toBe(false);
    expect(result.dependencyErrors).toHaveLength(1);
    expect(result.dependencyErrors[0]!.slug).toBe("missing");
  });

  it("returns loaded=false when no version matches constraint", async () => {
    enqueue([{ id: "skl_1" }]); // skill found
    enqueue([{ versionNumber: 1, body: "# Skill" }]); // only version 1 available
    const result = await agentSkillLoadHandler({ skillSlug: "summarize", version: "5" }, CTX);
    expect(result.loaded).toBe(false);
    expect(result.dependencyErrors[0]!.reason).toContain("version constraint");
  });

  it("loads latest version when no constraint given", async () => {
    enqueue([{ id: "skl_1" }]);
    enqueue([
      { versionNumber: 3, body: "## Capability: summarize.text" },
      { versionNumber: 1, body: "old" },
    ]);
    const result = await agentSkillLoadHandler({ skillSlug: "summarize" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(3);
    expect(result.capabilities).toContain("summarize.text");
  });

  it("matches caret constraint (>=N)", async () => {
    enqueue([{ id: "skl_1" }]);
    enqueue([
      { versionNumber: 5, body: "" },
      { versionNumber: 2, body: "" },
    ]);
    const result = await agentSkillLoadHandler({ skillSlug: "summarize", version: "^3" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(5);
  });

  it("matches tilde constraint (exact major)", async () => {
    enqueue([{ id: "skl_1" }]);
    enqueue([
      { versionNumber: 5, body: "" },
      { versionNumber: 2, body: "" },
    ]);
    const result = await agentSkillLoadHandler({ skillSlug: "summarize", version: "~2" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(2);
  });

  it("collects dependency errors without failing primary load", async () => {
    // dep lookup → not found, primary lookup → found, version lookup → found
    enqueue([]); // dep: skill not found
    enqueue([{ id: "skl_1" }]); // primary: skill found
    enqueue([{ versionNumber: 1, body: "body text" }]); // primary: version
    const result = await agentSkillLoadHandler(
      { skillSlug: "primary", dependencies: ["missing-dep"] },
      CTX,
    );
    expect(result.loaded).toBe(true);
    expect(result.dependencyErrors).toHaveLength(1);
    expect(result.dependencyErrors[0]!.slug).toBe("missing-dep");
  });

  it("returns empty capabilities when body has no capability markers", async () => {
    enqueue([{ id: "skl_1" }]);
    enqueue([{ versionNumber: 1, body: "# Just a skill body" }]);
    const result = await agentSkillLoadHandler({ skillSlug: "plain" }, CTX);
    expect(result.capabilities).toEqual([]);
  });
});
