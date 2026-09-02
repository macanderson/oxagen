/**
 * permissions-gate.ts — Evaluates `settings.permissions` for the agent's local
 * tools (read_file/write_file/edit_file/bash/…).
 *
 * Rules use Claude Code's syntax: a canonical tool name, optionally narrowed by
 * a glob over the call's "subject" (the command for Bash, the path for a write,
 * the pattern for a search):
 *
 *   "Bash"             any shell command
 *   "Bash(git push*)"  shell commands starting with "git push"
 *   "Write(.env*)"     writes whose path matches ".env*"
 *   "Edit"             any surgical edit
 *
 * Decision order (deny always wins, matching the MCP gate and Claude Code):
 *   1. a `deny` rule matches            → deny
 *   2. an `allow` rule matches          → allow
 *   3. defaultMode "bypassPermissions"  → allow
 *   4. defaultMode "deny"               → deny  (deny-by-default; only allow-listed pass)
 *   5. otherwise (default/acceptEdits)  → allow
 *
 * When no `permissions` block is configured, every call is allowed. Gating is
 * opt-in: you get it by writing a `permissions` block.
 *
 * MATCHING IS LITERAL, NOT SEMANTIC. The pattern is glob-matched against the
 * raw subject string exactly as the model supplied it — no path resolution, no
 * shell parsing. Two consequences a rule author must plan for:
 *
 *   - A path rule matches text, not a file. `Write(.env*)` does not stop a
 *     write to `./.env`, `src/../.env`, or `/abs/path/.env`; write the rule as
 *     a set of patterns (`Write(*.env*)`) or deny the directory.
 *   - A Bash rule matches the command line, not the commands in it.
 *     `Bash(rm -rf*)` only matches a command that STARTS with `rm -rf`;
 *     `cd /tmp && rm -rf .` sails through.
 *
 * So a deny rule is a guardrail against the model's habitual phrasing, not a
 * sandbox. Anything that must not happen belongs behind `defaultMode: "deny"`
 * with a narrow allow list, or a PreToolUse hook that inspects the real input.
 */
import { matchGlob } from "@oxagen/mcp-config/permissions";
import type { Permissions } from "./schema.js";

export interface LocalPermissionResult {
  decision: "allow" | "deny";
  reason: string;
  /** The rule string that produced an explicit allow/deny, if any. */
  rule?: string;
}

/** Local tool id → canonical permission name used in rule strings. */
const CANONICAL: Record<string, string> = {
  read_file: "Read",
  list_dir: "Read",
  glob: "Read",
  grep: "Read",
  write_file: "Write",
  edit_file: "Edit",
  bash: "Bash",
};

/** Local tool id → the input field used as the rule "subject". */
const SUBJECT_FIELD: Record<string, string> = {
  read_file: "path",
  list_dir: "path",
  glob: "pattern",
  grep: "pattern",
  write_file: "path",
  edit_file: "path",
  bash: "command",
};

/** The canonical permission name for a tool (e.g. read_file → Read; mcp tools unchanged). */
export function canonicalToolName(toolName: string): string {
  return CANONICAL[toolName] ?? toolName;
}

function subjectOf(toolName: string, input: unknown): string {
  const field = SUBJECT_FIELD[toolName];
  if (!field || input === null || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

interface ParsedRule {
  tool: string;
  pattern?: string;
}

/** Parse "Bash(git*)" → { tool: "Bash", pattern: "git*" }; "Edit" → { tool: "Edit" }. */
export function parseRule(rule: string): ParsedRule {
  const trimmed = rule.trim();
  const open = trimmed.indexOf("(");
  if (open === -1 || !trimmed.endsWith(")")) return { tool: trimmed };
  return {
    tool: trimmed.slice(0, open).trim(),
    pattern: trimmed.slice(open + 1, -1).trim(),
  };
}

function ruleMatches(
  rule: string,
  canonical: string,
  subject: string,
): boolean {
  const parsed = parseRule(rule);
  // The tool token is glob-matched against the canonical name. For local tools
  // this is an exact compare ("Bash" === "Bash"); for MCP tools it lets a rule
  // like `mcp__github__*` match `mcp__github__create_issue`.
  if (!matchGlob(parsed.tool, canonical)) return false;
  if (parsed.pattern === undefined || parsed.pattern === "") return true;
  return matchGlob(parsed.pattern, subject);
}

/** Evaluate whether a local tool call is permitted under the resolved permissions. */
export function evaluateLocalPermission(
  toolName: string,
  input: unknown,
  permissions: Permissions | undefined,
): LocalPermissionResult {
  if (!permissions)
    return { decision: "allow", reason: "no permissions configured" };

  const canonical = CANONICAL[toolName] ?? toolName;
  const subject = subjectOf(toolName, input);

  for (const rule of permissions.deny ?? []) {
    if (ruleMatches(rule, canonical, subject)) {
      return { decision: "deny", reason: `denied by rule "${rule}"`, rule };
    }
  }
  for (const rule of permissions.allow ?? []) {
    if (ruleMatches(rule, canonical, subject)) {
      return { decision: "allow", reason: `allowed by rule "${rule}"`, rule };
    }
  }

  const mode = permissions.defaultMode ?? "default";
  if (mode === "bypassPermissions") {
    return { decision: "allow", reason: "defaultMode: bypassPermissions" };
  }
  if (mode === "deny") {
    return {
      decision: "deny",
      reason: "defaultMode: deny (no allow rule matched)",
    };
  }
  return { decision: "allow", reason: `defaultMode: ${mode}` };
}
