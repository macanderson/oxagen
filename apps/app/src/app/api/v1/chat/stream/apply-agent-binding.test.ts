import { describe, it, expect } from "vitest";
import {
  applyAgentBinding,
  type AgentBindingDefinition,
} from "./apply-agent-binding";

function def(
  overrides: {
    instructions?: string | null;
    agentTools?: Array<{ type: string; ref: string }>;
  } = {},
): AgentBindingDefinition {
  return {
    config: {
      instructions: overrides.instructions,
      agentTools: overrides.agentTools ?? [],
    },
  };
}

describe("applyAgentBinding", () => {
  it("returns unchanged inputs for a bare definition", () => {
    const result = applyAgentBinding({
      def: def(),
      serverAllowlist: ["srv_1"],
    });
    expect(result).toEqual({ instructions: "", serverAllowlist: ["srv_1"] });
  });

  it("appends the definition's instructions (trimmed)", () => {
    const result = applyAgentBinding({
      def: def({ instructions: "  Be concise.  " }),
      serverAllowlist: [],
    });
    expect(result.instructions).toBe("Be concise.");
  });

  it("treats null/empty instructions as no instructions", () => {
    expect(
      applyAgentBinding({
        def: def({ instructions: null }),
        serverAllowlist: [],
      }).instructions,
    ).toBe("");
    expect(
      applyAgentBinding({
        def: def({ instructions: "   " }),
        serverAllowlist: [],
      }).instructions,
    ).toBe("");
  });

  it("merges mcp_server agentTools into the server allowlist (union)", () => {
    const result = applyAgentBinding({
      def: def({
        agentTools: [
          { type: "mcp_server", ref: "srv_2" },
          { type: "mcp_server", ref: "srv_1" },
          { type: "function", ref: "not_a_server" },
        ],
      }),
      serverAllowlist: ["srv_1"],
    });
    expect(result.serverAllowlist).toEqual(["srv_1", "srv_2"]);
  });

  it("ignores every agentTool type that is not an mcp_server (ADR-041: no skills, no subagents)", () => {
    const result = applyAgentBinding({
      def: def({
        agentTools: [
          { type: "skill", ref: "ts-review" },
          { type: "agent", ref: "sub" },
          { type: "function", ref: "fn" },
        ],
      }),
      serverAllowlist: [],
    });
    expect(result.serverAllowlist).toEqual([]);
  });

  it("applies instructions and servers together", () => {
    const result = applyAgentBinding({
      def: def({
        instructions: "Prefer TypeScript.",
        agentTools: [{ type: "mcp_server", ref: "srv_gh" }],
      }),
      serverAllowlist: [],
    });
    expect(result).toEqual({
      instructions: "Prefer TypeScript.",
      serverAllowlist: ["srv_gh"],
    });
  });
});

// ── Agent RBAC Phase 4a: MCP rule intersection (spec §3.7) ───────────────────
describe("applyAgentBinding — mcp rule intersection", () => {
  const GH_DEF = def({
    agentTools: [
      { type: "mcp_server", ref: "srv_gh" },
      { type: "mcp_server", ref: "srv_slack" },
    ],
  });
  const NAMES = { srv_gh: "GitHub", srv_slack: "Slack", srv_body: "Linear" };

  it("drops a server whose EVERY tool the rules deny (union → intersection)", () => {
    const result = applyAgentBinding({
      def: GH_DEF,
      serverAllowlist: ["srv_body"],
      mcp: {
        scope: { ruleSets: [[{ pattern: "github:*", effect: "deny" }]] },
        serverNamesById: NAMES,
      },
    });
    // srv_gh (name "GitHub") is fully denied and drops — from the AGENT's own
    // declared servers, proving the binding can no longer only widen.
    expect(result.serverAllowlist).toEqual(["srv_body", "srv_slack"]);
  });

  it("keeps a partially-denied server (some tools survive → per-call gate governs)", () => {
    const result = applyAgentBinding({
      def: GH_DEF,
      serverAllowlist: [],
      mcp: {
        scope: {
          ruleSets: [[{ pattern: "github:delete_*", effect: "deny" }]],
        },
        serverNamesById: NAMES,
      },
    });
    expect(result.serverAllowlist).toEqual(["srv_gh", "srv_slack"]);
  });

  it("keeps an id with no name mapping (conservative — per-call gate enforces)", () => {
    const result = applyAgentBinding({
      def: def({ agentTools: [{ type: "mcp_server", ref: "srv_unknown" }] }),
      serverAllowlist: [],
      mcp: {
        scope: { ruleSets: [[{ pattern: "*", effect: "deny" }]] },
        serverNamesById: {},
      },
    });
    expect(result.serverAllowlist).toEqual(["srv_unknown"]);
  });

  it("a universal '*' deny drops every mapped server", () => {
    const result = applyAgentBinding({
      def: GH_DEF,
      serverAllowlist: ["srv_body"],
      mcp: {
        scope: { ruleSets: [[{ pattern: "*", effect: "deny" }]] },
        serverNamesById: NAMES,
      },
    });
    expect(result.serverAllowlist).toEqual([]);
  });

  it("ask/allow rules never drop a server (only full denial does)", () => {
    const result = applyAgentBinding({
      def: GH_DEF,
      serverAllowlist: [],
      mcp: {
        scope: { ruleSets: [[{ pattern: "github:*", effect: "ask" }]] },
        serverNamesById: NAMES,
      },
    });
    expect(result.serverAllowlist).toEqual(["srv_gh", "srv_slack"]);
  });

  it("no mcp input → byte-identical to the historical additive union", () => {
    const base = {
      def: GH_DEF,
      serverAllowlist: ["srv_body", "srv_gh"],
    };
    const without = applyAgentBinding(base);
    const withUndefinedScope = applyAgentBinding({
      ...base,
      mcp: { scope: undefined, serverNamesById: NAMES },
    });
    const expected = ["srv_body", "srv_gh", "srv_slack"];
    expect(without.serverAllowlist).toEqual(expected);
    // An mcp input whose scope is undefined (run with no rules) is inert too.
    expect(withUndefinedScope).toEqual(without);
  });
});
