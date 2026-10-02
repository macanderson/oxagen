import { describe, expect, it } from "vitest";
import {
  steeringMemoriesList as contract,
  WORKSPACE_MEMORIES_GROUPED_MAX,
} from "./steering.memories.list";

// list_workspace_memories (memory-collection spec, Memories tab; #4912).
describe("list_workspace_memories contract", () => {
  it("lists waiting and in-PR memories, 50 groups a page, when no filter is named", () => {
    expect(contract.input.parse({})).toEqual({
      states: ["waiting", "in_pr"],
      limit: 50,
      offset: 0,
    });
  });

  it("takes every filter the Memories tab offers", () => {
    expect(
      contract.input.safeParse({
        states: ["promoted", "dismissed", "retired"],
        harness: "codex",
        agent: "agt.laptop",
        repository: "github.com/acme/api",
        type: "feedback",
        limit: 200,
        offset: 400,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an unknown state", { states: ["archived"] }],
    ["an empty state list", { states: [] }],
    ["an unknown harness", { harness: "gemini" }],
    ["a repository that is not <host>/<owner>/<name>", { repository: "acme/api" }],
    ["a type with capitals", { type: "Feedback" }],
    ["a page over 200", { limit: 201 }],
    ["an unknown field", { sort: "uses" }],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it("is a read the in-app agent never receives", () => {
    expect(contract.mutates).toBe(false);
    expect(contract.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(contract.surfaces).not.toContain("agent");
  });

  it("lets every workspace role read it", () => {
    expect(contract.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("groups at most 2,000 memories", () => {
    expect(WORKSPACE_MEMORIES_GROUPED_MAX).toBe(2_000);
  });
});
