import { describe, expect, it } from "vitest";
import {
  agentArtifactSchema,
  artifactSchema,
  commandArtifactSchema,
  skillArtifactSchema,
} from "./schemas";

describe("canonical artifact schemas", () => {
  it("preserves unresolved tools for needs-review classification", () => {
    const result = agentArtifactSchema.parse({
      schema_version: 1,
      kind: "agent",
      name: "reviewer",
      description: "Reviews code",
      developer_instructions: "Review carefully.",
      tools: ["read_file"],
      skills: ["code-review"],
      unresolved_tools: ["Task"],
    });

    expect(result.unresolved_tools).toEqual(["Task"]);
  });

  it("requires explicit contained skill references", () => {
    expect(() =>
      skillArtifactSchema.parse({
        schema_version: 1,
        kind: "skill",
        name: "review",
        description: "Review code",
        instructions: "Review.",
        references: ["../outside.md"],
      }),
    ).toThrow();
  });

  it("accepts commands and rejects unknown fields", () => {
    expect(
      commandArtifactSchema.parse({
        schema_version: 1,
        kind: "command",
        name: "audit-code",
        description: "Audit code",
        prompt: "Audit {{args}}",
        argument_hint: "[path]",
      }).kind,
    ).toBe("command");

    expect(() =>
      artifactSchema.parse({
        schema_version: 1,
        kind: "command",
        name: "audit-code",
        description: "Audit code",
        prompt: "Audit.",
        foreign_field: true,
      }),
    ).toThrow();
  });

  it("requires kebab-case names and verb-first snake-case capability slugs", () => {
    expect(() =>
      agentArtifactSchema.parse({
        schema_version: 1,
        kind: "agent",
        name: "Code Reviewer",
        description: "Reviews code",
        developer_instructions: "Review.",
        tools: [],
        skills: [],
      }),
    ).toThrow();

    expect(() =>
      agentArtifactSchema.parse({
        schema_version: 1,
        kind: "agent",
        name: "code-reviewer",
        description: "Reviews code",
        developer_instructions: "Review.",
        tools: ["Read"],
        skills: [],
      }),
    ).toThrow();
  });
});
