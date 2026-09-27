// The report as a person reads it and as JSON.
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { describe, expect, it } from "vitest";
import { findingPlace, formatHuman, formatJson } from "./format";
import { runChecks } from "./run";
import { inputFor } from "./testing/support";
import type { CheckReport, Finding } from "./types";

const error: Finding = {
  check: "schema",
  rule: "enum-value",
  severity: "error",
  path: "agents/a-intel.core.ci-reviewer.toml",
  line: 7,
  field: "harness",
  message: "harness: Invalid enum value.",
  expected: "One of 'codex' | 'claude-code'.",
  fix: "Use one of the values the schema lists.",
};

const warning: Finding = {
  check: "budget",
  rule: "tool-definitions",
  severity: "warning",
  path: "workspace.toml",
  line: null,
  field: null,
  message: "Direct-mode tool definitions cost 21,000 tokens on every request.",
  expected: "At most 20,000 tokens of direct-mode definitions.",
  fix: "Move the largest servers to search mode.",
};

const failing: CheckReport = {
  passed: false,
  results: [
    { check: "schema", status: "failed", summary: "1 error.", findings: [error] },
    { check: "budget", status: "warned", summary: "1 warning.", findings: [warning] },
    { check: "settings", status: "skipped", summary: "Skipped: no settings.", findings: [] },
  ],
  findings: [error, warning],
};

describe("findingPlace", () => {
  it("names the path, the line, and the field", () => {
    expect(findingPlace(error)).toBe("agents/a-intel.core.ci-reviewer.toml:7 (harness)");
  });

  it("leaves out a line and a field the finding does not have", () => {
    expect(findingPlace(warning)).toBe("workspace.toml");
    expect(findingPlace({ ...warning, line: 19 })).toBe("workspace.toml:19");
  });

  it("names only the field when the finding has no path", () => {
    expect(findingPlace({ ...warning, path: "", field: "steering.always_on_tokens" })).toBe(
      "(steering.always_on_tokens)",
    );
    expect(findingPlace({ ...warning, path: "" })).toBe("");
  });
});

describe("formatHuman", () => {
  it("prints each check, each finding under it, and the result", () => {
    expect(formatHuman(failing)).toBe(
      [
        "FAIL  schema    1 error.",
        "  error schema/enum-value at agents/a-intel.core.ci-reviewer.toml:7 (harness)",
        "    harness: Invalid enum value.",
        "    Expected: One of 'codex' | 'claude-code'.",
        "    Fix: Use one of the values the schema lists.",
        "WARN  budget    1 warning.",
        "  warning budget/tool-definitions at workspace.toml",
        "    Direct-mode tool definitions cost 21,000 tokens on every request.",
        "    Expected: At most 20,000 tokens of direct-mode definitions.",
        "    Fix: Move the largest servers to search mode.",
        "SKIP  settings  Skipped: no settings.",
        "",
        "The steering PR does not pass: 1 error and 1 warning. Fix each error, then run the checks again.",
        "",
      ].join("\n"),
    );
  });

  it("says a steering PR with only warnings passes", () => {
    const report: CheckReport = {
      passed: true,
      results: [{ check: "budget", status: "warned", summary: "2 warnings.", findings: [warning, warning] }],
      findings: [warning, warning],
    };
    expect(formatHuman(report).endsWith("\nThe steering PR passes, with 0 errors and 2 warnings.\n")).toBe(true);
  });

  it("prints a finding with no place without an at", () => {
    const internal: Finding = { ...error, check: "compile", rule: "internal", path: "", line: null, field: null };
    const report: CheckReport = {
      passed: false,
      results: [{ check: "compile", status: "failed", summary: "1 error.", findings: [internal] }],
      findings: [internal],
    };
    expect(formatHuman(report)).toContain("\n  error compile/internal\n");
    expect(formatHuman(report)).toContain("The steering PR does not pass: 1 error and 0 warnings.");
  });

  it("prints the fixture repo as passing every check", () => {
    const text = formatHuman(runChecks(inputFor(fixtureRepo())));
    // The widest check name, references, sets the column.
    expect(text).toMatch(/^PASS {2}schema {6}No findings\.$/m);
    expect(text).toMatch(/^PASS {2}references {2}No findings\.$/m);
    expect(text.endsWith("\nThe steering PR passes, with 0 errors and 0 warnings.\n")).toBe(true);
  });
});

describe("formatJson", () => {
  it("prints the report as runChecks returns it", () => {
    const text = formatJson(failing);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(failing);
  });
});
