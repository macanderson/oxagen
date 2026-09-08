import { describe, expect, it } from "vitest";
import {
  agentsMdBlobSha,
  buildReport,
  CheckUnavailableError,
  corpusFilesFromTree,
  divergeAgentsSummary,
  diverge,
  extractStandingDecisionsBlock,
  parseStandingDecisionsBullets,
  REPOS,
} from "./scr-corpus-check.mjs";

/**
 * These tests exist because of the defect oxagen #1132 documented in
 * stella-sidecar-nightly.yml: a drift check that is structurally incapable of
 * going red reports green forever and is worse than no check, because it
 * manufactures false confidence. Every divergence kind below is therefore
 * asserted to actually produce a divergence.
 */

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const IN_SYNC = {
  "docs/scr/README.md": "aaaaaaaa1111",
  "docs/scr/SCR-001-no-full-suite-builds.md": "bbbbbbbb2222",
};

describe("corpusFilesFromTree", () => {
  it("keeps only blobs under docs/scr/, mapped to their blob SHA", () => {
    const result = corpusFilesFromTree({
      truncated: false,
      tree: [
        { type: "blob", path: "docs/scr/README.md", sha: "aaa" },
        { type: "blob", path: "docs/adr/ADR-038.md", sha: "bbb" },
        { type: "tree", path: "docs/scr", sha: "ccc" },
        { type: "blob", path: "README.md", sha: "ddd" },
      ],
    });
    expect([...result.keys()]).toEqual(["docs/scr/README.md"]);
    expect(result.get("docs/scr/README.md")).toBe("aaa");
  });

  it("treats a truncated tree as check-broken, not as missing files", () => {
    // Silently accepting a truncated tree would report every dropped record as
    // `missing:` drift — a false alarm indistinguishable from a real one.
    expect(() => corpusFilesFromTree({ truncated: true, tree: [] })).toThrow(
      CheckUnavailableError,
    );
  });
});

describe("agentsMdBlobSha", () => {
  it("finds the repo-root AGENTS.md blob and ignores everything else", () => {
    const sha = agentsMdBlobSha({
      truncated: false,
      tree: [
        { type: "blob", path: "docs/AGENTS.md", sha: "wrong-depth" },
        { type: "blob", path: "AGENTS.md", sha: "root" },
      ],
    });
    expect(sha).toBe("root");
  });

  it("returns null when the repo has no AGENTS.md", () => {
    expect(agentsMdBlobSha({ truncated: false, tree: [] })).toBeNull();
  });

  it("treats a truncated tree as check-broken", () => {
    expect(() => agentsMdBlobSha({ truncated: true, tree: [] })).toThrow(
      CheckUnavailableError,
    );
  });
});

describe("diverge", () => {
  it("reports nothing when the trees are byte-identical", () => {
    expect(diverge(files(IN_SYNC), files(IN_SYNC))).toEqual([]);
  });

  it("detects a record whose content changed on one side", () => {
    const drifted = diverge(
      files(IN_SYNC),
      files({ ...IN_SYNC, "docs/scr/README.md": "ffffffff9999" }),
    );
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toContain("differs: docs/scr/README.md");
    // Both SHAs appear so a reader can tell which copy they are looking at.
    expect(drifted[0]).toContain("aaaaaaaa");
    expect(drifted[0]).toContain("ffffffff");
  });

  it("detects a record missing from the candidate", () => {
    const drifted = diverge(
      files(IN_SYNC),
      files({ "docs/scr/README.md": "aaaaaaaa1111" }),
    );
    expect(drifted).toEqual([
      "missing: docs/scr/SCR-001-no-full-suite-builds.md",
    ]);
  });

  it("detects a record the candidate has and the reference does not", () => {
    // Drift is symmetric: a repo inventing a local SCR is as much a bug as one
    // dropping a shared record, so extras must not be silently tolerated.
    const drifted = diverge(
      files(IN_SYNC),
      files({ ...IN_SYNC, "docs/scr/SCR-099-local-invention.md": "eeee3333" }),
    );
    expect(drifted).toEqual(["extra:   docs/scr/SCR-099-local-invention.md"]);
  });

  it("reports every divergence at once rather than stopping at the first", () => {
    const drifted = diverge(
      files(IN_SYNC),
      files({
        "docs/scr/README.md": "ffffffff9999",
        "docs/scr/SCR-099-local-invention.md": "eeee3333",
      }),
    );
    expect(drifted).toHaveLength(3); // differs + missing + extra
  });
});

// A minimal but real two-bullet "## Standing decisions" block, shaped exactly
// like the compiled summary every repo carries: a title that soft-wraps
// across the markdown source, and a body sentence that is allowed to diverge
// (here, a toolchain command) without that being drift.
const standingDecisions = (
  scr004Bullet: string,
) => `## Standing decisions — apply without asking

Each directive below is a Steering Context Record in [\`docs/scr/\`](docs/scr/).

- **[SCR-001](docs/scr/SCR-001-no-full-suite-builds.md) — Tests/builds
  (inner loop):** Never compile or run the full test suite while developing.
  Here: \`TOOLCHAIN_COMMAND_PLACEHOLDER\`.
${scr004Bullet}
## Next section

This must not be swallowed into the bullets above.
`;

// The real "before" bullet from context-graph-protocol AGENTS.md prior to
// PR #167 (oxagen#2673's drift) — https://github.com/macanderson/context-graph-protocol/pull/167.
const OLD_SCR_004_BULLET = `- **[SCR-004](docs/scr/SCR-004-residue-becomes-issues.md) — Residue:**
  Before declaring any task complete, file a GitHub issue for every
  follow-up, tech-debt item, or logical next step you noticed. Apply ONLY
  the \`triage\` label.`;

// The real "after" bullet, from the same PR and matching oxagen@main today.
const NEW_SCR_004_BULLET = `- **[SCR-004](docs/scr/SCR-004-residue-becomes-issues.md) — Fix over
  file:** Fix what you notice in the PR you are making; two unrelated fixes
  in one PR is fine. File an issue only when a fix cannot responsibly ride
  the PR (a maintainer decision, a rig or spend, or work larger than the
  session), and only when fixing it moves stability, reliability,
  maintainability, innovation, efficiency, or performance. Apply ONLY the
  \`triage\` label.`;

describe("extractStandingDecisionsBlock", () => {
  it("slices from the heading up to (not including) the next top-level heading", () => {
    const block = extractStandingDecisionsBlock(
      standingDecisions(NEW_SCR_004_BULLET),
    );
    expect(block).toContain("SCR-001");
    expect(block).toContain("SCR-004");
    expect(block).not.toContain("Next section");
  });

  it("returns null when there is no such heading", () => {
    expect(extractStandingDecisionsBlock("# Some other doc\n")).toBeNull();
  });
});

describe("parseStandingDecisionsBullets", () => {
  it("extracts one entry per bullet, with title unwrapped from the soft-wrap", () => {
    const block = extractStandingDecisionsBlock(
      standingDecisions(NEW_SCR_004_BULLET),
    )!;
    const { bullets, unparsed } = parseStandingDecisionsBullets(block);
    expect(unparsed).toEqual([]);
    expect(bullets.get("SCR-001")).toEqual({
      path: "docs/scr/SCR-001-no-full-suite-builds.md",
      title: "Tests/builds (inner loop)",
    });
    expect(bullets.get("SCR-004")).toEqual({
      path: "docs/scr/SCR-004-residue-becomes-issues.md",
      title: "Fix over file",
    });
  });

  it("records a bullet that does not match the expected shape as unparsed", () => {
    const { bullets, unparsed } = parseStandingDecisionsBullets(
      "- this is not a standing-decision bullet at all\n",
    );
    expect(bullets.size).toBe(0);
    expect(unparsed).toHaveLength(1);
  });
});

describe("divergeAgentsSummary", () => {
  const reference = parseStandingDecisionsBullets(
    extractStandingDecisionsBlock(standingDecisions(NEW_SCR_004_BULLET))!,
  );

  it("is silent when a title matches even though the body's command differs", () => {
    // This is the DoD's second requirement: SCR-001's command line legitimately
    // differs per repo's toolchain, and that alone must never be reported.
    const candidateBlock = standingDecisions(NEW_SCR_004_BULLET).replace(
      "TOOLCHAIN_COMMAND_PLACEHOLDER",
      "pnpm --filter <package> test",
    );
    const candidate = parseStandingDecisionsBullets(
      extractStandingDecisionsBlock(candidateBlock)!,
    );
    expect(divergeAgentsSummary(reference, candidate)).toEqual([]);
  });

  it("reproduces oxagen#2673: a stale title is drift even though the corpus doc itself is in sync", () => {
    const candidate = parseStandingDecisionsBullets(
      extractStandingDecisionsBlock(standingDecisions(OLD_SCR_004_BULLET))!,
    );
    const problems = divergeAgentsSummary(reference, candidate);
    expect(problems).toEqual([
      'AGENTS.md summary: SCR-004 title differs ("Fix over file" vs "Residue")',
    ]);
  });

  it("reports a repo with no AGENTS.md as a single problem, not one per SCR", () => {
    expect(divergeAgentsSummary(reference, null)).toEqual([
      "AGENTS.md: file not found at repo root",
    ]);
  });

  it("detects a bullet missing from the candidate's summary", () => {
    const candidate = parseStandingDecisionsBullets(
      extractStandingDecisionsBlock(standingDecisions(""))!,
    );
    expect(divergeAgentsSummary(reference, candidate)).toEqual([
      "AGENTS.md summary: missing bullet for SCR-004",
    ]);
  });

  it("detects an extra bullet the reference does not have", () => {
    // Built directly rather than through standingDecisions()/
    // extractStandingDecisionsBlock: that fixture's trailing "## Next
    // section" exists to prove the *extractor* stops at a heading, which is
    // a different concern from what this test is isolating.
    const referenceOnly = parseStandingDecisionsBullets(
      `## Standing decisions — apply without asking\n\n${NEW_SCR_004_BULLET}\n`,
    );
    const withExtra = parseStandingDecisionsBullets(
      `## Standing decisions — apply without asking\n\n${NEW_SCR_004_BULLET}\n\n` +
        "- **[SCR-099](docs/scr/SCR-099-local.md) — Local invention:** n/a\n",
    );
    expect(divergeAgentsSummary(referenceOnly, withExtra)).toEqual([
      "AGENTS.md summary: extra bullet for SCR-099",
    ]);
  });
});

describe("buildReport", () => {
  const tree = (
    repo: string,
    entries: Record<string, string>,
    scr004Bullet: string = NEW_SCR_004_BULLET,
    command = "cargo test -p <crate>",
  ) => ({
    repo,
    defaultBranch: "main",
    files: files(entries),
    agentsSummary: parseStandingDecisionsBullets(
      extractStandingDecisionsBlock(
        standingDecisions(scr004Bullet).replace(
          "TOOLCHAIN_COMMAND_PLACEHOLDER",
          command,
        ),
      )!,
    ),
  });

  const allInSync = () => REPOS.map((repo) => tree(repo, IN_SYNC));

  it("is green when all five repos match the reference", () => {
    const { drifted, summary } = buildReport(allInSync());
    expect(drifted).toBe(false);
    expect(summary).toContain("`stella` — in sync (2 files)");
    // The reference repo describes itself in the header, not as a comparison row.
    expect(summary).not.toContain("`oxagen` — in sync");
  });

  it("stays green when only the toolchain command in SCR-001 differs per repo", () => {
    // The exact legitimate-divergence case oxagen#2684 calls out: this must
    // not be reported, or the check would be strictly worse than useless.
    const trees = REPOS.map((repo) =>
      tree(repo, IN_SYNC, NEW_SCR_004_BULLET, `${repo}-specific-test-command`),
    );
    const { drifted } = buildReport(trees);
    expect(drifted).toBe(false);
  });

  it("goes red and names the offending repo when one copy drifts", () => {
    const trees = allInSync();
    trees[trees.length - 1] = tree("stella", {
      ...IN_SYNC,
      "docs/scr/README.md": "ffffffff9999",
    });
    const { drifted, summary } = buildReport(trees);
    expect(drifted).toBe(true);
    expect(summary).toContain("`stella` — **1 divergence(s)**");
    expect(summary).toContain("differs: docs/scr/README.md");
    expect(summary).toContain("`arenabench` — in sync");
  });

  it("reproduces oxagen#2673 end to end: a stale AGENTS.md summary fails while the corpus files themselves are in sync", () => {
    const trees = allInSync();
    const cgpIndex = trees.findIndex(
      (t) => t.repo === "context-graph-protocol",
    );
    trees[cgpIndex] = tree(
      "context-graph-protocol",
      IN_SYNC, // docs/scr/ itself is in sync — the corpus half is clean
      OLD_SCR_004_BULLET, // but AGENTS.md still summarizes the old directive
    );
    const { drifted, summary } = buildReport(trees);
    expect(drifted).toBe(true);
    expect(summary).toContain("`context-graph-protocol` — **1 divergence(s)**");
    expect(summary).toContain(
      'AGENTS.md summary: SCR-004 title differs ("Fix over file" vs "Residue")',
    );
  });

  it("refuses to run against an empty reference instead of blaming everyone", () => {
    // An empty oxagen tree — a bad checkout, a moved directory — would make
    // every other repo look like it invented the whole corpus. Failing as
    // check-broken keeps that from being filed as four drift issues.
    const trees = allInSync();
    trees[0] = { ...tree("oxagen", {}), files: files({}) };
    expect(() => buildReport(trees)).toThrow(CheckUnavailableError);
  });

  it("refuses to run when oxagen's own AGENTS.md summary is empty", () => {
    const trees = allInSync();
    const emptyOxagenSummary = tree("oxagen", IN_SYNC);
    emptyOxagenSummary.agentsSummary = { bullets: new Map(), unparsed: [] };
    trees[0] = emptyOxagenSummary;
    expect(() => buildReport(trees)).toThrow(CheckUnavailableError);
  });
});
