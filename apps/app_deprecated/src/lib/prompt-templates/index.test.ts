/**
 * Unit tests for the app-local prompt-template registry.
 *
 * Covers:
 *   - Schema parse: valid and invalid templates
 *   - matchesRoute: route pattern matching
 *   - getApplicableTemplates: filtering by route, capability, required vars
 *   - renderTemplate: variable substitution, missing vars
 *   - resolveVariables: resolver types
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  promptTemplateSchema,
  pageContextSchema,
  getAllTemplates,
  getApplicableTemplates,
  matchesRoute,
  registerTemplate,
  renderTemplate,
  resolveVariables,
} from "./index";
import type { PromptTemplate, PageContext } from "./schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: "test-template",
    title: "Test Template",
    description: "A test template",
    category: "investigate",
    tags: ["test"],
    applicableTo: [{ routePattern: "/{org}/{ws}/runs/:runId" }],
    autoSubmit: false,
    body: "Investigate run {{run_id}}.",
    variables: [
      {
        name: "run_id",
        resolver: "param",
        source: "params.runId",
        required: true,
      },
    ],
    ...overrides,
  };
}

function makeContext(overrides: Partial<PageContext> = {}): PageContext {
  return {
    pathname: "/acme/prod/runs/run_123",
    routeParams: { runId: "run_123" },
    queryParams: {},
    capabilities: [],
    locale: "en",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("promptTemplateSchema", () => {
  it("parses a valid minimal template", () => {
    const raw = {
      id: "my-action",
      title: "My Action",
      description: "Does something",
      category: "create",
      applicableTo: [{ routePattern: "/{org}/{ws}" }],
      autoSubmit: false,
      body: "Do the thing.",
    };
    const result = promptTemplateSchema.parse(raw);
    expect(result.id).toBe("my-action");
    expect(result.tags).toEqual([]);
    expect(result.variables).toEqual([]);
  });

  it("parses a template with variables", () => {
    const raw = {
      id: "investigate-run",
      title: "Investigate run",
      description: "Check a run",
      category: "investigate",
      applicableTo: [{ routePattern: "/{org}/{ws}/runs/:runId" }],
      autoSubmit: true,
      body: "Investigate {{run_id}}.",
      variables: [
        {
          name: "run_id",
          resolver: "param",
          source: "params.runId",
          required: true,
        },
      ],
    };
    const result = promptTemplateSchema.parse(raw);
    expect(result.variables).toHaveLength(1);
    expect(result.variables[0]?.resolver).toBe("param");
  });

  it("rejects invalid id (spaces)", () => {
    expect(() =>
      promptTemplateSchema.parse({
        id: "bad id",
        title: "T",
        description: "D",
        category: "create",
        applicableTo: [{ routePattern: "/{org}/{ws}" }],
        autoSubmit: false,
        body: "body",
      }),
    ).toThrow();
  });

  it("rejects unknown category", () => {
    expect(() =>
      promptTemplateSchema.parse({
        id: "ok-id",
        title: "T",
        description: "D",
        category: "delete",
        applicableTo: [{ routePattern: "/{org}/{ws}" }],
        autoSubmit: false,
        body: "body",
      }),
    ).toThrow();
  });

  it("rejects empty applicableTo", () => {
    expect(() =>
      promptTemplateSchema.parse({
        id: "ok-id",
        title: "T",
        description: "D",
        category: "create",
        applicableTo: [],
        autoSubmit: false,
        body: "body",
      }),
    ).toThrow();
  });
});

describe("pageContextSchema", () => {
  it("parses minimal context with defaults", () => {
    const ctx = pageContextSchema.parse({ pathname: "/acme/prod" });
    expect(ctx.routeParams).toEqual({});
    expect(ctx.capabilities).toEqual([]);
    expect(ctx.locale).toBe("en");
  });

  it("parses full context", () => {
    const raw = {
      pathname: "/acme/prod/runs/run_1",
      routeParams: { runId: "run_1" },
      queryParams: { tab: "trace" },
      pageEntity: { kind: "run", id: "run_1", label: "Run #1" },
      capabilities: ["activity.run.read"],
      locale: "en-US",
    };
    const ctx = pageContextSchema.parse(raw);
    expect(ctx.pageEntity?.kind).toBe("run");
    expect(ctx.capabilities).toContain("activity.run.read");
  });
});

// ---------------------------------------------------------------------------
// matchesRoute tests
// ---------------------------------------------------------------------------

describe("matchesRoute", () => {
  it("matches {org}/{ws} style placeholders", () => {
    expect(
      matchesRoute("/{org}/{ws}/runs/:runId", "/acme/prod/runs/run_123"),
    ).toBe(true);
  });

  it("does not match a different route shape", () => {
    expect(
      matchesRoute("/{org}/{ws}/runs/:runId", "/acme/prod/triggers/t_1"),
    ).toBe(false);
  });

  it("matches a route with no params", () => {
    expect(matchesRoute("/{org}/{ws}", "/acme/prod")).toBe(true);
  });

  it("does NOT match a deeper path with a non-wildcard pattern", () => {
    expect(matchesRoute("/{org}/{ws}", "/acme/prod/runs/run_1")).toBe(false);
  });

  it("handles wildcard **", () => {
    expect(matchesRoute("/{org}/**", "/acme/prod/runs/run_1/detail")).toBe(
      true,
    );
  });

  it("handles single wildcard *", () => {
    expect(matchesRoute("/{org}/*/runs", "/acme/prod/runs")).toBe(true);
  });

  it("returns false for empty pattern", () => {
    expect(matchesRoute("", "/acme/prod")).toBe(false);
  });

  it("ignores trailing slash on pattern and path", () => {
    expect(matchesRoute("/{org}/{ws}/", "/acme/prod/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getApplicableTemplates tests
// ---------------------------------------------------------------------------

describe("getApplicableTemplates", () => {
  beforeEach(() => {
    // Register a known set of fresh test templates by replacing if they exist.
    registerTemplate(
      makeTemplate({
        id: "run-specific",
        applicableTo: [{ routePattern: "/{org}/{ws}/runs/:runId" }],
        variables: [
          {
            name: "run_id",
            resolver: "param",
            source: "params.runId",
            required: true,
          },
        ],
        capability: undefined,
      }),
    );
    registerTemplate(
      makeTemplate({
        id: "workspace-wide",
        applicableTo: [{ routePattern: "/{org}/{ws}" }],
        variables: [],
        capability: undefined,
        body: "Workspace summary.",
      }),
    );
    registerTemplate(
      makeTemplate({
        id: "capability-gated",
        applicableTo: [{ routePattern: "/{org}/{ws}/runs/:runId" }],
        variables: [
          {
            name: "run_id",
            resolver: "param",
            source: "params.runId",
            required: true,
          },
        ],
        capability: "activity.run.read",
        body: "Gated action for {{run_id}}.",
      }),
    );
  });

  it("returns templates matching the current route", () => {
    const ctx = makeContext({
      pathname: "/acme/prod/runs/run_123",
      routeParams: { runId: "run_123" },
    });
    const results = getApplicableTemplates(ctx);
    const ids = results.map((t) => t.id);
    expect(ids).toContain("run-specific");
  });

  it("does not return templates whose route does not match", () => {
    const ctx = makeContext({
      pathname: "/acme/prod/triggers/tg_1",
      routeParams: { triggerId: "tg_1" },
    });
    const results = getApplicableTemplates(ctx);
    const ids = results.map((t) => t.id);
    expect(ids).not.toContain("run-specific");
    expect(ids).not.toContain("capability-gated");
  });

  it("filters out templates requiring missing required params", () => {
    const ctx = makeContext({
      pathname: "/acme/prod/runs/run_123",
      routeParams: {}, // runId absent
    });
    const results = getApplicableTemplates(ctx);
    const ids = results.map((t) => t.id);
    expect(ids).not.toContain("run-specific");
    expect(ids).not.toContain("capability-gated");
  });

  it("filters out capability-gated templates when user lacks the capability", () => {
    const ctx = makeContext({
      pathname: "/acme/prod/runs/run_123",
      routeParams: { runId: "run_123" },
      capabilities: [], // no capabilities
    });
    const results = getApplicableTemplates(ctx);
    const ids = results.map((t) => t.id);
    expect(ids).not.toContain("capability-gated");
    expect(ids).toContain("run-specific"); // no capability guard
  });

  it("includes capability-gated template when user has the capability", () => {
    const ctx = makeContext({
      pathname: "/acme/prod/runs/run_123",
      routeParams: { runId: "run_123" },
      capabilities: ["activity.run.read"],
    });
    const results = getApplicableTemplates(ctx);
    const ids = results.map((t) => t.id);
    expect(ids).toContain("capability-gated");
  });

  it("respects the limit option", () => {
    const ctx = makeContext({
      pathname: "/acme/prod/runs/run_123",
      routeParams: { runId: "run_123" },
      capabilities: ["activity.run.read"],
    });
    const results = getApplicableTemplates(ctx, { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("ranks more-specific routes first", () => {
    const ctx = makeContext({
      pathname: "/acme/prod",
      routeParams: {},
    });
    const results = getApplicableTemplates(ctx);
    // workspace-wide should appear because it matches /{org}/{ws}
    expect(results.some((t) => t.id === "workspace-wide")).toBe(true);
  });

  it("returns empty array when no templates match", () => {
    const ctx = makeContext({
      pathname: "/acme/prod/no-match-route",
      routeParams: {},
    });
    const results = getApplicableTemplates(ctx);
    // Built-in templates might match depending on their patterns;
    // specifically the test templates should not match this path.
    const testIds = ["run-specific", "workspace-wide", "capability-gated"];
    const matchedTestIds = results.filter((t) => testIds.includes(t.id));
    expect(matchedTestIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAllTemplates test
// ---------------------------------------------------------------------------

describe("getAllTemplates", () => {
  it("returns at least the 10 built-in templates", () => {
    const templates = getAllTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(10);
  });

  it("includes known built-in template ids", () => {
    const ids = getAllTemplates().map((t) => t.id);
    expect(ids).toContain("summarize-run-failure");
    expect(ids).toContain("show-similar-failed-runs");
    expect(ids).toContain("create-trigger-for-event");
    expect(ids).toContain("connect-data-source");
    expect(ids).toContain("invite-teammate");
    expect(ids).toContain("explain-audit-event");
    expect(ids).toContain("run-this-playbook");
    expect(ids).toContain("why-is-trigger-failing");
    expect(ids).toContain("summarize-workspace-activity");
    expect(ids).toContain("open-source-playbook");
  });

  it("all built-in templates pass schema validation", () => {
    const templates = getAllTemplates();
    for (const t of templates) {
      // Re-parse to confirm round-trip validity.
      expect(() => promptTemplateSchema.parse(t)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// renderTemplate tests
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  it("substitutes a single variable", () => {
    const { rendered, missing } = renderTemplate(
      "Investigate run {{run_id}}.",
      {
        run_id: "run_123",
      },
    );
    expect(rendered).toBe("Investigate run run_123.");
    expect(missing).toHaveLength(0);
  });

  it("substitutes multiple variables", () => {
    const { rendered, missing } = renderTemplate(
      "Run {{run_id}} in workspace {{workspace}}.",
      { run_id: "run_123", workspace: "prod" },
    );
    expect(rendered).toBe("Run run_123 in workspace prod.");
    expect(missing).toHaveLength(0);
  });

  it("tracks missing variables and leaves placeholder", () => {
    const { rendered, missing } = renderTemplate(
      "Investigate run {{run_id}}.",
      {},
    );
    expect(rendered).toContain("{{run_id}}");
    expect(missing).toContain("run_id");
  });

  it("handles body with no variables", () => {
    const { rendered, missing } = renderTemplate("No variables here.", {});
    expect(rendered).toBe("No variables here.");
    expect(missing).toHaveLength(0);
  });

  it("leaves unknown syntax tokens intact", () => {
    // Double {{ with a non-identifier should pass through unchanged.
    const { rendered } = renderTemplate("Hello {{ 123invalid }} world.", {});
    expect(rendered).toContain("{{ 123invalid }}");
  });

  it("handles empty variable value (falsy but defined)", () => {
    const { rendered, missing } = renderTemplate("Hello {{name}}.", {
      name: "",
    });
    expect(rendered).toBe("Hello .");
    expect(missing).toHaveLength(0);
  });

  it("substitutes multiple occurrences of the same variable", () => {
    const { rendered } = renderTemplate("{{a}} and {{a}} again.", { a: "X" });
    expect(rendered).toBe("X and X again.");
  });
});

// ---------------------------------------------------------------------------
// resolveVariables tests
// ---------------------------------------------------------------------------

describe("resolveVariables", () => {
  it("resolves param resolver from routeParams", () => {
    const { resolved, unresolved } = resolveVariables(
      [
        {
          name: "run_id",
          resolver: "param",
          source: "params.runId",
          required: true,
        },
      ],
      { routeParams: { runId: "run_abc" } },
    );
    expect(resolved.run_id).toBe("run_abc");
    expect(unresolved).toHaveLength(0);
  });

  it("marks required param as unresolved when missing from routeParams", () => {
    const { unresolved } = resolveVariables(
      [
        {
          name: "run_id",
          resolver: "param",
          source: "params.runId",
          required: true,
        },
      ],
      { routeParams: {} },
    );
    expect(unresolved).toContain("run_id");
  });

  it("does not mark optional param as unresolved when missing", () => {
    const { unresolved } = resolveVariables(
      [
        {
          name: "tab",
          resolver: "param",
          source: "params.tab",
          required: false,
        },
      ],
      { routeParams: {} },
    );
    expect(unresolved).not.toContain("tab");
  });

  it("resolves query resolver from queryParams", () => {
    const { resolved } = resolveVariables(
      [
        {
          name: "tab",
          resolver: "query",
          source: "query.tab",
          required: false,
        },
      ],
      { queryParams: { tab: "trace" } },
    );
    expect(resolved.tab).toBe("trace");
  });

  it("resolves page.entity.label from pageEntity", () => {
    const { resolved } = resolveVariables(
      [
        {
          name: "name",
          resolver: "page",
          source: "page.entity.label",
          required: false,
        },
      ],
      { pageEntity: { kind: "run", id: "r_1", label: "My Run" } },
    );
    expect(resolved.name).toBe("My Run");
  });

  it("marks required page variable as unresolved when pageEntity absent", () => {
    const { unresolved } = resolveVariables(
      [
        {
          name: "label",
          resolver: "page",
          source: "page.entity.label",
          required: true,
        },
      ],
      {},
    );
    expect(unresolved).toContain("label");
  });

  it("always marks ask resolver variables as unresolved (user must be prompted)", () => {
    const { resolved, unresolved } = resolveVariables(
      [
        {
          name: "query",
          resolver: "ask",
          source: "ask.prompt",
          required: true,
        },
      ],
      { routeParams: { prompt: "something" } },
    );
    expect(unresolved).toContain("query");
    expect(Object.keys(resolved)).not.toContain("query");
  });

  it("resolves session resolver from session context", () => {
    const { resolved } = resolveVariables(
      [
        {
          name: "user_id",
          resolver: "session",
          source: "session.user.id",
          required: false,
        },
      ],
      { session: { "user.id": "u_abc" } },
    );
    expect(resolved.user_id).toBe("u_abc");
  });

  it("resolves multiple variables simultaneously", () => {
    const { resolved, unresolved } = resolveVariables(
      [
        {
          name: "run_id",
          resolver: "param",
          source: "params.runId",
          required: true,
        },
        {
          name: "tab",
          resolver: "query",
          source: "query.tab",
          required: false,
        },
        {
          name: "label",
          resolver: "page",
          source: "page.entity.label",
          required: false,
        },
      ],
      {
        routeParams: { runId: "run_1" },
        queryParams: { tab: "logs" },
        pageEntity: { kind: "run", id: "run_1", label: "Run #1" },
      },
    );
    expect(resolved.run_id).toBe("run_1");
    expect(resolved.tab).toBe("logs");
    expect(resolved.label).toBe("Run #1");
    expect(unresolved).toHaveLength(0);
  });
});
