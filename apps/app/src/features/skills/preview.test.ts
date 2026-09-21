// The search preview mapper over real contract output: each sample is parsed
// by the contract's own output schema first, and each mapped value by the view
// model, so neither a sample the contract would refuse nor a view the page
// would refuse can make a test pass.
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import { describe, expect, it } from "vitest";
import { SkillSearchPreview } from "@/data/contracts/skills";
import { toSkillSearchPreview } from "./preview";

describe("toSkillSearchPreview", () => {
  const candidate = {
    id: "code-review",
    version: "1.2.0",
    digest: `sha256:${"a".repeat(64)}`,
    source: "workspace",
    description: "Review a diff",
    tokenCost: 40,
  };
  const mapPreview = (sample: unknown) =>
    SkillSearchPreview.parse(
      toSkillSearchPreview(skillSearchPreview.output.parse(sample)),
    );

  // The candidate's slug is a repository identifier Oxagen never mints, so the
  // view model names it `skillRef`. Before this mapper the page read `id`
  // straight off the contract output and the field the view model declared did
  // not exist at runtime.
  it("carries each candidate's catalogue slug as skillRef, matched and withheld alike", () => {
    const view = mapPreview({
      version: "skl_v1",
      repositoryCommitSha: "abcdef0123456789",
      tokenCost: 130,
      results: [{ ...candidate, score: 0.9 }],
      withheld: [
        { ...candidate, id: "secret-sauce", reason: "unapproved_digest" },
      ],
    });
    expect(view.results.map((row) => row.skillRef)).toEqual(["code-review"]);
    expect(view.withheld.map((row) => row.skillRef)).toEqual(["secret-sauce"]);
    expect(view.results[0]).not.toHaveProperty("id");
    expect(view.withheld[0]).toEqual({
      skillRef: "secret-sauce",
      reason: "unapproved_digest",
    });
  });

  it("copies the version, the commit it resolved against and the token cost", () => {
    const view = mapPreview({
      version: "skl_v2",
      repositoryCommitSha: "0123456789abcdef",
      tokenCost: 0,
      results: [],
      withheld: [],
    });
    expect(view).toMatchObject({
      version: "skl_v2",
      repositoryCommitSha: "0123456789abcdef",
      tokenCost: 0,
      results: [],
      withheld: [],
    });
  });
});
