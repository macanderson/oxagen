/**
 * Unit tests for the narrowest-adequate system-role suggestion
 * (Agent RBAC Phase 5b, docs/specs/agent-rbac/spec.md §4 Phase 5).
 *
 * The three headline cases from the spec — read-only ⇒ Observer, any
 * low/medium-risk mutation ⇒ Contributor, unattended high-risk ⇒ Operator —
 * plus the corners that fall out of AGENT_ROLE_SPECS' real semantics rather
 * than a restated mapping: Operator's vcs/billing/secret carve-out (escalating
 * buys nothing, so it must NOT escalate), Observer's MCP deny-all, Observer's
 * read-mode graph ceiling, and the fact that "unattended" is what separates
 * Contributor from Operator on a high-risk draft.
 */
import { describe, it, expect } from "vitest";
import type { CapabilityAgentMeta } from "./agent-role-defaults";
import {
  suggestNarrowestAgentRole,
  type DraftAgentShape,
} from "./agent-role-suggest";

// A fixed capability table standing in for the live registry. Categories are
// chosen to exercise each branch of the shared computeEffect mapping.
const CAPS: CapabilityAgentMeta[] = [
  // Read-like categories (READ_LIKE_CATEGORIES) — allowed by every role.
  { name: "query_graph", category: "graph", riskLevel: "low" },
  { name: "recall_memory", category: "memory", riskLevel: "low" },
  { name: "list_workspaces", category: "read", riskLevel: "low" },
  // Non-read mutations.
  { name: "write_doc", category: "write", riskLevel: "low" },
  { name: "run_workflow", category: "execution", riskLevel: "medium" },
  // High-risk, NOT in Operator's carve-out → Operator widens it to allow.
  { name: "delete_workspace", category: "destructive", riskLevel: "high" },
  // High-risk and IN the carve-out → stays require_approval even for Operator.
  { name: "reveal_secret", category: "secret", riskLevel: "high" },
  { name: "open_pr", category: "vcs", riskLevel: "high" },
  { name: "charge_customer", category: "billing", riskLevel: "high" },
];

function draft(overrides: Partial<DraftAgentShape> = {}): DraftAgentShape {
  return {
    agentTools: [],
    graphMode: "read",
    triggerTypes: ["manual"],
    ...overrides,
  };
}

function fn(...refs: string[]) {
  return refs.map((ref) => ({ type: "function", ref }));
}

const suggest = (d: DraftAgentShape) => suggestNarrowestAgentRole(d, CAPS);

describe("suggestNarrowestAgentRole — the three spec cases", () => {
  it("suggests Agent Observer for a read/answer-only draft", () => {
    const out = suggest(
      draft({
        agentTools: fn("query_graph", "recall_memory", "list_workspaces"),
      }),
    );
    expect(out.roleName).toBe("Agent Observer");
    expect(out.reason).toMatch(/read/i);
  });

  it("suggests Agent Observer for a draft with no tools at all", () => {
    expect(suggest(draft()).roleName).toBe("Agent Observer");
  });

  it("suggests Agent Contributor as soon as one low/medium-risk mutation appears", () => {
    expect(
      suggest(draft({ agentTools: fn("query_graph", "write_doc") })).roleName,
    ).toBe("Agent Contributor");
    expect(suggest(draft({ agentTools: fn("run_workflow") })).roleName).toBe(
      "Agent Contributor",
    );
  });

  it("suggests Agent Operator for an unattended high-risk draft", () => {
    const out = suggest(
      draft({
        agentTools: fn("delete_workspace"),
        triggerTypes: ["schedule"],
      }),
    );
    expect(out.roleName).toBe("Agent Operator");
    expect(out.reason).toMatch(/unattended/i);
  });

  it("treats an event trigger as unattended too", () => {
    expect(
      suggest(
        draft({ agentTools: fn("delete_workspace"), triggerTypes: ["event"] }),
      ).roleName,
    ).toBe("Agent Operator");
  });
});

describe("suggestNarrowestAgentRole — attendance is what separates Contributor from Operator", () => {
  it("keeps a MANUAL high-risk draft at Contributor (a human can answer the approval)", () => {
    const out = suggest(
      draft({ agentTools: fn("delete_workspace"), triggerTypes: ["manual"] }),
    );
    expect(out.roleName).toBe("Agent Contributor");
    expect(out.reason).toMatch(/approval/i);
  });

  it("escalates the same draft once a schedule trigger is added", () => {
    expect(
      suggest(
        draft({
          agentTools: fn("delete_workspace"),
          triggerTypes: ["manual", "schedule"],
        }),
      ).roleName,
    ).toBe("Agent Operator");
  });
});

describe("suggestNarrowestAgentRole — Operator's vcs/billing/secret carve-out", () => {
  // Operator holds these at require_approval exactly like Contributor, so
  // escalating buys the agent nothing — the suggestion must stay narrow.
  it.each(["reveal_secret", "open_pr", "charge_customer"])(
    "does NOT escalate past Contributor for unattended carve-out capability %s",
    (ref) => {
      expect(
        suggest(draft({ agentTools: fn(ref), triggerTypes: ["schedule"] }))
          .roleName,
      ).toBe("Agent Contributor");
    },
  );

  it("still escalates when a carve-out capability sits alongside a non-carve-out high-risk one", () => {
    expect(
      suggest(
        draft({
          agentTools: fn("reveal_secret", "delete_workspace"),
          triggerTypes: ["schedule"],
        }),
      ).roleName,
    ).toBe("Agent Operator");
  });
});

describe("suggestNarrowestAgentRole — resource-scope dimensions", () => {
  it("escalates past Observer when the draft equips an MCP server (Observer denies all MCP)", () => {
    const out = suggest(
      draft({ agentTools: [{ type: "mcp_server", ref: "mcp_srv1" }] }),
    );
    expect(out.roleName).toBe("Agent Contributor");
    expect(out.reason).toMatch(/mcp/i);
  });

  it("escalates an unattended MCP draft to Operator (Contributor's 'ask' has nobody to ask)", () => {
    expect(
      suggest(
        draft({
          agentTools: [{ type: "mcp_server", ref: "mcp_srv1" }],
          triggerTypes: ["schedule"],
        }),
      ).roleName,
    ).toBe("Agent Operator");
  });

  it("escalates past Observer when the draft requests graph extend (Observer caps at read)", () => {
    const out = suggest(draft({ graphMode: "extend" }));
    expect(out.roleName).toBe("Agent Contributor");
    expect(out.reason).toMatch(/graph/i);
  });

  it("ignores skill and subagent tools — no system role constrains those dimensions", () => {
    expect(
      suggest(
        draft({
          agentTools: [
            { type: "skill", ref: "summarization" },
            { type: "agent", ref: "existing-agent" },
            ...fn("query_graph"),
          ],
        }),
      ).roleName,
    ).toBe("Agent Observer");
  });
});

describe("suggestNarrowestAgentRole — unknown capabilities are treated conservatively", () => {
  it("floors an unregistered function ref at Contributor rather than qualifying for Observer", () => {
    // No `agent` metadata ⇒ selectAgentCapabilities' defaults (category "",
    // riskLevel "medium") ⇒ a non-read, medium-risk mutation.
    const out = suggest(draft({ agentTools: fn("some_unknown_capability") }));
    expect(out.roleName).toBe("Agent Contributor");
  });

  it("does not escalate an unknown ref to Operator even when unattended (medium risk, not high)", () => {
    expect(
      suggest(
        draft({
          agentTools: fn("some_unknown_capability"),
          triggerTypes: ["schedule"],
        }),
      ).roleName,
    ).toBe("Agent Contributor");
  });
});

describe("suggestNarrowestAgentRole — provenance", () => {
  it("cites the capability that forced the escalation", () => {
    const out = suggest(draft({ agentTools: fn("write_doc") }));
    expect(out.reason).toContain("write_doc");
  });

  it("cites the MCP server that forced the escalation", () => {
    const out = suggest(
      draft({ agentTools: [{ type: "mcp_server", ref: "mcp_srv1" }] }),
    );
    expect(out.reason).toContain("mcp_srv1");
  });

  it("always returns a non-empty reason and one of the three system roles", () => {
    for (const d of [
      draft(),
      draft({ agentTools: fn("write_doc") }),
      draft({ agentTools: fn("delete_workspace"), triggerTypes: ["schedule"] }),
    ]) {
      const out = suggest(d);
      expect(out.reason.trim().length).toBeGreaterThan(0);
      expect([
        "Agent Observer",
        "Agent Contributor",
        "Agent Operator",
      ]).toContain(out.roleName);
    }
  });

  it("never suggests the spec's back-compat 'Agent Legacy' role (never seeded, Q1)", () => {
    const everything = draft({
      agentTools: [
        ...fn(...CAPS.map((c) => c.name), "unknown_one"),
        { type: "mcp_server", ref: "mcp_srv1" },
      ],
      graphMode: "extend",
      triggerTypes: ["schedule", "event"],
    });
    expect(suggest(everything).roleName).toBe("Agent Operator");
  });
});
