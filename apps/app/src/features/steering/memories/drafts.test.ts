// Promote's drafts (#4914): one per row from its waiting memories, the kind
// the memory suggests and the default force for it, the forces each kind
// allows (forcesFor, the rule promote_memories enforces), the effect a
// constraint names, and the payload the write takes.
import { PROMOTE_DRAFTS_MAX as CONTRACT_MAX } from "@oxagen/oxagen/contracts/steering.memories.promote";
import { describe, expect, it } from "vitest";
import { workspaceMemory } from "@/test/steering-views";
import {
  draftOf,
  forceChoices,
  PROMOTE_DRAFTS_MAX,
  PROMOTE_KINDS,
  promotePayload,
  withKind,
} from "./drafts";

const WAITING = workspaceMemory();
const SAME = workspaceMemory({
  id: "mem_01k5rw3same",
  agent: "acme.core-platform.docs-bot",
});

describe("draftOf", () => {
  it("drafts one record citing every waiting memory of the row, with the memory's kind and its default force", () => {
    expect(draftOf([WAITING, SAME])).toEqual({
      ids: [WAITING.id, SAME.id],
      agents: [WAITING.agent, SAME.agent],
      statement: WAITING.statement,
      suggested: "procedure",
      kind: "procedure",
      force: "should",
      effect: null,
      repos: ["github.com/acme/platform"],
    });
  });

  it("leaves out a memory that is not waiting, and drafts nothing for a row with none (negative)", () => {
    const inPr = workspaceMemory({ id: "mem_01k5rw3inpr", state: "in_pr" });
    expect(draftOf([inPr, WAITING])?.ids).toEqual([WAITING.id]);
    expect(draftOf([inPr])).toBeNull();
  });

  it("suggests a procedure for a skill, which a record cannot be", () => {
    expect(draftOf([workspaceMemory({ kind: "skill" })])?.kind).toBe(
      "procedure",
    );
    expect(PROMOTE_KINDS).not.toContain("skill");
    expect(PROMOTE_KINDS).toHaveLength(7);
  });

  it("starts a constraint with require, and a fact with info only", () => {
    expect(draftOf([workspaceMemory({ kind: "constraint" })])).toMatchObject({
      force: "should",
      effect: "require",
    });
    expect(draftOf([workspaceMemory({ kind: "fact" })])).toMatchObject({
      force: "info",
      effect: null,
    });
  });

  it("scopes a memory with no repository to the workspace", () => {
    expect(draftOf([workspaceMemory({ repos: null })])?.repos).toEqual([]);
  });
});

describe("withKind", () => {
  const draft = draftOf([WAITING]);
  if (draft === null) throw new Error("the fixture waits");

  it("keeps a force the new kind allows and falls to its default otherwise", () => {
    expect(withKind({ ...draft, force: "may" }, "preference").force).toBe(
      "may",
    );
    expect(withKind({ ...draft, force: "must" }, "preference").force).toBe(
      "may",
    );
    expect(withKind(draft, "memory").force).toBe("info");
  });

  it("gives a constraint an effect and takes it from every other kind", () => {
    const constraint = withKind(draft, "constraint");
    expect(constraint.effect).toBe("require");
    expect(withKind({ ...constraint, effect: "forbid" }, "constraint").effect).toBe(
      "forbid",
    );
    expect(withKind(constraint, "code-rule").effect).toBeNull();
  });
});

describe("forceChoices", () => {
  it("offers the forces forcesFor allows for each kind", () => {
    expect(forceChoices("code-rule")).toEqual(["must", "should", "may", "info"]);
    expect(forceChoices("preference")).toEqual(["may", "info"]);
    expect(forceChoices("fact")).toEqual(["info"]);
  });
});

describe("promotePayload", () => {
  const draft = draftOf([WAITING]);
  if (draft === null) throw new Error("the fixture waits");

  it("sends the memories, the trimmed statement, the kind and the force, and no repositories", () => {
    expect(
      promotePayload([{ ...draft, statement: "  Draft every release.  " }]),
    ).toEqual([
      {
        memory_ids: [WAITING.id],
        statement: "Draft every release.",
        kind: "procedure",
        force: "should",
      },
    ]);
  });

  it("sends a constraint's effect", () => {
    expect(
      promotePayload([{ ...withKind(draft, "constraint"), effect: "forbid" }]),
    ).toEqual([expect.objectContaining({ kind: "constraint", effect: "forbid" })]);
  });

  it("sends nothing while a statement is empty (negative)", () => {
    expect(promotePayload([{ ...draft, statement: "   " }])).toBeNull();
  });

  it("caps a call at the contract's own bound", () => {
    expect(PROMOTE_DRAFTS_MAX).toBe(CONTRACT_MAX);
  });
});
