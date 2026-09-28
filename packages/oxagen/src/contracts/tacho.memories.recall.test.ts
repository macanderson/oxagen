import { describe, expect, it } from "vitest";
import { MEMORY_RECALL_MAX } from "../steering-repo/tokens";
import { tachoMemoriesRecall as contract } from "./tacho.memories.recall";

const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  repository: "github.com/a-intel/platform",
  tools: ["Bash", "mcp__linear__create_issue"],
  paths: ["apps/api/src/app.ts"],
  text: "Why does the billing test fail after the proration change?",
};

const item = {
  id: "memory.billing-tests",
  source: "record",
  statement: "Run the billing tests before a proration change.",
  score: 0.82,
  tokens: 12,
};

describe("host memory recall contract", () => {
  it("takes one prompt from a named host", () => {
    expect(contract.input.safeParse(input).success).toBe(true);
    for (const patch of [
      { repository: null },
      { tools: [], paths: [] },
      { text: "" },
      { text: "t".repeat(8000) },
      { tools: Array.from({ length: 64 }, (_, i) => `tool_${i}`) },
      { paths: Array.from({ length: 16 }, (_, i) => `src/${i}.ts`) },
    ]) {
      expect(
        contract.input.safeParse({ ...input, ...patch }).success,
        JSON.stringify(patch).slice(0, 80),
      ).toBe(true);
    }
  });

  it("refuses a malformed prompt", () => {
    for (const patch of [
      { host_enrollment_id: "host" },
      { run: "run_1" },
      { tools: Array.from({ length: 65 }, (_, i) => `tool_${i}`) },
      { tools: [""] },
      { tools: ["t".repeat(201)] },
      { paths: Array.from({ length: 17 }, (_, i) => `src/${i}.ts`) },
      { paths: ["p".repeat(513)] },
      { repository: "" },
      { repository: "r".repeat(201) },
      { text: "t".repeat(8001) },
    ]) {
      expect(
        contract.input.safeParse({ ...input, ...patch }).success,
        JSON.stringify(patch).slice(0, 80),
      ).toBe(false);
    }
    const { text: _text, ...withoutText } = input;
    expect(contract.input.safeParse(withoutText).success).toBe(false);
  });

  it("answers with at most the recall cap of items", () => {
    expect(contract.output.safeParse({ items: [] }).success).toBe(true);
    expect(
      contract.output.safeParse({
        items: [item, { ...item, id: "mem_1", source: "memory" }],
      }).success,
    ).toBe(true);
    expect(
      contract.output.safeParse({
        items: Array.from({ length: MEMORY_RECALL_MAX + 1 }, () => item),
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown field in the answer", () => {
    expect(contract.output.safeParse({ items: [], more: true }).success).toBe(
      false,
    );
    expect(
      contract.output.safeParse({ items: [{ ...item, agent: "a" }] }).success,
    ).toBe(false);
    expect(
      contract.output.safeParse({ items: [{ ...item, source: "run" }] })
        .success,
    ).toBe(false);
  });

  it("stays off the agent and MCP surfaces and needs an admin's key", () => {
    expect(contract.name).toBe("recall_tacho_memories");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.sensitivity).toBe("high");
    expect(contract.mutates).toBe(true);
    expect(contract.defaultEffect).toBe("deny");
    expect(contract.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });
});
