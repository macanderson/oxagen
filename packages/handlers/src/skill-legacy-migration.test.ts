import { describe, expect, it } from "vitest";
import {
  classifySkillBody,
  formatBackfillReport,
  hashSkillBody,
  planSkillBackfill,
  type SkillVersionRow,
} from "./skill-legacy-migration";

const CANONICAL = [
  "schema_version = 1",
  'kind = "skill"',
  'name = "debugging"',
  'description = "Reproduce, narrow down, fix the root cause."',
  'instructions = "Reproduce the failure before changing anything."',
  "references = []",
  "",
].join("\n");

const LEGACY = `---
name: Debugging
description: Reproduce, narrow down, fix the root cause.
metadata:
  weight: high
weight: high
category: engineering
references:
  - checklist.md
---

# Debugging

Reproduce the failure before changing anything.
`;

function row(overrides: Partial<SkillVersionRow> = {}): SkillVersionRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    publicId: "slv_1",
    orgId: "00000000-0000-0000-0000-0000000000a1",
    workspaceId: "00000000-0000-0000-0000-0000000000b1",
    skillId: "00000000-0000-0000-0000-0000000000c1",
    slug: "debugging",
    versionNumber: 1,
    body: LEGACY,
    legacyBody: null,
    ...overrides,
  };
}

describe("classifySkillBody", () => {
  it("recognizes an already-canonical body and plans no change", () => {
    const result = classifySkillBody(CANONICAL, { slug: "debugging" });
    expect(result.kind).toBe("canonical");
  });

  it("converts a legacy Markdown body into a canonical skill artifact", () => {
    const result = classifySkillBody(LEGACY, { slug: "debugging" });
    expect(result.kind).toBe("convertible");
    if (result.kind !== "convertible") return;

    expect(result.artifact.description).toBe(
      "Reproduce, narrow down, fix the root cause.",
    );
    expect(result.artifact.instructions).toContain("# Debugging");
    expect(result.artifact.references).toEqual(["checklist.md"]);
    expect(result.artifact.metadata).toEqual({
      weight: "high",
      category: "engineering",
    });
    // Output must be readable by the runtime.
    expect(classifySkillBody(result.content, { slug: "debugging" }).kind).toBe(
      "canonical",
    );
  });

  it("takes identity from the row slug, not the display name in frontmatter", () => {
    const result = classifySkillBody(LEGACY, { slug: "debugging" });
    expect(result.kind).toBe("convertible");
    if (result.kind !== "convertible") return;
    // Frontmatter said "Debugging"; the workspace-unique slug wins.
    expect(result.artifact.name).toBe("debugging");
  });

  it("is deterministic — the same body always yields the same bytes", () => {
    const a = classifySkillBody(LEGACY, { slug: "debugging" });
    const b = classifySkillBody(LEGACY, { slug: "debugging" });
    expect(a.kind === "convertible" && a.content).toBe(
      b.kind === "convertible" && b.content,
    );
  });

  describe("refuses to guess", () => {
    const cases: Array<[string, string, string]> = [
      ["a body with no frontmatter at all", "Just prose.\n", "no_frontmatter"],
      [
        "frontmatter that is not valid YAML",
        "---\nname: [unclosed\n---\n\nBody.\n",
        "unparseable_frontmatter",
      ],
      [
        "a missing description — the field the loader matches on",
        "---\nname: debugging\n---\n\nBody.\n",
        "missing_description",
      ],
      [
        "an empty body — there would be no instructions to teach",
        "---\ndescription: Something.\n---\n\n",
        "empty_instructions",
      ],
      [
        "a reference escaping the bundle",
        "---\ndescription: Something.\nreferences: ['../../etc/passwd']\n---\n\nBody.\n",
        "unsafe_reference",
      ],
      [
        "a reference list that is not strings",
        "---\ndescription: Something.\nreferences: {a: 1}\n---\n\nBody.\n",
        "unsafe_reference",
      ],
    ];

    for (const [label, body, reason] of cases) {
      it(`leaves ${label} untouched`, () => {
        const result = classifySkillBody(body, { slug: "debugging" });
        expect(result.kind).toBe("ambiguous");
        if (result.kind === "ambiguous") expect(result.reason).toBe(reason);
      });
    }

    it("leaves a row whose slug is not a legal artifact name untouched", () => {
      const result = classifySkillBody(LEGACY, { slug: "Not A Slug" });
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous")
        expect(result.reason).toBe("invalid_slug");
    });

    it("does not convert TOML that is a different artifact kind", () => {
      const command = [
        "schema_version = 1",
        'kind = "command"',
        'name = "review"',
        'description = "Review a file."',
        'prompt = "Review $ARGUMENTS"',
        "",
      ].join("\n");
      const result = classifySkillBody(command, { slug: "review" });
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous")
        expect(result.reason).toBe("non_skill_toml");
    });
  });
});

describe("planSkillBackfill", () => {
  it("partitions rows into convertible, canonical, and ambiguous", () => {
    const plan = planSkillBackfill([
      row({ publicId: "slv_legacy" }),
      row({ publicId: "slv_canonical", body: CANONICAL }),
      row({ publicId: "slv_ambiguous", body: "no frontmatter here" }),
    ]);

    expect(plan.convertible.map((i) => i.row.publicId)).toEqual(["slv_legacy"]);
    expect(plan.canonical.map((i) => i.row.publicId)).toEqual([
      "slv_canonical",
    ]);
    expect(plan.ambiguous.map((i) => i.row.publicId)).toEqual([
      "slv_ambiguous",
    ]);
  });

  it("is idempotent — a row already carrying preserved provenance is never re-converted", () => {
    const plan = planSkillBackfill([
      row({ publicId: "slv_done", body: CANONICAL, legacyBody: LEGACY }),
    ]);
    expect(plan.convertible).toHaveLength(0);
    expect(plan.canonical.map((i) => i.row.publicId)).toEqual(["slv_done"]);
  });

  it("never re-converts a row whose legacy body was preserved, even if the body looks legacy", () => {
    // Defensive: an operator restoring a body must not cause the original
    // provenance to be overwritten by a second conversion.
    const plan = planSkillBackfill([
      row({ publicId: "slv_odd", body: LEGACY, legacyBody: LEGACY }),
    ]);
    expect(plan.convertible).toHaveLength(0);
  });

  it("keeps tenant scope on every planned row", () => {
    const plan = planSkillBackfill([
      row({ orgId: "00000000-0000-0000-0000-0000000000a2" }),
    ]);
    expect(plan.convertible[0]?.row.orgId).toBe(
      "00000000-0000-0000-0000-0000000000a2",
    );
    expect(plan.convertible[0]?.row.workspaceId).toBe(
      "00000000-0000-0000-0000-0000000000b1",
    );
  });
});

describe("formatBackfillReport", () => {
  it("counts each bucket and names every ambiguity reason", () => {
    const report = formatBackfillReport(
      planSkillBackfill([
        row({ publicId: "slv_1" }),
        row({ publicId: "slv_2", body: CANONICAL }),
        row({ publicId: "slv_3", body: "prose only" }),
      ]),
    );
    expect(report).toContain("convertible: 1");
    expect(report).toContain("already canonical: 1");
    expect(report).toContain("ambiguous (left untouched): 1");
    expect(report).toContain("no_frontmatter");
    expect(report).toContain("slv_3");
  });
});

describe("hashSkillBody", () => {
  it("produces a stable sha256 hex digest", () => {
    expect(hashSkillBody("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashSkillBody(LEGACY)).toBe(hashSkillBody(LEGACY));
  });
});
