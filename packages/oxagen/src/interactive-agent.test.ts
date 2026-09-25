import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_AGENT_SLUG,
  INTERACTIVE_AGENT_CAPABILITIES,
  INTERACTIVE_AGENT_TYPE,
  buildInteractiveAgentConfig,
  computeConfigChecksum,
  isManagedAgentType,
} from "./interactive-agent";
import { agentDefinitionConfigSchema } from "./agent-schema";
import { getCapability } from "./registry";
import { capabilityMutates, getSurfaces } from "./types";
// Registers every contract, as the package root does at boot, so the pins
// are checked against the registry that ships.
import "./contracts.generated";

describe("interactive-agent config builder", () => {
  it("uses the well-known qa-chat slug", () => {
    expect(INTERACTIVE_AGENT_SLUG).toBe("qa-chat");
  });

  it("builds a config that conforms to agentDefinitionConfigSchema", () => {
    const config = buildInteractiveAgentConfig("ws_123");
    // Re-parse to prove it is schema-valid (builder already parses, but assert).
    expect(() => agentDefinitionConfigSchema.parse(config)).not.toThrow();
    expect(config.graph.ontologyId).toBe("ws_123");
    expect(config.graph.mode).toBe("read");
  });

  it("grants every allowlisted capability as an agentTool of type function", () => {
    const config = buildInteractiveAgentConfig("ws_1");
    const refs = config.agentTools
      .filter((t) => t.type === "function")
      .map((t) => t.ref);
    for (const name of INTERACTIVE_AGENT_CAPABILITIES) {
      expect(refs).toContain(name);
    }
  });

  // ADR-043: skills and subagents are gone; a grant names something the
  // platform can actually gate (a capability, or a registered MCP server).
  it("grants no skill or subagent tools", () => {
    const config = buildInteractiveAgentConfig("ws_1");
    for (const t of config.agentTools) {
      expect(["function", "mcp_server"]).toContain(t.type);
    }
  });

  it("includes non-empty instructions", () => {
    const config = buildInteractiveAgentConfig("ws_1");
    expect(config.instructions && config.instructions.length).toBeGreaterThan(
      0,
    );
  });

  it("names the meta-tools and claims no execution surface", () => {
    const { instructions } = buildInteractiveAgentConfig("ws_1");
    expect(instructions).toContain("search_tools");
    expect(instructions).toContain("load_tools");
    expect(instructions).not.toMatch(/sandbox|shell|file system/i);
    expect(instructions).not.toMatch(/[\u2013\u2014]/);
  });
});

// The provider sees every pin on every turn, and the assistant calls a pin
// with no person in the loop. So a pin must be a read that needs no approval.
describe("the interactive agent's pins", () => {
  it("pins seven distinct capabilities", () => {
    expect(new Set(INTERACTIVE_AGENT_CAPABILITIES).size).toBe(7);
    expect(INTERACTIVE_AGENT_CAPABILITIES).toHaveLength(7);
  });

  it("covers runs, spend, approvals and agents", () => {
    expect(INTERACTIVE_AGENT_CAPABILITIES).toEqual(
      expect.arrayContaining([
        "list_runs",
        "get_spend",
        "list_approvals",
        "list_agents",
      ]),
    );
  });

  it.each(INTERACTIVE_AGENT_CAPABILITIES)(
    "%s is a registered read on the agent surface that needs no approval",
    (name) => {
      const cap = getCapability(name);
      expect(cap, `${name} is not registered`).toBeDefined();
      if (!cap) return;
      expect(getSurfaces(cap)).toContain("agent");
      expect(cap.mutates).toBe(false);
      expect(capabilityMutates(cap)).toBe(false);
      expect(cap.agent?.requiresApproval).toBe(false);
      expect(cap.agent?.riskLevel).toBe("low");
    },
  );
});

describe("computeConfigChecksum", () => {
  it("is deterministic regardless of object key order", () => {
    const a = computeConfigChecksum({ x: 1, y: [{ b: 2, a: 1 }] });
    const b = computeConfigChecksum({ y: [{ a: 1, b: 2 }], x: 1 });
    expect(a).toBe(b);
  });

  it("changes when the config content changes", () => {
    const a = computeConfigChecksum({ x: 1 });
    const b = computeConfigChecksum({ x: 2 });
    expect(a).not.toBe(b);
  });

  it("ignores undefined-valued keys", () => {
    const a = computeConfigChecksum({ x: 1, y: undefined });
    const b = computeConfigChecksum({ x: 1 });
    expect(a).toBe(b);
  });

  it("produces a 64-char hex sha-256 digest", () => {
    expect(computeConfigChecksum({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isManagedAgentType", () => {
  it("is true only for the interactive-chat product-managed type", () => {
    expect(isManagedAgentType(INTERACTIVE_AGENT_TYPE)).toBe(true);
  });

  it("is false for a customer-created agent type", () => {
    expect(isManagedAgentType("coding")).toBe(false);
    expect(isManagedAgentType("workflow")).toBe(false);
    expect(isManagedAgentType("")).toBe(false);
  });
});
