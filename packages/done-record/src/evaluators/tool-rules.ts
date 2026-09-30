// tool-rules.ts: match a recorded tool call against a tool rule.
//
// A rule is `Tool` or `Tool(pattern)`, the form a tools check's `deny` list
// uses (dod-spec.md): `Read(**/.env*)`, `Bash(curl *)`, `WebFetch`. The tools
// check reads the rules as a deny list, and the policy oracle reads the same
// rules as the capability set every call must stay inside.
//
// - The tool name is a flat glob: `*` crosses every character, so
//   `mcp__github__*` names every tool on one server.
// - A path tool's pattern is a path glob from @oxagen/glob, matched against the
//   path the call named.
// - A Bash pattern is a flat glob, matched against the whole command and
//   against each command a shell operator separates.
// - Any other tool's pattern is a flat glob, matched against each top-level
//   string in the call's input.
// - A rule that does not parse matches a tool whose name is the rule's text.
import { matchesGlob } from "@oxagen/glob";
import type { ToolCallRecord, TraceJson } from "./types";

/** Tools whose pattern is a path glob, and the input fields that carry the path. */
const PATH_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
  LS: ["path"],
};

/** The shell operators that separate one command from the next. */
const SHELL_SEPARATORS = /&&|\|\||[;|\n]/;

const RULE_FORM = /^([^()\s]+)(?:\(([\s\S]*)\))?$/;

/** A parsed tool rule. */
export interface ToolRule {
  /** The tool name, as a flat glob. */
  tool: string;
  /** The pattern inside the parentheses, when the rule has one. */
  pattern?: string;
}

/** Parse a rule. Returns undefined when the rule is not `Tool` or `Tool(pattern)`. */
export function parseToolRule(rule: string): ToolRule | undefined {
  const match = RULE_FORM.exec(rule.trim());
  if (!match) return undefined;
  const tool = match[1] as string;
  const pattern = match[2];
  return pattern === undefined ? { tool } : { tool, pattern };
}

/** Compile a flat glob, where `*` matches any run of characters and `?` any one. */
function flatGlob(pattern: string): RegExp {
  let re = "";
  for (const c of pattern) {
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (".+^${}()|[]\\/".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function field(input: TraceJson, key: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function topLevelStrings(input: TraceJson): string[] {
  if (typeof input === "string") return [input];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  return Object.values(input).filter((v): v is string => typeof v === "string");
}

/**
 * The parts of a call a pattern is matched against. A Bash call yields the
 * whole command first, then each command in it. A path tool yields its paths.
 */
function subjects(call: ToolCallRecord): { whole: string[]; parts: string[] } {
  if (call.tool === "Bash") {
    const command = field(call.input, "command");
    if (command === undefined) return { whole: [], parts: [] };
    const parts = command
      .split(SHELL_SEPARATORS)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return { whole: [command.trim()], parts };
  }
  const pathFields = PATH_TOOLS[call.tool];
  if (pathFields) {
    const paths = pathFields
      .map((key) => field(call.input, key))
      .filter((v): v is string => v !== undefined);
    return { whole: paths, parts: paths };
  }
  const strings = topLevelStrings(call.input);
  return { whole: strings, parts: strings };
}

function patternMatches(tool: string, pattern: string, subject: string): boolean {
  if (PATH_TOOLS[tool]) return matchesGlob(pattern, subject);
  return flatGlob(pattern).test(subject);
}

function toolNameMatches(rule: ToolRule | undefined, text: string, tool: string): boolean {
  if (!rule) return text.trim() === tool;
  return flatGlob(rule.tool).test(tool);
}

/**
 * Whether a deny rule matches a call. A Bash rule matches when it matches the
 * whole command or any command inside it, so `Bash(curl *)` catches
 * `cd x && curl http://example.com`.
 */
export function denyRuleMatches(rule: string, call: ToolCallRecord): boolean {
  const parsed = parseToolRule(rule);
  if (!toolNameMatches(parsed, rule, call.tool)) return false;
  if (parsed?.pattern === undefined) return true;
  const pattern = parsed.pattern;
  const { whole, parts } = subjects(call);
  return [...whole, ...parts].some((s) => patternMatches(call.tool, pattern, s));
}

/** The first deny rule that matches a call, or undefined when none does. */
export function firstDenyRule(
  rules: readonly string[],
  call: ToolCallRecord,
): string | undefined {
  return rules.find((rule) => denyRuleMatches(rule, call));
}

/**
 * Whether a call stays inside a capability set. Every part of the call must
 * match some rule for the call's tool: each command of a Bash call, and each
 * path of a path tool. A call with nothing to match stays inside only when a
 * rule names its tool with no pattern.
 */
export function callWithinCapabilities(
  capabilities: readonly string[],
  call: ToolCallRecord,
): boolean {
  const rules = capabilities
    .map((text) => ({ text, parsed: parseToolRule(text) }))
    .filter(({ text, parsed }) => toolNameMatches(parsed, text, call.tool));
  if (rules.some(({ parsed }) => parsed?.pattern === undefined)) return true;
  const { parts } = subjects(call);
  if (parts.length === 0) return false;
  return parts.every((part) =>
    rules.some(({ parsed }) =>
      patternMatches(call.tool, parsed?.pattern as string, part),
    ),
  );
}
