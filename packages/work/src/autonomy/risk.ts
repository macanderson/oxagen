// risk.ts: a pull request's risk, which decides whether level 2 and level 3 may merge it.
//
// agent-work-spec.html (Risk): a pull request is high risk when its diff touches
// a path a policy in policy/ marks high, such as migrations or authentication,
// or when a session on it called a tool that MCP Studio classified as high risk.
// It is medium risk when it changes more than 400 lines or more than 20 files.
// Everything else is low risk.
import { matchesGlob } from "@oxagen/glob";
import { MEDIUM_RISK_FILES, MEDIUM_RISK_LINES, type RiskLevel } from "../types";

/** One file in the pull request's diff. */
export interface RiskFile {
  path: string;
  /** The path before a rename. A rename out of a high-risk path touches that path. */
  previousPath?: string;
  additions: number;
  deletions: number;
}

/** One tool a session on the pull request called, with MCP Studio's class. */
export interface RiskTool {
  name: string;
  risk: RiskLevel;
}

export interface RiskInput {
  files: readonly RiskFile[];
  /** The path globs the steering repo's policies mark high. */
  highRiskPaths: readonly string[];
  toolsCalled: readonly RiskTool[];
}

export interface RiskResult {
  risk: RiskLevel;
  /** Why, one sentence per cause, so the pull request can show it. */
  reasons: string[];
}

function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** Compute a pull request's risk from its diff and the tools its sessions called. */
export function computeRisk(input: RiskInput): RiskResult {
  const high: string[] = [];
  for (const file of input.files) {
    for (const path of [file.path, file.previousPath]) {
      if (path === undefined) continue;
      const glob = input.highRiskPaths.find((g) => matchesGlob(g, path));
      if (glob !== undefined) high.push(`It changes ${path}, which a policy marks high risk (${glob}).`);
    }
  }
  const tools = [...new Set(input.toolsCalled.filter((t) => t.risk === "high").map((t) => t.name))].sort();
  for (const name of tools) high.push(`A session on it called ${name}, which MCP Studio classifies as high risk.`);
  if (high.length > 0) return { risk: "high", reasons: high };

  const medium: string[] = [];
  const unreadable = input.files.filter((f) => !isCount(f.additions) || !isCount(f.deletions)).map((f) => f.path);
  // A size Oxagen cannot read cannot be shown to be small.
  for (const path of unreadable) medium.push(`Its line count for ${path} is not a whole number, so its size is unknown.`);
  const lines = input.files.reduce(
    (sum, f) => sum + (isCount(f.additions) ? f.additions : 0) + (isCount(f.deletions) ? f.deletions : 0),
    0,
  );
  if (lines > MEDIUM_RISK_LINES) medium.push(`It changes ${lines} lines, more than ${MEDIUM_RISK_LINES}.`);
  const files = new Set(input.files.map((f) => f.path)).size;
  if (files > MEDIUM_RISK_FILES) medium.push(`It changes ${files} files, more than ${MEDIUM_RISK_FILES}.`);
  if (medium.length > 0) return { risk: "medium", reasons: medium };
  return { risk: "low", reasons: [] };
}
