import { checkSkill, readSkillFrontmatter } from "./skill-validation";
import { describe, expect, it } from "vitest";
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

describe("readSkillFrontmatter", () => {
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

describe("YAML required values", () => {
  it.each(["scope:", "scope: null", "scope: false", "scope: []", "scope: {}"])(
    "refuses %s",
    (scope) => {
      expect(
        checkSkill({
          name: "release-notes",
          body: body(["name: release-notes", "version: 1.0.0", scope]),
          files: [],
          replacing: null,
          budget: 6000,
        }),
      ).toContainEqual({
        name: "frontmatter",
        passed: false,
        code: "frontmatter_incomplete",
      });
    },
  );
});
