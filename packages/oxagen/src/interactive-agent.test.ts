import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_AGENT_SLUG,
  INTERACTIVE_AGENT_SKILLS,
  INTERACTIVE_AGENT_TYPE,
  buildInteractiveAgentConfig,
  computeConfigChecksum,
  isManagedAgentType,
} from "./interactive-agent";
import { agentDefinitionConfigSchema } from "./agent-schema";

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

  it("loads every builtin skill as an agentTool of type skill", () => {
    const config = buildInteractiveAgentConfig("ws_1");
    const skillRefs = config.agentTools
      .filter((t) => t.type === "skill")
      .map((t) => t.ref);
    for (const slug of INTERACTIVE_AGENT_SKILLS) {
      expect(skillRefs).toContain(slug);
    }
  });

  it("includes non-empty instructions", () => {
    const config = buildInteractiveAgentConfig("ws_1");
    expect(config.instructions && config.instructions.length).toBeGreaterThan(
      0,
    );
  });
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
