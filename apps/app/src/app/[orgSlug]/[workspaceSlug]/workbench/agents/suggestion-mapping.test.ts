import { describe, expect, it } from "vitest";
import { mapSuggestionToPrefill } from "./suggestion-mapping";
import type { AgentSuggestion } from "@/lib/workbench/agents";

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
});
