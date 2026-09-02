import { describe, it, expect } from "vitest";
import { commandMenuSearch, SEARCHABLE_KINDS } from "./command.menu.search";

describe("command.menu.search contract", () => {
  it("is registered on api and agent surfaces", () => {
    expect(commandMenuSearch.name).toBe("search_command_menu");
    expect(commandMenuSearch.surfaces).toContain("api");
    expect(commandMenuSearch.surfaces).toContain("agent");
  });

  it("is scoped and defaults to deny", () => {
    expect(commandMenuSearch.scoped).toBe(true);
    expect(commandMenuSearch.defaultEffect).toBe("deny");
  });

  it("allows all workspace roles", () => {
    expect(commandMenuSearch.defaultRoles.workspace?.Owner).toBe("allow");
    expect(commandMenuSearch.defaultRoles.workspace?.Member).toBe("allow");
    expect(commandMenuSearch.defaultRoles.workspace?.Viewer).toBe("allow");
  });

  it("parses a valid full input", () => {
    const parsed = commandMenuSearch.input.parse({
      kind: "run",
      query: "aex_abc",
      orgSlug: "acme",
      workspaceSlug: "prod",
    });
    expect(parsed.kind).toBe("run");
    expect(parsed.query).toBe("aex_abc");
  });

  it("parses a valid input without kind (cross-kind search)", () => {
    const parsed = commandMenuSearch.input.parse({
      query: "churn",
      orgSlug: "acme",
      workspaceSlug: "prod",
    });
    expect(parsed.kind).toBeUndefined();
  });

  it("rejects missing orgSlug", () => {
    expect(
      commandMenuSearch.input.safeParse({ query: "x", workspaceSlug: "prod" })
        .success,
    ).toBe(false);
  });

  it("rejects a query exceeding 500 chars", () => {
    expect(
      commandMenuSearch.input.safeParse({
        query: "a".repeat(501),
        orgSlug: "x",
        workspaceSlug: "y",
      }).success,
    ).toBe(false);
  });

  it("validates the SEARCHABLE_KINDS list covers all spec §10 entity types", () => {
    const expected = [
      "run",
      "principal",
      "playbook",
      "trigger",
      "event",
      "agent",
    ] as const;
    expect(SEARCHABLE_KINDS).toEqual(expected);
  });

  it("parses a valid output with rows", () => {
    const out = commandMenuSearch.output.parse({
      rows: [
        {
          kind: "run",
          id: "aex_abc123",
          label: "Run #4221",
          scope: "Workspace: Production",
          contextLine: "Status: failed",
          href: "/acme/prod/activity/runs/aex_abc123",
        },
      ],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.kind).toBe("run");
    expect(out.rows[0]?.href).toBe("/acme/prod/activity/runs/aex_abc123");
  });

  it("rejects output with more than 8 rows", () => {
    const manyRows = Array.from({ length: 9 }, (_, i) => ({
      kind: "run" as const,
      id: `aex_${i}`,
      label: `Run #${i}`,
      scope: "Workspace: Production",
      contextLine: null,
      href: `/acme/prod/activity/runs/aex_${i}`,
    }));
    expect(commandMenuSearch.output.safeParse({ rows: manyRows }).success).toBe(
      false,
    );
  });

  it("allows contextLine to be null", () => {
    const out = commandMenuSearch.output.parse({
      rows: [
        {
          kind: "agent",
          id: "agt_x",
          label: "My Agent",
          scope: "Workspace: Staging",
          contextLine: null,
          href: "/acme/staging/agents/agt_x",
        },
      ],
    });
    expect(out.rows[0]?.contextLine).toBeNull();
  });
});
