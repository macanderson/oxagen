import { describe, expect, it } from "vitest";
import {
  mapSuggestionToPrefill,
  planRoleAssignment,
  resolveSuggestedRole,
  DEFAULT_AGENT_ROLE_NAME,
} from "./suggestion-mapping";
import type {
  AgentSuggestion,
  AgentSuggestedRole,
} from "@/lib/workbench/agents";

// A minimal, well-formed suggestion. Individual tests override slices of it to
// pin down each mapping branch (agentType → codeFeatures, trigger fan-out,
// graph defaults) without re-stating the whole object.
function suggestion(overrides: Partial<AgentSuggestion> = {}): AgentSuggestion {
  return {
    slug: "release-notes-writer",
    name: "Release Notes Writer",
    description: "Drafts changelogs from merged PRs.",
    agentType: "custom",
    config: {
      graph: {
        ontologyId: "ont_eng",
        mode: "read",
        retrieval: { strategy: "hybrid" },
        budget: { maxHops: 3, maxNodes: 60 },
      },
      agentTools: [{ type: "skill", ref: "changelog" }],
      triggers: [{ type: "manual", enabled: true }],
      instructions: "You draft release notes.",
    },
    ...overrides,
  } as AgentSuggestion;
}

describe("mapSuggestionToPrefill", () => {
  it("maps identity, instructions, tools and graph fields straight through", () => {
    const p = mapSuggestionToPrefill(suggestion());
    expect(p.name).toBe("Release Notes Writer");
    expect(p.slug).toBe("release-notes-writer");
    expect(p.description).toBe("Drafts changelogs from merged PRs.");
    expect(p.instructions).toBe("You draft release notes.");
    expect(p.agentTools).toEqual([{ type: "skill", ref: "changelog" }]);
    expect(p.ontologyId).toBe("ont_eng");
    expect(p.graphMode).toBe("read");
    expect(p.strategy).toBe("hybrid");
    expect(p.maxHops).toBe(3);
    expect(p.maxNodes).toBe(60);
  });

  it("flags code features when agentType is code", () => {
    expect(mapSuggestionToPrefill(suggestion()).codeFeatures).toBe(false);
    expect(
      mapSuggestionToPrefill(suggestion({ agentType: "code" })).codeFeatures,
    ).toBe(true);
  });

  it("fans schedule and event triggers into the single-row UI fields", () => {
    const p = mapSuggestionToPrefill(
      suggestion({
        config: {
          ...suggestion().config,
          triggers: [
            { type: "schedule", schedule: "0 9 * * 1", enabled: true },
            {
              type: "event",
              eventSource: "github_repo",
              eventType: "push",
              connectionId: "conn_1",
              enabled: true,
            },
          ],
        },
      }),
    );
    expect(p.manualEnabled).toBe(false);
    expect(p.scheduleCron).toBe("0 9 * * 1");
    expect(p.eventSource).toBe("github_repo");
    expect(p.eventType).toBe("push");
    expect(p.eventConnection).toBe("conn_1");
  });

  it("defaults to manual when the suggestion has no triggers", () => {
    const p = mapSuggestionToPrefill(
      suggestion({
        config: { ...suggestion().config, triggers: [] },
      }),
    );
    expect(p.manualEnabled).toBe(true);
    expect(p.scheduleCron).toBe("");
    expect(p.eventSource).toBe("");
  });

  it("never carries recommendations into the wizard's persisted prefill state", () => {
    // Recommendations are catalog "connect this next" hints, not agent config —
    // the builder holds them in component state and renders them as a panel,
    // never as prefill (they'd be un-equippable). The prefill shape must stay
    // free of them so a saved draft never accidentally references a tool the
    // workspace doesn't have.
    const p = mapSuggestionToPrefill(suggestion());
    expect(Object.keys(p)).not.toContain("recommendations");
    // The only tools in prefill are the ones already available (config.agentTools).
    expect(p.agentTools).toEqual([{ type: "skill", ref: "changelog" }]);
  });

  // ── suggested role (Agent RBAC Phase 5b) ──────────────────────────────────

  it("pre-selects the suggested role when the contract returned one", () => {
    const p = mapSuggestionToPrefill(suggestion(), {
      roleName: "Agent Observer",
      reason: "Reads and answers only.",
    });
    expect(p.roleName).toBe("Agent Observer");
  });

  it("falls back to Agent Contributor when the suggestion carries no role", () => {
    // Both shapes a pre-5b / non-emitting producer can present.
    expect(mapSuggestionToPrefill(suggestion()).roleName).toBe(
      "Agent Contributor",
    );
    expect(mapSuggestionToPrefill(suggestion(), undefined).roleName).toBe(
      DEFAULT_AGENT_ROLE_NAME,
    );
    expect(DEFAULT_AGENT_ROLE_NAME).toBe("Agent Contributor");
  });

  it("carries an Operator suggestion through unchanged", () => {
    const p = mapSuggestionToPrefill(suggestion(), {
      roleName: "Agent Operator",
      reason: "Runs unattended and needs high-risk actions.",
    });
    expect(p.roleName).toBe("Agent Operator");
  });
});

describe("resolveSuggestedRole — deterministic validation is the authority", () => {
  const OPTIONS = [
    { roleName: "Agent Observer", withinCeiling: true },
    { roleName: "Agent Contributor", withinCeiling: true },
    // Above the viewer's own grants — the picker renders it disabled.
    { roleName: "Agent Operator", withinCeiling: false },
  ];

  it("accepts a suggested role the picker actually offers", () => {
    expect(resolveSuggestedRole("Agent Observer", OPTIONS)).toEqual({
      roleName: "Agent Observer",
      aiSelected: true,
    });
  });

  it("refuses a role above the viewer's delegation ceiling and falls back", () => {
    // The AI may not select past what the human could pick by hand.
    expect(resolveSuggestedRole("Agent Operator", OPTIONS)).toEqual({
      roleName: DEFAULT_AGENT_ROLE_NAME,
      aiSelected: false,
    });
  });

  it("refuses a role the org does not offer at all", () => {
    expect(
      resolveSuggestedRole("Agent Legacy (unrestricted)", OPTIONS),
    ).toEqual({ roleName: DEFAULT_AGENT_ROLE_NAME, aiSelected: false });
    expect(resolveSuggestedRole("Deploy Bot", OPTIONS).aiSelected).toBe(false);
  });

  it("keeps the suggestion when the options failed to load (contract stays the authority)", () => {
    expect(resolveSuggestedRole("Agent Operator", [])).toEqual({
      roleName: "Agent Operator",
      aiSelected: true,
    });
  });
});

describe("planRoleAssignment — what a draft save writes", () => {
  it("assigns a suggested Observer over the auto-assigned create default", () => {
    // A freshly-created agent already holds "Agent Contributor"; an AI
    // suggestion of Observer must narrow it through assign_agent_role.
    expect(
      planRoleAssignment({
        selectedRoleName: "Agent Observer",
        persistedRoleName: DEFAULT_AGENT_ROLE_NAME,
      }),
    ).toEqual({ assign: "Agent Observer", revoke: "Agent Contributor" });
  });

  it("assigns a suggested Operator over the create default", () => {
    expect(
      planRoleAssignment({
        selectedRoleName: "Agent Operator",
        persistedRoleName: DEFAULT_AGENT_ROLE_NAME,
      }),
    ).toEqual({ assign: "Agent Operator", revoke: "Agent Contributor" });
  });

  it("writes nothing when the suggestion (or its fallback) is already the persisted role", () => {
    // This is the no-suggestedRole path: mapSuggestionToPrefill falls back to
    // "Agent Contributor", which is exactly what create auto-assigned.
    const roleName = mapSuggestionToPrefill(suggestion()).roleName;
    expect(
      planRoleAssignment({
        selectedRoleName: roleName,
        persistedRoleName: DEFAULT_AGENT_ROLE_NAME,
      }),
    ).toEqual({ assign: null });
  });

  it("assigns without a revoke for a pre-RBAC agent holding no role", () => {
    expect(
      planRoleAssignment({
        selectedRoleName: "Agent Observer",
        persistedRoleName: null,
      }),
    ).toEqual({ assign: "Agent Observer" });
  });

  it("replaces the loaded role on an edit", () => {
    expect(
      planRoleAssignment({
        selectedRoleName: "Agent Contributor",
        persistedRoleName: "Agent Observer",
      }),
    ).toEqual({ assign: "Agent Contributor", revoke: "Agent Observer" });
  });
});

describe("suggestion → save: the whole AI-drafted role chain", () => {
  const OPTIONS = [
    { roleName: "Agent Observer", withinCeiling: true },
    { roleName: "Agent Contributor", withinCeiling: true },
    { roleName: "Agent Operator", withinCeiling: true },
  ];

  /** Exactly what the builder does: prefill → validate → plan the save. */
  function chain(suggestedRole?: AgentSuggestedRole) {
    const prefill = mapSuggestionToPrefill(suggestion(), suggestedRole);
    const resolved = resolveSuggestedRole(prefill.roleName, OPTIONS);
    return {
      resolved,
      plan: planRoleAssignment({
        selectedRoleName: resolved.roleName,
        // Right after create, the backend has auto-assigned the default.
        persistedRoleName: DEFAULT_AGENT_ROLE_NAME,
      }),
    };
  }

  it("a read-only suggestion saves as Agent Observer", () => {
    const { resolved, plan } = chain({
      roleName: "Agent Observer",
      reason: "Reads and answers only.",
    });
    expect(resolved.aiSelected).toBe(true);
    expect(plan.assign).toBe("Agent Observer");
  });

  it("an unattended high-risk suggestion saves as Agent Operator", () => {
    const { plan } = chain({
      roleName: "Agent Operator",
      reason: "Runs unattended and needs high-risk actions.",
    });
    expect(plan.assign).toBe("Agent Operator");
    expect(plan.revoke).toBe("Agent Contributor");
  });

  it("no suggested role ⇒ Agent Contributor, and no role write at all", () => {
    const { resolved, plan } = chain(undefined);
    expect(resolved.roleName).toBe("Agent Contributor");
    expect(plan.assign).toBeNull();
  });
});
