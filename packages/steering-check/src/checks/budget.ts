// budget.ts: what a steering PR adds to every request. Two budgets: the
// always-on steering per code repository, and the direct-mode tool
// definitions across the workspace. The check warns and never fails.
import {
  classifySteeringRepoPath,
  countTokens,
  DEFAULT_ALWAYS_ON_TOKENS,
  DEFAULT_WORKSPACE_DEFINITION_BUDGET,
  GOVERNANCE_TOML_PATH,
  recordStatement,
  TOOL_SERVERS_DIR,
  WORKSPACE_TOML_PATH,
} from "@oxagen/oxagen/steering-repo";
import { alwaysOnBlocks, type AlwaysOnBlock, type AlwaysOnEntry } from "../always-on";
import { finder, type ChangeCheck, type ChangeEnv } from "../finding";
import {
  canonicalJson,
  formatCount,
  isRecord,
  isString,
  parseTomlLoose,
  readRecordFile,
  serverFolders,
  tomlLine,
} from "../repo";
import type { Finding, SteeringTree } from "../types";

const find = finder("budget");

/** How many of the largest records or servers a finding names. */
const LARGEST = 3;

type Budget = { tokens: number; source: string } | "off";

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The always-on budget governance.toml sets, or Oxagen's default. */
export function alwaysOnBudget(tree: SteeringTree | null): Budget {
  const steering = parseTomlLoose(tree?.get(GOVERNANCE_TOML_PATH))?.steering;
  const value = isRecord(steering) ? steering.always_on_tokens : undefined;
  if (value === "off") return "off";
  if (isPositiveInteger(value)) return { tokens: value, source: "governance.toml" };
  return { tokens: DEFAULT_ALWAYS_ON_TOKENS, source: "Oxagen's default" };
}

/** The direct-mode definition budget workspace.toml sets, or Oxagen's default. */
export function definitionBudget(tree: SteeringTree | null): { tokens: number; source: string } {
  const tools = parseTomlLoose(tree?.get(WORKSPACE_TOML_PATH))?.tools;
  const value = isRecord(tools) ? tools.definition_budget : undefined;
  return isPositiveInteger(value)
    ? { tokens: value, source: "workspace.toml" }
    : { tokens: DEFAULT_WORKSPACE_DEFINITION_BUDGET, source: "Oxagen's default" };
}

function repositoryName(repository: string | null): string {
  return repository ?? "a repository no record names";
}

function sameBudget(a: Budget, b: Budget): boolean {
  if (a === "off" || b === "off") return a === b;
  return a.tokens === b.tokens;
}

function isRecordPath(path: string): boolean {
  const kind = classifySteeringRepoPath(path);
  return kind === "record" || kind === "skill-record";
}

function entryText(entry: AlwaysOnEntry): string {
  return `${entry.lineage} (${formatCount(entry.tokens)} tokens)`;
}

/** Tokens for each changed record's statement, for the summary. */
function changedRecordTokens(env: ChangeEnv): string[] {
  const lines: string[] = [];
  for (const path of [...env.changed].sort()) {
    if (!isRecordPath(path)) continue;
    const file = readRecordFile(path, env.head.get(path) as string);
    if (file === null) continue;
    lines.push(`${file.lineage ?? path} is ${formatCount(countTokens(recordStatement(file.body)))} tokens`);
  }
  return lines;
}

/** One changed record's growth in an always-on block. */
interface AddedEntry {
  lineage: string;
  path: string;
  /** The tokens the record added to the block. */
  added: number;
}

/** The changed records that added tokens to the block, largest first. */
function addedEntries(block: AlwaysOnBlock, prior: AlwaysOnBlock | undefined, changed: ReadonlySet<string>): AddedEntry[] {
  const was = new Map((prior?.entries ?? []).map((entry) => [entry.lineage, entry.tokens]));
  return block.entries
    .filter((entry) => changed.has(entry.path))
    .map((entry) => ({ lineage: entry.lineage, path: entry.path, added: entry.tokens - (was.get(entry.lineage) ?? 0) }))
    .filter((entry) => entry.added > 0)
    .sort((a, b) => b.added - a.added || (a.lineage < b.lineage ? -1 : 1));
}

function alwaysOnPart(env: ChangeEnv): { findings: Finding[]; notes: string[] } {
  const touched = [...env.changed, ...env.removed].some(
    (path) => isRecordPath(path) || path === GOVERNANCE_TOML_PATH || path === WORKSPACE_TOML_PATH,
  );
  if (!touched) return { findings: [], notes: [] };
  const budget = alwaysOnBudget(env.head);
  if (budget === "off") {
    return { findings: [], notes: ["governance.toml turns the always-on budget off."] };
  }
  const budgetMoved = env.base !== null && !sameBudget(budget, alwaysOnBudget(env.base));
  const before = new Map<string | null, AlwaysOnBlock>();
  if (env.base !== null) for (const block of alwaysOnBlocks(env.base)) before.set(block.repository, block);
  const governance = env.head.get(GOVERNANCE_TOML_PATH);
  const line = governance === undefined ? null : tomlLine(governance, "steering.always_on_tokens");
  const findings: Finding[] = [];
  const notes: string[] = [];
  for (const block of alwaysOnBlocks(env.head)) {
    const prior = before.get(block.repository);
    if (!budgetMoved && prior?.text === block.text) continue;
    const priorTokens = prior?.tokens ?? 0;
    notes.push(
      `${repositoryName(block.repository)}: ${formatCount(priorTokens)} to ${formatCount(block.tokens)} always-on tokens.`,
    );
    if (block.tokens <= budget.tokens) continue;
    const largest = [...block.entries].sort((a, b) => b.tokens - a.tokens).slice(0, LARGEST);
    const changed = block.entries.filter((entry) => env.changed.has(entry.path));
    const added = addedEntries(block, prior, env.changed);
    const names =
      added.length === 0
        ? ""
        : ` This steering PR added tokens in ${added.map((entry) => `${entry.lineage} (${formatCount(entry.added)} tokens)`).join(", ")}.`;
    findings.push(
      find({
        rule: "always-on",
        severity: "warning",
        path: GOVERNANCE_TOML_PATH,
        line,
        field: "steering.always_on_tokens",
        message: `Always-on steering for ${repositoryName(block.repository)} is ${formatCount(block.tokens)} tokens, over the budget of ${formatCount(budget.tokens)}. It was ${formatCount(priorTokens)} before this steering PR.${names}`,
        expected: `At most ${formatCount(budget.tokens)} tokens of always-on steering per code repository, from ${budget.source}.`,
        fix: `To keep this cost, merge as is, or raise always_on_tokens in this PR. To cut it, shorten a record, set force: may so it loads when it fits, or narrow it with repos, applies_to, or tools. The largest records are ${largest.map(entryText).join(", ")}.`,
        detail: {
          repository: block.repository,
          before: priorTokens,
          after: block.tokens,
          budget: budget.tokens,
          budget_source: budget.source,
          largest,
          changed,
          added,
        },
      }),
    );
  }
  const records = changedRecordTokens(env);
  if (records.length > 0) notes.push(`Changed records: ${records.join(", ")}.`);
  return { findings, notes };
}

/** One server's direct-mode definitions, in tokens. */
export interface ServerDefinitions {
  server: string;
  tokens: number;
  tools: number;
}

/**
 * The tokens each direct-mode server's definitions cost on every request. A
 * definition is the tool's name, description, and schemas as the lock holds
 * them, with tools.toml's description in place of the upstream one. It
 * approximates MCP Studio's count, which renders the full effective
 * definition, closely enough to rank servers and warn.
 */
export function directDefinitions(tree: SteeringTree): ServerDefinitions[] {
  const servers: ServerDefinitions[] = [];
  for (const [name, folder] of serverFolders(tree)) {
    const exposure = folder.server?.exposure;
    if (!isRecord(exposure) || exposure.mode !== "direct") continue;
    let tokens = 0;
    let tools = 0;
    for (const [key, entry] of folder.tools) {
      const upstream = folder.locked.get(key)?.upstream;
      if (!isRecord(upstream)) continue;
      const description = isString(entry.description) ? entry.description : upstream.description;
      const definition: Record<string, unknown> = {
        name: `${name}__${key}`,
        description,
        inputSchema: upstream.inputSchema,
      };
      if (upstream.outputSchema !== undefined) definition.outputSchema = upstream.outputSchema;
      if (upstream.annotations !== undefined) definition.annotations = upstream.annotations;
      tokens += countTokens(canonicalJson(definition));
      tools += 1;
    }
    servers.push({ server: name, tokens, tools });
  }
  return servers.sort((a, b) => b.tokens - a.tokens || (a.server < b.server ? -1 : 1));
}

function total(servers: readonly ServerDefinitions[]): number {
  return servers.reduce((sum, server) => sum + server.tokens, 0);
}

function toolsPart(env: ChangeEnv): { findings: Finding[]; notes: string[] } {
  const touched = [...env.changed, ...env.removed].some(
    (path) => path === WORKSPACE_TOML_PATH || path.startsWith(`${TOOL_SERVERS_DIR}/`),
  );
  if (!touched) return { findings: [], notes: [] };
  const budget = definitionBudget(env.head);
  const servers = directDefinitions(env.head);
  const after = total(servers);
  const before = env.base === null ? 0 : total(directDefinitions(env.base));
  const notes = [`Direct-mode tool definitions: ${formatCount(before)} to ${formatCount(after)} tokens.`];
  if (after <= budget.tokens) return { findings: [], notes };
  const workspace = env.head.get(WORKSPACE_TOML_PATH);
  const largest = servers.slice(0, LARGEST);
  const named = largest.map((server) => `${server.server} (${formatCount(server.tokens)} tokens)`).join(", ");
  return {
    notes,
    findings: [
      find({
        rule: "tool-definitions",
        severity: "warning",
        path: WORKSPACE_TOML_PATH,
        line: workspace === undefined ? null : tomlLine(workspace, "tools.definition_budget"),
        field: "tools.definition_budget",
        message: `Direct-mode tool definitions cost ${formatCount(after)} tokens on every request, over the budget of ${formatCount(budget.tokens)}. They cost ${formatCount(before)} before this steering PR.`,
        expected: `At most ${formatCount(budget.tokens)} tokens of direct-mode definitions, from ${budget.source}.`,
        fix: `Move the largest servers to search mode with mode = "search" under [exposure] in their server.toml: ${named}. Or raise definition_budget under [tools] in workspace.toml.`,
        detail: { before, after, budget: budget.tokens, budget_source: budget.source, largest },
      }),
    ],
  };
}

export const budgetCheck: ChangeCheck = (env) => {
  const always = alwaysOnPart(env);
  const tools = toolsPart(env);
  const notes = [...always.notes, ...tools.notes];
  return {
    findings: [...always.findings, ...tools.findings],
    note: notes.length === 0 ? undefined : notes.join(" "),
  };
};
