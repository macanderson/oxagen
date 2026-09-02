import { describe, expect, it } from "vitest";
import { researchSwarmStart } from "./research.swarm.start";
import { getCapability } from "../registry";

describe("research.swarm.start contract", () => {
  // ── contract metadata ────────────────────────────────────────────────────

  it("registers with the correct name", () => {
    expect(researchSwarmStart.name).toBe("start_research_swarm");
  });

  it("belongs to the research domain", () => {
    expect(researchSwarmStart.domain).toBe("research");
  });

  it("is async mode", () => {
    expect(researchSwarmStart.mode).toBe("async");
  });

  it("is scoped", () => {
    expect(researchSwarmStart.scoped).toBe(true);
  });

  it("declares unit in layers", () => {
    expect(researchSwarmStart.layers).toContain("unit");
  });

  it("includes api, mcp, and agent surfaces", () => {
    expect(researchSwarmStart.surfaces).toContain("api");
    expect(researchSwarmStart.surfaces).toContain("mcp");
    expect(researchSwarmStart.surfaces).toContain("agent");
  });

  it("requires agent approval and has medium risk", () => {
    expect(researchSwarmStart.agent?.requiresApproval).toBe(true);
    expect(researchSwarmStart.agent?.riskLevel).toBe("medium");
  });

  it("has medium sensitivity", () => {
    expect(researchSwarmStart.sensitivity).toBe("medium");
  });

  it("defaults to deny effect", () => {
    expect(researchSwarmStart.defaultEffect).toBe("deny");
  });

  it("allows org Owner and Admin", () => {
    expect(researchSwarmStart.defaultRoles.org.Owner).toBe("allow");
    expect(researchSwarmStart.defaultRoles.org.Admin).toBe("allow");
  });

  it("allows workspace Owner and Member", () => {
    expect(researchSwarmStart.defaultRoles.workspace.Owner).toBe("allow");
    expect(researchSwarmStart.defaultRoles.workspace.Member).toBe("allow");
  });

  // ── input: required fields ───────────────────────────────────────────────

  it("parses minimal valid input with only a topic", () => {
    const parsed = researchSwarmStart.input.parse({ topic: "AI safety" });
    expect(parsed.topic).toBe("AI safety");
  });

  it("rejects input with no topic", () => {
    expect(() => researchSwarmStart.input.parse({})).toThrow();
  });

  it("rejects an empty topic string", () => {
    expect(() => researchSwarmStart.input.parse({ topic: "" })).toThrow();
  });

  it("rejects a topic longer than 500 characters", () => {
    expect(() =>
      researchSwarmStart.input.parse({ topic: "a".repeat(501) }),
    ).toThrow();
  });

  it("accepts a topic exactly 500 characters (boundary)", () => {
    const parsed = researchSwarmStart.input.parse({ topic: "a".repeat(500) });
    expect(parsed.topic).toHaveLength(500);
  });

  // ── input: depth default and enum ────────────────────────────────────────

  it("defaults depth to medium", () => {
    const parsed = researchSwarmStart.input.parse({ topic: "AI safety" });
    expect(parsed.depth).toBe("medium");
  });

  it("accepts depth=shallow", () => {
    const parsed = researchSwarmStart.input.parse({
      topic: "AI safety",
      depth: "shallow",
    });
    expect(parsed.depth).toBe("shallow");
  });

  it("accepts depth=deep", () => {
    const parsed = researchSwarmStart.input.parse({
      topic: "AI safety",
      depth: "deep",
    });
    expect(parsed.depth).toBe("deep");
  });

  it("rejects an invalid depth value", () => {
    expect(() =>
      researchSwarmStart.input.parse({ topic: "AI safety", depth: "extreme" }),
    ).toThrow();
  });

  // ── input: maxParallel default and bounds ─────────────────────────────────

  it("defaults maxParallel to 5", () => {
    const parsed = researchSwarmStart.input.parse({ topic: "AI safety" });
    expect(parsed.maxParallel).toBe(5);
  });

  it("accepts maxParallel=1 (min)", () => {
    const parsed = researchSwarmStart.input.parse({
      topic: "AI safety",
      maxParallel: 1,
    });
    expect(parsed.maxParallel).toBe(1);
  });

  it("accepts maxParallel=20 (max)", () => {
    const parsed = researchSwarmStart.input.parse({
      topic: "AI safety",
      maxParallel: 20,
    });
    expect(parsed.maxParallel).toBe(20);
  });

  it("rejects maxParallel=0 (below min)", () => {
    expect(() =>
      researchSwarmStart.input.parse({ topic: "AI safety", maxParallel: 0 }),
    ).toThrow();
  });

  it("rejects maxParallel=21 (above max)", () => {
    expect(() =>
      researchSwarmStart.input.parse({ topic: "AI safety", maxParallel: 21 }),
    ).toThrow();
  });

  it("rejects a non-integer maxParallel", () => {
    expect(() =>
      researchSwarmStart.input.parse({ topic: "AI safety", maxParallel: 2.5 }),
    ).toThrow();
  });

  // ── input: targetLabel default ────────────────────────────────────────────

  it("defaults targetLabel to 'Topic'", () => {
    const parsed = researchSwarmStart.input.parse({ topic: "AI safety" });
    expect(parsed.targetLabel).toBe("Topic");
  });

  it("accepts a custom targetLabel", () => {
    const parsed = researchSwarmStart.input.parse({
      topic: "AI safety",
      targetLabel: "Concept",
    });
    expect(parsed.targetLabel).toBe("Concept");
  });

  // ── input: searchDepth default and enum ──────────────────────────────────

  it("defaults searchDepth to basic", () => {
    const parsed = researchSwarmStart.input.parse({ topic: "AI safety" });
    expect(parsed.searchDepth).toBe("basic");
  });

  it("accepts searchDepth=advanced", () => {
    const parsed = researchSwarmStart.input.parse({
      topic: "AI safety",
      searchDepth: "advanced",
    });
    expect(parsed.searchDepth).toBe("advanced");
  });

  it("rejects an invalid searchDepth value", () => {
    expect(() =>
      researchSwarmStart.input.parse({
        topic: "AI safety",
        searchDepth: "turbo",
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = researchSwarmStart.output.parse({
      swarmId: "swarm_abc123",
      dispatchId: "dispatch_xyz",
      status: "running",
      estimatedTasks: 8,
    });
    expect(parsed.swarmId).toBe("swarm_abc123");
    expect(parsed.dispatchId).toBe("dispatch_xyz");
    expect(parsed.status).toBe("running");
    expect(parsed.estimatedTasks).toBe(8);
  });

  it("rejects output with a status other than 'running'", () => {
    expect(() =>
      researchSwarmStart.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "complete",
        estimatedTasks: 8,
      }),
    ).toThrow();
  });

  it("rejects output missing swarmId", () => {
    expect(() =>
      researchSwarmStart.output.parse({
        dispatchId: "dispatch_xyz",
        status: "running",
        estimatedTasks: 8,
      }),
    ).toThrow();
  });

  it("rejects output missing dispatchId", () => {
    expect(() =>
      researchSwarmStart.output.parse({
        swarmId: "swarm_abc123",
        status: "running",
        estimatedTasks: 8,
      }),
    ).toThrow();
  });

  it("rejects output missing estimatedTasks", () => {
    expect(() =>
      researchSwarmStart.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "running",
      }),
    ).toThrow();
  });

  it("rejects wrong type for estimatedTasks", () => {
    expect(() =>
      researchSwarmStart.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "running",
        estimatedTasks: "eight",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("start_research_swarm")).toBe(researchSwarmStart);
  });
});
