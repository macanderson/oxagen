import { describe, expect, it } from "vitest";
import type { StatementFinding } from "./findings";
import { buildReport, STATUS_DESCRIPTION_MAX } from "./report";

const CONTRADICTION: StatementFinding = {
  kind: "contradiction",
  statement: { path: "AGENTS.md", line: 7, text: "Always push to `main`." },
  record: {
    lineage: "a-intel.platform.no-push-to-main",
    label: "Never push to main",
    path: "steering/platform/a-intel.platform.no-push-to-main.md",
  },
};
const REPEAT: StatementFinding = {
  kind: "repeat",
  statement: { path: "CLAUDE.md", line: 12, text: "Run every tenant query inside withTenantDb." },
  record: { lineage: "a-intel.platform.tenant-queries", label: null, path: null },
};

const BASE = {
  workspace: "platform",
  files: ["AGENTS.md", "CLAUDE.md"],
  findings: [] as StatementFinding[],
  blockMerge: false,
  memories: 0,
};

describe("buildReport", () => {
  it("passes when no instruction file changed", () => {
    const report = buildReport({ ...BASE, files: [] });
    expect(report.conclusion).toBe("success");
    expect(report.title).toBe("No instruction files changed");
    expect(report.summary).toContain("workspace `platform`");
  });

  it("passes when the files add nothing a record holds", () => {
    const report = buildReport(BASE);
    expect(report).toMatchObject({
      conclusion: "success",
      title: "No findings in instruction files",
      description: "No findings in instruction files.",
    });
    expect(report.summary).not.toContain("### Merge");
  });

  it("warns with a neutral conclusion when block_merge is off", () => {
    const report = buildReport({ ...BASE, findings: [CONTRADICTION, REPEAT] });
    expect(report.conclusion).toBe("neutral");
    expect(report.title).toBe("2 findings in instruction files");
    expect(report.description).toBe("2 findings in instruction files. This check only warns.");
    expect(report.summary).toContain(
      '- Contradiction: `AGENTS.md` line 7 says the opposite of steering record `a-intel.platform.no-push-to-main` (Never push to main). The line says "Always push to `main`."',
    );
    expect(report.summary).toContain(
      "- Repeat: `CLAUDE.md` line 12 says what steering record `a-intel.platform.tenant-queries` already says.",
    );
    expect(report.summary).toContain("This check only warns.");
  });

  it("fails when the published workspace.toml sets block_merge", () => {
    const report = buildReport({ ...BASE, findings: [REPEAT], blockMerge: true });
    expect(report.conclusion).toBe("failure");
    expect(report.title).toBe("1 finding in instruction files");
    expect(report.description).toBe("1 finding in instruction files.");
    expect(report.summary).toContain("so a finding fails this check");
  });

  it("names the lines handed to memory capture", () => {
    const report = buildReport({ ...BASE, memories: 2 });
    expect(report.summary).toContain("### Memories");
    expect(report.summary).toContain("2 new lines");
  });

  it("lists at most 100 findings and keeps the GitLab description short", () => {
    const many = Array.from({ length: 130 }, () => REPEAT);
    const report = buildReport({ ...BASE, findings: many });
    expect(report.summary.match(/^- Repeat:/gm)).toHaveLength(100);
    expect(report.summary).toContain("- 30 more findings not listed.");
    expect(report.description.length).toBeLessThanOrEqual(STATUS_DESCRIPTION_MAX);
  });
});
