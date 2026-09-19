import { describe, expect, it } from "vitest";
import {
  bumpPatch,
  checkSkill,
  estimateSkillTokens,
  readSearchBudget,
  readSkillFrontmatter,
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

const run = (over: Partial<Parameters<typeof checkSkill>[0]> = {}) =>
  checkSkill({
    name: "release-notes",
    body: GOOD,
    files: [],
    replacing: null,
    budget: 6000,
    ...over,
  });
const failed = (checks: ReturnType<typeof checkSkill>) =>
  checks.filter((c) => !c.passed).map((c) => c.code);

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

  it("reads the frontmatter between the fences, and nothing when a fence is missing", () => {
    expect(readSkillFrontmatter(GOOD)?.fields).toEqual({
      name: "release-notes",
      version: "1.0.0",
      scope: "workspace:core-platform",
    });
    expect(readSkillFrontmatter("# no fence")).toBeNull();
    expect(readSkillFrontmatter("---\nname: x\n")).toBeNull();
    expect(readSkillFrontmatter(GOOD.replace(/\n/g, "\r\n"))).not.toBeNull();
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

describe("checkSkill", () => {
  it("passes all six on a well-formed new skill", () => {
    const checks = run();
    expect(checks.map((c) => c.name)).toEqual([
      "frontmatter",
      "version",
      "digest",
      "grants",
      "secrets",
      "load_cost",
    ]);
    expect(failed(checks)).toEqual([]);
  });

  it("fails the frontmatter on a missing fence, a missing key and a name that is not the directory (negative)", () => {
    expect(failed(run({ body: "# none" }))).toContain("frontmatter_missing");
    expect(
      failed(run({ body: body(["name: release-notes", "version: 1.0.0"]) })),
    ).toContain("frontmatter_incomplete");
    expect(failed(run({ name: "changelog" }))).toContain("name_mismatch");
  });

  it("fails a version that is not semver or not greater than the one it replaces (negative)", () => {
    expect(failed(run({ replacing: "1.0.0" }))).toEqual([
      "version_not_greater",
    ]);
    expect(failed(run({ replacing: "0.9.3" }))).toEqual([]);
    expect(
      failed(
        run({
          body: body([
            "name: release-notes",
            "version: latest",
            "scope: workspace:x",
          ]),
        }),
      ),
    ).toEqual(["version_not_semver"]);
  });

  it("fails a file that grants a tool, a secret in a bundle file, and a body over budget (negative)", () => {
    expect(
      failed(
        run({
          body: body([
            "name: release-notes",
            "version: 1.0.0",
            "scope: workspace:x",
            "allowed-tools: Bash",
          ]),
        }),
      ),
    ).toEqual(["grants_allowed-tools"]);
    expect(
      failed(
        run({
          files: [{ path: "a.md", content: "ghp_" + "a".repeat(36) }],
        }),
      ),
    ).toEqual(["secret_github_token"]);
    expect(failed(run({ budget: 5 }))).toEqual(["over_budget"]);
  });
});
