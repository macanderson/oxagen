import { describe, expect, it } from "vitest";
import { STEERING_PR_MAX_FILES } from "../steering-repo/names";
import {
  STEERING_PROPOSE_EVIDENCE_MAX,
  STEERING_PROPOSE_FILE_MAX,
  steeringPropose,
} from "./steering.propose";

const RECORD = {
  path: "steering/billing/aintel.billing.refunds-over-100.md",
  content: "---\nschema: steering-record/v1\n---\nAsk a person first.\n",
};

const INPUT = {
  title: "Ask before refunds over $100",
  rationale: "Two runs refunded $240 without asking.",
  evidence: [88, 131],
  files: [RECORD],
};

const OUTPUT = {
  number: 42,
  url: "https://github.com/aintel/oxagen-core-platform/pull/42",
  branch: "steering/propose-aintel.billing.refunds-over-100-20261002t153012",
  head_sha: "4be91d2c0a7e5f3b9d18e6a2c4f0b7d95e3a1c86",
  agent: "aintel.core.ci-reviewer",
  run: "tse_01K5QK7D",
};

describe("propose_steering contract", () => {
  it("is a scoped, unmetered write on the mcp surface", () => {
    expect(steeringPropose.name).toBe("propose_steering");
    expect(steeringPropose.surfaces).toEqual(["mcp"]);
    expect(steeringPropose.scoped).toBe(true);
    expect(steeringPropose.mutates).toBe(true);
    expect(steeringPropose.noBillingGate).toBe(true);
  });

  it("lets org admins and workspace owners and members call it, and no viewer", () => {
    expect(steeringPropose.defaultEffect).toBe("deny");
    expect(steeringPropose.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("takes files, a title, a rationale, and frames as evidence", () => {
    expect(steeringPropose.input.parse(INPUT)).toEqual(INPUT);
  });

  it("cites no frames when the caller sends none", () => {
    const { evidence: _evidence, ...withoutEvidence } = INPUT;
    expect(steeringPropose.input.parse(withoutEvidence).evidence).toEqual([]);
  });

  it("takes a null content as a deletion", () => {
    const input = { ...INPUT, files: [{ path: RECORD.path, content: null }] };
    expect(steeringPropose.input.parse(input).files[0]?.content).toBeNull();
  });

  it("takes no agent, run, or provenance field, so a caller cannot name its own", () => {
    for (const field of ["agent", "run", "provenance"]) {
      expect(steeringPropose.input.safeParse({ ...INPUT, [field]: "aintel.core.other" }).success).toBe(false);
    }
  });

  it("refuses no files, too many files, and a file it would not take", () => {
    expect(steeringPropose.input.safeParse({ ...INPUT, files: [] }).success).toBe(false);
    const many = Array.from({ length: STEERING_PR_MAX_FILES + 1 }, (_, n) => ({
      path: `steering/memory/aintel.memory.m${n}.md`,
      content: "x",
    }));
    expect(steeringPropose.input.safeParse({ ...INPUT, files: many }).success).toBe(false);
    const big = { path: RECORD.path, content: "x".repeat(STEERING_PROPOSE_FILE_MAX + 1) };
    expect(steeringPropose.input.safeParse({ ...INPUT, files: [big] }).success).toBe(false);
  });

  it("refuses a path that is absolute, climbs out, or has an empty segment", () => {
    for (const path of ["/steering/a.md", "steering/../a.md", "steering//a.md", "steering/a/"]) {
      const input = { ...INPUT, files: [{ path, content: "x" }] };
      expect(steeringPropose.input.safeParse(input).success, path).toBe(false);
    }
  });

  it("refuses an empty title or rationale, and too many frames", () => {
    expect(steeringPropose.input.safeParse({ ...INPUT, title: "  " }).success).toBe(false);
    expect(steeringPropose.input.safeParse({ ...INPUT, rationale: "" }).success).toBe(false);
    const frames = Array.from({ length: STEERING_PROPOSE_EVIDENCE_MAX + 1 }, (_, n) => n);
    expect(steeringPropose.input.safeParse({ ...INPUT, evidence: frames }).success).toBe(false);
  });

  it("answers the PR, its head, and the agent and run Oxagen wrote", () => {
    expect(steeringPropose.output.parse(OUTPUT)).toEqual(OUTPUT);
  });

  it("refuses an answer without the agent or the run", () => {
    const { agent: _agent, ...withoutAgent } = OUTPUT;
    expect(steeringPropose.output.safeParse(withoutAgent).success).toBe(false);
    const { run: _run, ...withoutRun } = OUTPUT;
    expect(steeringPropose.output.safeParse(withoutRun).success).toBe(false);
  });
});
