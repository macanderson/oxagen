import { describe, expect, it, vi } from "vitest";
import { CREATE_KINDS } from "@/shared/create";
import { clampStep, railOf, type StepId } from "./wizard";

vi.mock("./actions", () => ({
  proposeSkill: vi.fn(),
  proposeRecord: vi.fn(),
  openRecordPr: vi.fn(),
  readMainRepository: vi.fn(),
}));

const { WIZARDS } = await import("./kinds");

describe("railOf", () => {
  it("ticks the steps behind, marks the one you are on and leaves the rest ahead", () => {
    const steps: StepId[] = ["source", "describeIt", "review", "pullRequest"];
    expect(railOf(steps, 3)).toEqual([
      { id: "source", n: 1, state: "done" },
      { id: "describeIt", n: 2, state: "done" },
      { id: "review", n: 3, state: "current" },
      { id: "pullRequest", n: 4, state: "ahead" },
    ]);
  });

  it("marks nothing done on the first step", () => {
    expect(railOf(["source", "review"], 1).map((s) => s.state)).toEqual([
      "current",
      "ahead",
    ]);
  });
});

describe("clampStep", () => {
  it("keeps a step inside a list a path shortened (negative)", () => {
    expect(clampStep(5, 3)).toBe(3);
    expect(clampStep(0, 3)).toBe(1);
    expect(clampStep(2, 0)).toBe(1);
  });
});

describe("the wizard registry", () => {
  it("carries a wizard for every kind the chooser and ⌘K offer", async () => {
    for (const kind of CREATE_KINDS)
      expect((await WIZARDS[kind]?.())?.kind).toBe(kind);
  });

  it("carries the skill wizard, and ends every one of its paths on a pull request", async () => {
    const skill = await WIZARDS.skill?.();
    expect(skill?.need).toBe("skills.admin");
    for (const path of ["describe", "upload", "registry", null]) {
      const draft = { ...skill?.init(), path };
      expect(skill?.steps(draft).at(-1)).toBe("pullRequest");
    }
  });

  it("carries the agent wizard: five steps, ending on a pull request", async () => {
    const agent = await WIZARDS.agent?.();
    expect(agent?.need).toBe("agent.write");
    expect(agent?.steps(agent.init())).toEqual([
      "describe",
      "identity",
      "definition",
      "toolbelt",
      "pullRequest",
    ]);
  });

  it("carries the context-record wizard: five steps, ending on a pull request", async () => {
    const record = await WIZARDS.record?.();
    expect(record?.need).toBe("steering.write");
    expect(record?.steps({ ...record.init() })).toEqual([
      "describe",
      "kind",
      "statement",
      "checks",
      "pullRequest",
    ]);
  });
});
