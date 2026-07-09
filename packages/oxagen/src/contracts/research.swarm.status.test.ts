import { describe, expect, it } from "vitest";
import { researchSwarmStatus } from "./research.swarm.status";
import { getCapability } from "../registry";

describe("research.swarm.status contract", () => {
  // ── contract metadata ────────────────────────────────────────────────────

  it("registers with the correct name", () => {
    expect(researchSwarmStatus.name).toBe("get_research_status");
  });

  it("belongs to the research domain", () => {
    expect(researchSwarmStatus.domain).toBe("research");
  });

  it("is sync mode", () => {
    expect(researchSwarmStatus.mode).toBe("sync");
  });

  it("is scoped", () => {
    expect(researchSwarmStatus.scoped).toBe(true);
  });

  it("declares unit in layers", () => {
    expect(researchSwarmStatus.layers).toContain("unit");
  });

  it("includes api, mcp, and agent surfaces", () => {
    expect(researchSwarmStatus.surfaces).toContain("api");
    expect(researchSwarmStatus.surfaces).toContain("mcp");
    expect(researchSwarmStatus.surfaces).toContain("agent");
  });

  it("does not require agent approval and has low risk", () => {
    expect(researchSwarmStatus.agent?.requiresApproval).toBe(false);
    expect(researchSwarmStatus.agent?.riskLevel).toBe("low");
  });

  it("has low sensitivity", () => {
    expect(researchSwarmStatus.sensitivity).toBe("low");
  });

  it("defaults to deny effect", () => {
    expect(researchSwarmStatus.defaultEffect).toBe("deny");
  });

  it("allows org Owner and Admin", () => {
    expect(researchSwarmStatus.defaultRoles.org.Owner).toBe("allow");
    expect(researchSwarmStatus.defaultRoles.org.Admin).toBe("allow");
  });

  it("allows workspace Owner and Member", () => {
    expect(researchSwarmStatus.defaultRoles.workspace.Owner).toBe("allow");
    expect(researchSwarmStatus.defaultRoles.workspace.Member).toBe("allow");
  });

  // ── input: required fields ───────────────────────────────────────────────

  it("parses valid input with a swarmId", () => {
    const parsed = researchSwarmStatus.input.parse({ swarmId: "swarm_abc123" });
    expect(parsed.swarmId).toBe("swarm_abc123");
  });

  it("rejects input missing swarmId", () => {
    expect(() => researchSwarmStatus.input.parse({})).toThrow();
  });

  it("rejects non-string swarmId", () => {
    expect(() => researchSwarmStatus.input.parse({ swarmId: 42 })).toThrow();
  });

  // ── output: required fields ───────────────────────────────────────────────

  it("parses a running output", () => {
    const parsed = researchSwarmStatus.output.parse({
      swarmId: "swarm_abc123",
      dispatchId: "dispatch_xyz",
      status: "running",
      completedTasks: 3,
      totalTasks: 8,
    });
    expect(parsed.swarmId).toBe("swarm_abc123");
    expect(parsed.dispatchId).toBe("dispatch_xyz");
    expect(parsed.status).toBe("running");
    expect(parsed.completedTasks).toBe(3);
    expect(parsed.totalTasks).toBe(8);
  });

  it("parses a complete output", () => {
    const parsed = researchSwarmStatus.output.parse({
      swarmId: "swarm_abc123",
      dispatchId: "dispatch_xyz",
      status: "complete",
      completedTasks: 8,
      totalTasks: 8,
    });
    expect(parsed.status).toBe("complete");
  });

  it("parses a failed output", () => {
    const parsed = researchSwarmStatus.output.parse({
      swarmId: "swarm_abc123",
      dispatchId: "dispatch_xyz",
      status: "failed",
      completedTasks: 2,
      totalTasks: 8,
    });
    expect(parsed.status).toBe("failed");
  });

  it("rejects an unknown status value", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "pending",
        completedTasks: 0,
        totalTasks: 8,
      }),
    ).toThrow();
  });

  it("rejects output missing swarmId", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        dispatchId: "dispatch_xyz",
        status: "running",
        completedTasks: 3,
        totalTasks: 8,
      }),
    ).toThrow();
  });

  it("rejects output missing dispatchId", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        status: "running",
        completedTasks: 3,
        totalTasks: 8,
      }),
    ).toThrow();
  });

  it("rejects output missing completedTasks", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "running",
        totalTasks: 8,
      }),
    ).toThrow();
  });

  it("rejects output missing totalTasks", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "running",
        completedTasks: 3,
      }),
    ).toThrow();
  });

  it("rejects wrong type for completedTasks", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "running",
        completedTasks: "three",
        totalTasks: 8,
      }),
    ).toThrow();
  });

  // ── output: optional results array ────────────────────────────────────────

  it("allows results to be omitted", () => {
    const parsed = researchSwarmStatus.output.parse({
      swarmId: "swarm_abc123",
      dispatchId: "dispatch_xyz",
      status: "complete",
      completedTasks: 2,
      totalTasks: 2,
    });
    expect(parsed.results).toBeUndefined();
  });

  it("parses output with a valid results array", () => {
    const parsed = researchSwarmStatus.output.parse({
      swarmId: "swarm_abc123",
      dispatchId: "dispatch_xyz",
      status: "complete",
      completedTasks: 2,
      totalTasks: 2,
      results: [
        { query: "AI safety papers 2025", resultCount: 12 },
        { query: "AI alignment research", resultCount: 7 },
      ],
    });
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results?.[0]?.query).toBe("AI safety papers 2025");
    expect(parsed.results?.[0]?.resultCount).toBe(12);
  });

  it("rejects a results entry missing query", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "complete",
        completedTasks: 1,
        totalTasks: 1,
        results: [{ resultCount: 5 }],
      }),
    ).toThrow();
  });

  it("rejects a results entry missing resultCount", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "complete",
        completedTasks: 1,
        totalTasks: 1,
        results: [{ query: "some query" }],
      }),
    ).toThrow();
  });

  it("rejects wrong type for resultCount in results entry", () => {
    expect(() =>
      researchSwarmStatus.output.parse({
        swarmId: "swarm_abc123",
        dispatchId: "dispatch_xyz",
        status: "complete",
        completedTasks: 1,
        totalTasks: 1,
        results: [{ query: "some query", resultCount: "many" }],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_research_status")).toBe(researchSwarmStatus);
  });
});
