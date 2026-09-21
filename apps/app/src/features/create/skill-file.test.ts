import { describe, expect, it } from "vitest";
import {
  draftSkill,
  estimateTokens,
  frontmatterOf,
  validSkillPreview,
  isSemver,
  skillNameOf,
  slugFromDescription,
  slugFromFileName,
} from "./skill-file";

const COPY = {
  purpose: "What this procedure is for.",
  precondition: "Say what has to be true first.",
  never: "Name the one thing never to do.",
  grantsNothing: "This file grants nothing.",
};

describe("slugFromDescription", () => {
  it("takes the first four words that are not stop words", () => {
    expect(
      slugFromDescription("How we cut release notes for the platform repo"),
    ).toBe("cut-release-notes-platform");
  });

  it("falls back to new-skill for a description with no usable word (negative)", () => {
    expect(slugFromDescription("  the a an ")).toBe("new-skill");
  });

  it("keeps a name inside 48 characters with no trailing hyphen", () => {
    const slug = slugFromDescription(`${"x".repeat(40)} ${"y".repeat(20)}`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("slugFromFileName", () => {
  it("drops the extension and the version a bundle carries", () => {
    expect(slugFromFileName("release-notes-from-prs-2.2.0.skill")).toBe(
      "release-notes-from-prs",
    );
    expect(slugFromFileName("Safe_Migration.zip")).toBe("safe-migration");
    expect(slugFromFileName("SKILL.md")).toBe("skill");
  });

  it("falls back to new-skill for a name with no letters (negative)", () => {
    expect(slugFromFileName("!!!.zip")).toBe("new-skill");
  });
});

describe("frontmatterOf", () => {
  it("reads the key: value lines between the fences, CRLF too", () => {
    expect(
      frontmatterOf("---\r\nname: triage\r\nversion: 1.0.0\r\n---\r\n# T"),
    ).toEqual({ name: "triage", version: "1.0.0" });
  });

  it("is null for a file that does not open with a fence or never closes one (negative)", () => {
    expect(frontmatterOf("# no frontmatter")).toBeNull();
    expect(frontmatterOf("---\nname: open\n")).toBeNull();
  });
});

describe("isSemver", () => {
  it("accepts major.minor.patch and nothing looser", () => {
    expect(isSemver("2.10.0")).toBe(true);
    expect(isSemver("2.1")).toBe(false);
    expect(isSemver("01.0.0")).toBe(false);
    expect(isSemver("1.0.0-beta")).toBe(false);
  });
});

describe("skillNameOf", () => {
  it("follows the frontmatter's name so the name check holds while it is edited", () => {
    expect(skillNameOf("---\nname: rollback\n---\n", "fallback")).toBe(
      "rollback",
    );
  });

  it("falls back when the name is missing or not a directory name (negative)", () => {
    expect(skillNameOf("# none", "fallback")).toBe("fallback");
    expect(skillNameOf("---\nname: Roll Back\n---\n", "fallback")).toBe(
      "fallback",
    );
    expect(skillNameOf(`---\nname: ${"a".repeat(49)}\n---\n`, "f")).toBe("f");
  });
});

describe("estimateTokens", () => {
  it("counts four characters a token, rounded up, as the handler does", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("draftSkill", () => {
  it("drafts the frontmatter the checks need, a title and the three steps", () => {
    const body = draftSkill({
      desc: "Group merged PRs by surface. Never publish.",
      name: "release-notes",
      ws: "core-platform",
      copy: COPY,
    });
    expect(frontmatterOf(body)).toEqual({
      name: "release-notes",
      version: "0.1.0",
      scope: "workspace:core-platform",
    });
    expect(body).toContain("# Release notes");
    expect(body).toContain("\nGroup merged PRs by surface.\n");
    expect(body).toContain("2. Group merged PRs by surface. Never publish.");
    expect(body).toContain("> This file grants nothing.");
  });

  it("uses the purpose line when the description is empty (negative)", () => {
    const body = draftSkill({
      desc: "   ",
      name: "new-skill",
      ws: "w",
      copy: COPY,
    });
    expect(body).toContain("\nWhat this procedure is for.\n");
    expect(body).toContain("2. What this procedure is for.");
  });
});

describe("YAML preview parity", () => {
  const wrap = (fields: string) => `---\n${fields}\n---\n# Body`;
  it("decodes quoted names and versions before deriving the submitted name", () => {
    const text = wrap(
      'name: "release-notes"\nversion: "1.2.3"\nscope: workspace:core',
    );
    expect(frontmatterOf(text)?.version).toBe("1.2.3");
    expect(skillNameOf(text, "wrong-filename")).toBe("release-notes");
    expect(validSkillPreview(text)).toBe(true);
  });
  it.each([
    "name: release-notes\nname: duplicate\nversion: 1.0.0\nscope: workspace:core",
    "name: &name release-notes\nversion: *name\nscope: workspace:core",
    "name: release-notes\nversion: 1.0.0\nscope: workspace:core\n<<: {tools: all}",
    "name: null\nversion: 1.0.0\nscope: workspace:core",
    "name: release-notes\nversion: null\nscope: workspace:core",
    "name: release-notes\nversion: 1.0.0\nscope: null",
    'name: release-notes\nversion: 1.0.0\nscope: workspace:core\n"allowed-tools": [shell]',
    'name: release-notes\nversion: 1.0.0\nscope: workspace:core\n"permi\\u0073sions": {all: true}',
  ])("refuses unsupported frontmatter %s", (fields) => {
    expect(validSkillPreview(wrap(fields))).toBe(false);
  });
});
