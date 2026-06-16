/**
 * agent-ui.test.ts — pure helper tests (slugify, default config, summaries).
 */
import { describe, it, expect } from "vitest";
import {
  slugify,
  defaultAgentConfig,
  summarizeTrigger,
  LIFECYCLE_BADGE,
  DEPLOYMENT_BADGE,
  TOOL_TYPE_LABEL,
  TRIGGER_TYPE_LABEL,
} from "./agent-ui";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Repo Review Agent")).toBe("repo-review-agent");
  });

  it("collapses runs of non-alphanumerics to a single hyphen", () => {
    expect(slugify("Foo   __  Bar!!")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });

  it("returns empty string for non-alphanumeric input", () => {
    expect(slugify("???")).toBe("");
  });

  it("produces a slug that matches the create-contract regex", () => {
    const slug = slugify("My Cool Agent 2");
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("defaultAgentConfig", () => {
  it("binds the supplied ontology id and seeds a read/hybrid config", () => {
    const cfg = defaultAgentConfig("wrk_123");
    expect(cfg.graph.ontologyId).toBe("wrk_123");
    expect(cfg.graph.mode).toBe("read");
    expect(cfg.graph.retrieval.strategy).toBe("hybrid");
    expect(cfg.graph.budget.maxHops).toBe(3);
    expect(cfg.graph.budget.maxNodes).toBe(50);
    expect(cfg.agentTools).toEqual([]);
    expect(cfg.triggers).toEqual([]);
  });
});

describe("summarizeTrigger", () => {
  it("summarises a schedule trigger with its cron", () => {
    expect(summarizeTrigger({ triggerType: "schedule", schedule: "0 9 * * 1" })).toBe(
      "cron: 0 9 * * 1",
    );
  });

  it("summarises an event trigger with source and type", () => {
    expect(
      summarizeTrigger({ triggerType: "event", eventSource: "github_repo", eventType: "push" }),
    ).toBe("github_repo · push");
  });

  it("falls back to 'manual invocation' for a manual trigger", () => {
    expect(summarizeTrigger({ triggerType: "manual" })).toBe("manual invocation");
  });

  it("falls back to 'event' when an event trigger has no source/type", () => {
    expect(summarizeTrigger({ triggerType: "event" })).toBe("event");
  });
});

describe("badge maps", () => {
  it("has a label+variant for every lifecycle status", () => {
    for (const key of ["draft", "active", "archived"] as const) {
      expect(LIFECYCLE_BADGE[key].label.length).toBeGreaterThan(0);
    }
  });

  it("has a label+variant for every deployment status", () => {
    for (const key of ["active", "inactive"] as const) {
      expect(DEPLOYMENT_BADGE[key].label.length).toBeGreaterThan(0);
    }
  });

  it("labels every tool and trigger type", () => {
    expect(TOOL_TYPE_LABEL.mcp_server).toBe("MCP server");
    expect(TRIGGER_TYPE_LABEL.event).toBe("Event");
  });
});
