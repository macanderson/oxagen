import { describe, expect, it } from "vitest";
import {
  bumpPatch,
  estimateSkillTokens,
  readSearchBudget,
  scanForSecrets,
  skillBranch,
  skillPath,
  skillPropose,
} from "./skill.propose";

const body = (fm: string[]) =>
  ["---", ...fm, "---", "", "# Release notes", ""].join("\n");
const GOOD = body([
  "name: release-notes",
  "version: 1.0.0",
  "scope: workspace:core-platform",
]);

describe("propose_skill contract", () => {
  it("declares an org Owner or Admin write on the API alone, outside the metering surface", () => {
    expect(skillPropose.name).toBe("propose_skill");
    expect(skillPropose.surfaces).toEqual(["api"]);
    expect(skillPropose.noBillingGate).toBe(true);
    expect(skillPropose.mutates).toBe(true);
    expect(skillPropose.layers).toContain("app");
  });

  it("refuses a name that is not kebab-case and a bundle path that climbs out (negative)", () => {
    const base = { origin: "describe", body: GOOD };
    expect(
      skillPropose.input.safeParse({ ...base, name: "Release_Notes" }).success,
    ).toBe(false);
    for (const path of ["../x", ".git/config", "a//b", "SKILL.md"]) {
      expect(
        skillPropose.input.safeParse({
          ...base,
          name: "release-notes",
          files: [{ path, content: "" }],
        }).success,
      ).toBe(false);
    }
    expect(
      skillPropose.input.safeParse({
        ...base,
        name: "release-notes",
        files: [{ path: "examples/before.md", content: "" }],
      }).success,
    ).toBe(true);
  });
});

describe("the file helpers", () => {
  it("places a skill and its branch by name", () => {
    expect(skillPath("release-notes")).toBe(
      ".oxagen/skills/release-notes/SKILL.md",
    );
    expect(skillBranch("release-notes")).toBe("skills/release-notes");
  });

  it("bumps the patch version and refuses anything that is not semver", () => {
    expect(bumpPatch("2.1.9")).toBe("2.1.10");
    expect(bumpPatch("latest")).toBeNull();
  });

  it("estimates tokens at four characters each", () => {
    expect(estimateSkillTokens("")).toBe(0);
    expect(estimateSkillTokens("abcde")).toBe(2);
  });

  it("reads the budget from the [search] table only", () => {
    expect(readSearchBudget(null)).toBeNull();
    expect(
      readSearchBudget("budget = 10\n[search]\ncutoff = 0.4\n"),
    ).toBeNull();
    expect(
      readSearchBudget("[search]\nbudget = 6000 # tokens\n[reflection]\n"),
    ).toBe(6000);
  });

  it("finds credential-shaped strings and passes prose", () => {
    expect(scanForSecrets("key AKIAABCDEFGHIJKLMNOP here")).toBe(
      "aws_access_key",
    );
    expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----")).toBe(
      "private_key",
    );
    expect(scanForSecrets("Group merged pull requests by surface.")).toBeNull();
  });
});
