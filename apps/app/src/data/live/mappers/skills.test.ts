// The skills mapper over real contract outputs: each sample is parsed by the
// contract's own output schema first, and each mapped value by the view model,
// so neither a sample the contract would refuse nor a view the page would
// refuse can make a test pass.
import { skillList } from "@oxagen/oxagen/contracts/skill.list";
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import { describe, expect, it } from "vitest";
import {
  SkillInventory,
  SkillSearchPreview,
} from "@/data/contracts/skills";
import { toSkillInventory, toSkillSearchPreview } from "./skills";

const window = {
  from: "2026-08-16T12:00:00.000Z",
  to: "2026-09-15T12:00:00.000Z",
};

const map = (sample: unknown) =>
  SkillInventory.parse(toSkillInventory(skillList.output.parse(sample)));

describe("toSkillInventory", () => {
  it("copies the window's counts and each name with every harness that reported it", () => {
    const view = map({
      window,
      sessions: 5,
      reportedSessions: 4,
      notReportedSessions: 1,
      skills: [
        {
          name: "release-notes",
          sessions: 2,
          harnesses: ["claude-code", "codex"],
          harnessCount: 2,
          firstSeenAt: "2026-09-10T09:00:00.000Z",
          lastSeenAt: "2026-09-12T09:00:00.000Z",
        },
      ],
      nextCursor: "c2",
    });
    expect(view).toEqual({
      window,
      sessions: 5,
      reportedSessions: 4,
      notReportedSessions: 1,
      skills: [
        {
          name: "release-notes",
          sessions: 2,
          harnesses: ["claude-code", "codex"],
          harnessCount: 2,
          lastSeenAt: "2026-09-12T09:00:00.000Z",
        },
      ],
      nextCursor: "c2",
    });
  });

  it("keeps a session with an empty harness label, and a skill's true harness count past its displayed list, whole (#3103)", () => {
    const view = map({
      window,
      sessions: 1,
      reportedSessions: 1,
      notReportedSessions: 0,
      skills: [
        {
          name: "quiet-harness",
          sessions: 1,
          harnesses: ["", "claude-code"],
          harnessCount: 5,
          firstSeenAt: "2026-09-10T09:00:00.000Z",
          lastSeenAt: "2026-09-10T09:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(view.skills).toEqual([
      {
        name: "quiet-harness",
        sessions: 1,
        harnesses: ["", "claude-code"],
        harnessCount: 5,
        lastSeenAt: "2026-09-10T09:00:00.000Z",
      },
    ]);
  });

  it("keeps a null reported count null when no session reported an inventory, never a zero", () => {
    const view = map({
      window,
      sessions: 2,
      reportedSessions: null,
      notReportedSessions: 2,
      skills: [],
      nextCursor: null,
    });
    expect(view.reportedSessions).toBeNull();
    expect(view.notReportedSessions).toBe(2);
    expect(view.skills).toEqual([]);
  });

  it("keeps an empty window's recorded zeros as the handler counted them", () => {
    const view = map({
      window,
      sessions: 0,
      reportedSessions: null,
      notReportedSessions: 0,
      skills: [],
      nextCursor: null,
    });
    expect(view).toMatchObject({
      sessions: 0,
      reportedSessions: null,
      notReportedSessions: 0,
    });
  });
});

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
    expect(view.withheld[0]).not.toHaveProperty("id");
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
