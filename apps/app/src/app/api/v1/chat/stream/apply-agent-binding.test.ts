import { describe, it, expect } from "vitest";
import {
  applyAgentBinding,
  type AgentBindingDefinition,
} from "./apply-agent-binding";

function def(
  overrides: Partial<AgentBindingDefinition> & {
    agentType?: string;
    instructions?: string | null;
    agentTools?: Array<{ type: string; ref: string }>;
  } = {},
): AgentBindingDefinition {
  return {
    agentType: overrides.agentType ?? "assistant",
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
      skills: ["alpha"],
      serverAllowlist: ["srv_1"],
    });
    expect(result.instructions).toBe("");
    expect(result.skills).toEqual(["alpha"]);
    expect(result.serverAllowlist).toEqual(["srv_1"]);
    expect(result.codeMode).toBe(false);
  });

  it("appends the definition's instructions (trimmed)", () => {
    const result = applyAgentBinding({
      def: def({ instructions: "  Be concise.  " }),
      skills: [],
      serverAllowlist: [],
    });
    expect(result.instructions).toBe("Be concise.");
  });

  it("treats null/empty instructions as no instructions", () => {
    expect(
      applyAgentBinding({
        def: def({ instructions: null }),
        skills: [],
        serverAllowlist: [],
      }).instructions,
    ).toBe("");
    expect(
      applyAgentBinding({
        def: def({ instructions: "   " }),
        skills: [],
        serverAllowlist: [],
      }).instructions,
    ).toBe("");
  });

  it("merges skill agentTools into the pinned-skill list (union, order preserved)", () => {
    const result = applyAgentBinding({
      def: def({
        agentTools: [
          { type: "skill", ref: "beta" },
          { type: "skill", ref: "gamma" },
          { type: "function", ref: "ignored_fn" },
          { type: "agent", ref: "ignored_subagent" },
        ],
      }),
      skills: ["alpha"],
      serverAllowlist: [],
    });
    expect(result.skills).toEqual(["alpha", "beta", "gamma"]);
  });

  it("dedupes skills already pinned by the request", () => {
    const result = applyAgentBinding({
      def: def({ agentTools: [{ type: "skill", ref: "alpha" }] }),
      skills: ["alpha"],
      serverAllowlist: [],
    });
    expect(result.skills).toEqual(["alpha"]);
  });

  it("caps the merged skills at 5, body skills keeping priority", () => {
    const result = applyAgentBinding({
      def: def({
        agentTools: [
          { type: "skill", ref: "s3" },
          { type: "skill", ref: "s4" },
          { type: "skill", ref: "s5" },
          { type: "skill", ref: "s6" },
        ],
      }),
      skills: ["s1", "s2"],
      serverAllowlist: [],
    });
    expect(result.skills).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(result.skills).toHaveLength(5);
  });

  it("merges mcp_server agentTools into the server allowlist (union)", () => {
    const result = applyAgentBinding({
      def: def({
        agentTools: [
          { type: "mcp_server", ref: "srv_2" },
          { type: "mcp_server", ref: "srv_1" },
          { type: "skill", ref: "not_a_server" },
        ],
      }),
      skills: [],
      serverAllowlist: ["srv_1"],
    });
    expect(result.serverAllowlist).toEqual(["srv_1", "srv_2"]);
  });

  it("turns code mode on for a code agent (both agentType spellings)", () => {
    for (const agentType of ["code", "coding"]) {
      const result = applyAgentBinding({
        def: def({ agentType }),
        skills: [],
        serverAllowlist: [],
      });
      expect(result.codeMode).toBe(true);
    }
  });

  it("never enters code mode for a non-code agent — the agent definition is the only gate", () => {
    for (const agentType of ["assistant", "research", "support"]) {
      const result = applyAgentBinding({
        def: def({ agentType }),
        skills: [],
        serverAllowlist: [],
      });
      expect(result.codeMode).toBe(false);
    }
  });

  it("applies instructions, skills, servers, and code-mode together", () => {
    const result = applyAgentBinding({
      def: def({
        agentType: "coding",
        instructions: "Prefer TypeScript.",
        agentTools: [
          { type: "skill", ref: "ts-review" },
          { type: "mcp_server", ref: "srv_gh" },
        ],
      }),
      skills: ["security"],
      serverAllowlist: [],
    });
    expect(result).toEqual({
      instructions: "Prefer TypeScript.",
      skills: ["security", "ts-review"],
      serverAllowlist: ["srv_gh"],
      codeMode: true,
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
      skills: [],
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
      skills: [],
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
      skills: [],
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
      skills: [],
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
      skills: [],
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
      skills: ["alpha"],
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
