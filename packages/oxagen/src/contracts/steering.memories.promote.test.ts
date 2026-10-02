import { describe, expect, it } from "vitest";
import {
  PROMOTE_DRAFTS_MAX,
  steeringMemoriesPromote as contract,
} from "./steering.memories.promote";

// promote_memories (memory-collection spec, Promotion; #4912).
describe("promote_memories contract", () => {
  it("takes a draft that names only its memories, and cites same-text memories by default", () => {
    expect(
      contract.input.parse({ drafts: [{ memory_ids: ["mem_0a1b2c"] }] }),
    ).toEqual({ drafts: [{ memory_ids: ["mem_0a1b2c"] }], same_text: true });
  });

  it("takes a draft with its own statement, kind, force, effect, and repositories", () => {
    expect(
      contract.input.safeParse({
        drafts: [
          {
            memory_ids: ["mem_0a1b2c", "mem_3d4e5f"],
            statement: "Never write to the billing tables from a migration.",
            kind: "constraint",
            force: "must",
            effect: "forbid",
            repos: ["github.com/acme/api"],
          },
        ],
        same_text: false,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["no draft", { drafts: [] }],
    ["a draft with no memory", { drafts: [{ memory_ids: [] }] }],
    ["a skill, which is a folder", { drafts: [{ memory_ids: ["mem_a"], kind: "skill" }] }],
    ["a constraint with no effect", { drafts: [{ memory_ids: ["mem_a"], kind: "constraint" }] }],
    [
      "an effect on a kind that is not a constraint",
      { drafts: [{ memory_ids: ["mem_a"], kind: "code-rule", effect: "require" }] },
    ],
    ["an empty statement", { drafts: [{ memory_ids: ["mem_a"], statement: "  " }] }],
    ["a repository that is not <host>/<owner>/<name>", { drafts: [{ memory_ids: ["mem_a"], repos: ["api"] }] }],
    [
      "more drafts than one call takes",
      { drafts: Array.from({ length: PROMOTE_DRAFTS_MAX + 1 }, () => ({ memory_ids: ["mem_a"] })) },
    ],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it("lets an effect wait for the handler when the draft names no kind", () => {
    // The draft takes its first memory's kind, so only the handler can tell.
    expect(
      contract.input.safeParse({ drafts: [{ memory_ids: ["mem_a"], effect: "require" }] })
        .success,
    ).toBe(true);
  });

  it("opens a PR, so a workspace Viewer cannot call it and the in-app agent never receives it", () => {
    expect(contract.mutates).toBe(true);
    expect(contract.sensitivity).toBe("high");
    expect(contract.defaultRoles.workspace).toEqual({ Owner: "allow", Member: "allow" });
    expect(contract.surfaces).not.toContain("agent");
  });
});
