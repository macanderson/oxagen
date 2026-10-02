// code-repo-check/report.ts: what the Oxagen check says on a pull request in
// a linked code repository (steering-repo-spec, Code repository checks).
//
// The check warns by default. On GitHub a finding makes the check neutral,
// which a required check still passes. It fails only when the workspace's
// published workspace.toml sets `block_merge = true` under `[code_checks]`.
// GitLab has no neutral commit status, so a warning posts success there, and
// the description says how many findings there are.
import type { StatementFinding } from "./findings";

export type CheckConclusion = "success" | "neutral" | "failure";

/** The check as a host shows it. */
export interface CheckReport {
  conclusion: CheckConclusion;
  /** The check run's title on GitHub. */
  title: string;
  /** Markdown under the title on GitHub. */
  summary: string;
  /** The commit status description on GitLab, at most 255 characters. */
  description: string;
}

export interface ReportInput {
  /** The workspace's slug. */
  workspace: string;
  /** Every instruction file the pull request changes. */
  files: readonly string[];
  findings: readonly StatementFinding[];
  /** True when the published workspace.toml sets `[code_checks] block_merge = true`. */
  blockMerge: boolean;
  /** Lines handed to memory capture. */
  memories: number;
}

/** GitHub cuts a check run's summary at 65,535 characters. */
export const CHECK_SUMMARY_MAX = 60_000;
/** GitLab refuses a commit status description past 255 characters. */
export const STATUS_DESCRIPTION_MAX = 255;
/** The findings the summary lists before it counts the rest. */
export const FINDINGS_LISTED_MAX = 100;
/** The longest quote of a line in the summary. */
const QUOTE_MAX = 200;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function recordName(finding: StatementFinding): string {
  const { lineage, label } = finding.record;
  return label ? `\`${lineage}\` (${label})` : `\`${lineage}\``;
}

function findingLine(finding: StatementFinding): string {
  const where = `\`${finding.statement.path}\` line ${finding.statement.line}`;
  const said = `"${quote(finding.statement.text)}"`;
  return finding.kind === "contradiction"
    ? `- Contradiction: ${where} says the opposite of steering record ${recordName(finding)}. The line says ${said}`
    : `- Repeat: ${where} says what steering record ${recordName(finding)} already says. The line says ${said}`;
}

function titleOf(input: ReportInput): string {
  if (input.files.length === 0) return "No instruction files changed";
  if (input.findings.length === 0) return "No findings in instruction files";
  return `${plural(input.findings.length, "finding", "findings")} in instruction files`;
}

function conclusionOf(input: ReportInput): CheckConclusion {
  if (input.findings.length === 0) return "success";
  return input.blockMerge ? "failure" : "neutral";
}

function summaryOf(input: ReportInput): string {
  if (input.files.length === 0)
    return [
      "This pull request changes no harness instruction file, such as AGENTS.md, CLAUDE.md, or a file in .cursor/rules/.",
      "",
      `Oxagen posts this check for workspace \`${input.workspace}\`.`,
    ].join("\n");

  const parts: string[] = [
    `Oxagen compared the lines this pull request adds to its instruction files with the active steering records of workspace \`${input.workspace}\`.`,
    "",
    "### Instruction files",
    ...input.files.map((path) => `- \`${path}\``),
  ];

  if (input.findings.length > 0) {
    const listed = input.findings.slice(0, FINDINGS_LISTED_MAX);
    parts.push("", "### Findings", ...listed.map(findingLine));
    const rest = input.findings.length - listed.length;
    if (rest > 0) parts.push(`- ${plural(rest, "more finding", "more findings")} not listed.`);
    parts.push(
      "",
      "A steering record already reaches every agent in the workspace, so a repeated line only adds tokens. Remove it from the file.",
      "For a contradiction, change the line, or change the steering record through a steering PR.",
    );
  }

  if (input.memories > 0)
    parts.push(
      "",
      "### Memories",
      `Oxagen recorded ${plural(input.memories, "new line", "new lines")} from this pull request as memories. A person reviews each one before it steers an agent.`,
    );

  if (input.findings.length > 0)
    parts.push(
      "",
      "### Merge",
      input.blockMerge
        ? "workspace.toml sets `block_merge = true` under `[code_checks]`, so a finding fails this check."
        : "This check only warns. To make a finding fail it, set `block_merge = true` under `[code_checks]` in workspace.toml through a steering PR.",
    );

  const summary = parts.join("\n");
  return summary.length > CHECK_SUMMARY_MAX
    ? `${summary.slice(0, CHECK_SUMMARY_MAX - 1)}…`
    : summary;
}

function descriptionOf(input: ReportInput, title: string): string {
  let text = `${title}.`;
  if (input.findings.length > 0 && !input.blockMerge)
    text += " This check only warns.";
  return text.length > STATUS_DESCRIPTION_MAX
    ? `${text.slice(0, STATUS_DESCRIPTION_MAX - 1)}…`
    : text;
}

/** The Oxagen check for one pull request and one workspace. */
export function buildReport(input: ReportInput): CheckReport {
  const title = titleOf(input);
  return {
    conclusion: conclusionOf(input),
    title,
    summary: summaryOf(input),
    description: descriptionOf(input, title),
  };
}
