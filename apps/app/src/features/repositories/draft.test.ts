import { parseTomlSubset, type TomlTable } from "@/test/toml-subset";
import { describe, expect, it } from "vitest";
import {
  draftGovernanceToml,
  draftWorkspaceToml,
  GOVERNANCE_MODES,
  INIT_BRANCH,
  INIT_FILES,
} from "./draft";

/** The parsed document, or a failure naming the line the parser stopped on. */
function parse(text: string): TomlTable {
  const result = parseTomlSubset(text);
  if (!result.ok)
    throw new Error(`${result.code} at line ${String(result.line)}`);
  return result.doc;
}

describe("draftGovernanceToml", () => {
  it.each(GOVERNANCE_MODES)("declares exactly the mode %s, as TOML", (mode) => {
    const tree = parse(draftGovernanceToml(mode));
    expect(tree["mode"]).toBe(mode);
    expect(tree["separation_of_duties"]).toBe(mode === "regulated");
  });
});

describe("draftWorkspaceToml", () => {
  it("names the workspace, the repository, its role and its production branch", () => {
    const tree = parse(
      draftWorkspaceToml({
        org: "acme",
        ws: "core-platform",
        wsName: "Core platform",
        repository: "acme/docs-site",
        role: "linked",
        productionBranch: "trunk",
      }),
    );
    expect(tree).toEqual({
      workspace: {
        organization: "acme",
        slug: "core-platform",
        name: "Core platform",
      },
      repository: {
        name: "acme/docs-site",
        role: "linked",
        production_branch: "trunk",
      },
    });
  });

  it("escapes a name that would otherwise break the string (negative)", () => {
    const tree = parse(
      draftWorkspaceToml({
        org: "acme",
        ws: "core",
        wsName: 'Say "hi" \\ bye',
        repository: "acme/x",
        role: "main",
        productionBranch: "main",
      }),
    );
    expect(tree).toMatchObject({ workspace: { name: 'Say "hi" \\ bye' } });
  });
});

describe("the init pull request", () => {
  it("comes from oxagen/init and carries six files, .gitignore last", () => {
    expect(INIT_BRANCH).toBe("oxagen/init");
    expect(INIT_FILES).toHaveLength(5);
    expect(INIT_FILES.at(-1)).toBe(".gitignore");
  });
});
