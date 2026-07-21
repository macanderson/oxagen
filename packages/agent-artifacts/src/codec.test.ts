import { describe, expect, it } from "vitest";
import { parseArtifactToml, serializeArtifactToml } from "./codec";

describe("artifact TOML codec", () => {
  it("round-trips canonical TOML deterministically", () => {
    const value = {
      schema_version: 1 as const,
      kind: "command" as const,
      name: "audit-code",
      description: "Audit code",
      argument_hint: "[path]",
      prompt: "Audit $ARGUMENTS\n",
    };

    const first = serializeArtifactToml(value);
    expect(first).toMatch(/^schema_version = 1\nkind = "command"/);
    expect(first.endsWith("\n")).toBe(true);
    expect(serializeArtifactToml(parseArtifactToml(first))).toBe(first);
  });

  it("rejects Markdown frontmatter and unsupported schema versions", () => {
    expect(() =>
      parseArtifactToml("---\nkind: command\n---\nPrompt"),
    ).toThrowError(/invalid_artifact_toml/);
    expect(() =>
      parseArtifactToml(
        'schema_version = 2\nkind = "command"\nname = "x"\ndescription = "x"\nprompt = "x"',
      ),
    ).toThrowError(/unsupported_schema_version/);
  });
});
