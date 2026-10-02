import { describe, expect, it } from "vitest";
import { agentFileText, agentNameForRuntime, agentSchema } from "./agent";
import { readTomlFile } from "./files";

const AGENT = {
  schema: "agent/v1" as const,
  name: "mcp-live-1",
  label: "Claude Code on mcp-live-1",
  operator: "usr_01k5qk7d0000000000000000",
  runtime: "mcp-live-1",
  harness: "claude-code" as const,
};

describe("agentNameForRuntime (#5149)", () => {
  it("names the agent file after a runtime slug that is a valid agent name", () => {
    expect(agentNameForRuntime("mcp-live-1")).toBe("mcp-live-1");
    expect(agentNameForRuntime("ci-linux-01")).toBe("ci-linux-01");
  });

  it("answers null for a slug that is not an agent name", () => {
    expect(agentNameForRuntime("Not_A_Name")).toBeNull();
    expect(agentNameForRuntime("trailing-")).toBeNull();
    expect(agentNameForRuntime("")).toBeNull();
  });
});

describe("agentFileText (#5149)", () => {
  it("writes an agent/v1 file that reads back as the same agent", () => {
    const text = agentFileText(AGENT);
    expect(text.split("\n")[0]).toBe(
      "#:schema https://oxagen.sh/schemas/agent/v1.json",
    );
    const read = readTomlFile(text, "agent/v1", agentSchema);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual(AGENT);
  });

  it("quotes a label that holds a quote", () => {
    const text = agentFileText({ ...AGENT, label: 'The "live" agent' });
    const read = readTomlFile(text, "agent/v1", agentSchema);
    expect(read.ok && read.value.label).toBe('The "live" agent');
  });

  it("refuses fields agent/v1 refuses before it writes anything", () => {
    expect(() => agentFileText({ ...AGENT, operator: "Priya Shah" })).toThrow();
    expect(() =>
      agentFileText({ ...AGENT, toolbelt: "refunds" } as unknown as typeof AGENT),
    ).toThrow();
  });
});
