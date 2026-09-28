// servers: the compile check's half for tool servers (steering-repo-spec,
// Compile; mcp-studio-spec, Try it and tests). For each server folder a
// steering PR changes, it:
//
// 1. Runs MCP Studio's tool checks (lane M5): its lint, or the lint option.
// 2. Verifies the lock: it parses, it names the server, and each entry's
//    upstream_hash is the hash of its upstream.
// 3. Compiles the folder against its lock with MCP Studio's compile (lane M4).
// 4. Replays each call in tests/calls.jsonl, in order, with no network: the
//    executor builds each request, replay serves the recorded response,
//    and the shaped result must equal the recorded one.
//
// A replay runs the executor, which is async, so this module sits beside
// runChecks. runChecksWithServers runs the other checks and adds these
// findings to the compile result.
//
// A steering PR cannot change the lock: the owned check refuses any edit. So
// the lock here is the production branch's, and a tools.toml change that
// alters a definition leaves its definition_hash behind. That is a warning:
// Oxagen writes the new lock when it syncs the server after the merge.
import {
  compile,
  CompileError,
  mcpToolsLockSchema,
  parseLock,
  parseRecordedCalls,
  parseServerToml,
  parseToolsToml,
  replayCall,
  toManifestServer,
  upstreamFromMcpTool,
  upstreamHash,
  type CompiledServer,
  type CompileIssue,
  type DefinitionLock,
  type FileIssue,
  lint as toolChecks,
  type LintContext,
  type Finding as LintFinding,
  type ServerFolder as LintServerFolder,
  type ManifestServer,
  type McpTools,
  type McpToolsLock,
  type ReadResult,
  type RecordedCall,
  type SecurityScheme,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import {
  CREDENTIAL_REF_PREFIX,
  serverFolderPath,
  serverTomlPath,
  TOOL_SERVERS_DIR,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo";
import { finder } from "../finding";
import { changedPaths, tomlLine } from "../repo";
import { brought, byPlace, countText, internalFinding, runChecks, statusOf } from "../run";
import type {
  CheckInput,
  CheckReport,
  CheckResult,
  Finding,
  ServerFileOutcome,
  ServerReaders,
  SteeringTree,
} from "../types";

const find = finder("compile");

/** The recorded calls in a server folder, relative to the folder. */
export const CALLS_FILE = "tests/calls.jsonl";

/** MCP Studio's tool checks for one folder. M5's lint() has this signature. */
export type ServerLint = (folder: LintServerFolder, context: LintContext) => readonly LintFinding[];

export interface ServerCheckOptions {
  /** The tool checks to run on each changed folder. Unset runs MCP Studio's lint(). */
  lint?: ServerLint;
}

/** What the servers half found, and the sentences it adds to the compile summary. */
export interface ServerCheckOutcome {
  findings: Finding[];
  notes: string[];
}

/** Text with a period at the end. Its first letter stays as it is, since a message may open on a tool key. */
function closed(text: string): string {
  const trimmed = text.trim();
  return /[.?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function outcomeOf<T>(read: ReadResult<T>): ServerFileOutcome {
  return read.ok ? { ok: true } : { ok: false, issues: read.issues };
}

/** MCP Studio's readers for server.toml and tools.toml, for the schema check. */
export const SERVER_READERS: ServerReaders = {
  server: (text) => outcomeOf(parseServerToml(text)),
  tools: (text) => outcomeOf(parseToolsToml(text)),
};

// ── The lock ─────────────────────────────────────────────────────────────────

const DEFINITION_SOURCES: ReadonlySet<string> = new Set(["openapi", "graphql", "grpc"]);

/** A lock written from an OpenAPI, GraphQL, or gRPC definition. Its source type says so. */
function isDefinitionLock(lock: McpToolsLock): lock is DefinitionLock {
  return DEFINITION_SOURCES.has(lock.source.type);
}

/**
 * The upstream tools a lock pins: a definition's tools as written, and an MCP
 * tool through upstreamFromMcpTool. The lock's source picks the branch,
 * because an `in` test on each entry left `request` typed as unknown.
 */
export function lockedUpstreamTools(lock: McpToolsLock): UpstreamTool[] {
  if (isDefinitionLock(lock)) return Object.values(lock.tools).map((entry) => entry.upstream);
  return Object.values(lock.tools).map((entry) => upstreamFromMcpTool(entry.upstream));
}

/** OpenAPI's security schemes as the lock's source recorded them, or none. */
export function lockedSecuritySchemes(lock: McpToolsLock): Record<string, SecurityScheme> {
  return "security_schemes" in lock.source ? (lock.source.security_schemes ?? {}) : {};
}

/** The 1-based line of a key in JSON that formatJson wrote, at this indent, from line `from` on. */
function jsonKeyLine(text: string, indent: number, key: string, from = 1): number | null {
  const prefix = `${" ".repeat(indent)}${JSON.stringify(key)}: `;
  const lines = text.split("\n");
  for (let index = from - 1; index < lines.length; index += 1) {
    if ((lines[index] as string).startsWith(prefix)) return index + 1;
  }
  return null;
}

/** The line of a tool's entry in the lock. The search starts at "tools", so a source key of the same name does not match. */
function lockToolLine(text: string, key: string): number | null {
  const tools = jsonKeyLine(text, 2, "tools");
  return tools === null ? null : jsonKeyLine(text, 4, key, tools);
}

type LockRead = { ok: true; lock: McpToolsLock } | { ok: false; issues: readonly FileIssue[] };

/**
 * The lock, parsed. A lock that fits the schema but not the form Oxagen
 * writes still reads: the owned check reports the hand edit, so this check
 * does not report it twice.
 */
function readLock(text: string): LockRead {
  const strict = parseLock(text);
  if (strict.ok) return { ok: true, lock: strict.value };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, issues: strict.issues };
  }
  const loose = mcpToolsLockSchema.safeParse(value);
  return loose.success ? { ok: true, lock: loose.data } : { ok: false, issues: strict.issues };
}

const RESYNC =
  "Restore tools.lock.json from the production branch. If the production branch has this lock, sync the server in Studio so Oxagen writes it again.";

function lockFindings(name: string, text: string, lock: McpToolsLock): Finding[] {
  const path = toolsLockPath(name);
  const findings: Finding[] = [];
  if (lock.server !== name) {
    findings.push(
      find({
        rule: "lock-server",
        path,
        line: jsonKeyLine(text, 2, "server"),
        field: "server",
        message: `The lock is for the server ${lock.server}, and it sits in the folder for ${name}.`,
        expected: `The lock in ${serverFolderPath(name)} names the server ${name}.`,
        fix: RESYNC,
      }),
    );
  }
  for (const [key, entry] of Object.entries(lock.tools)) {
    if (upstreamHash(entry.upstream) === entry.upstream_hash) continue;
    findings.push(
      find({
        rule: "lock-upstream-hash",
        path,
        line: lockToolLine(text, key),
        field: `tools.${key}.upstream_hash`,
        message: `The lock's upstream for ${name}__${key} does not hash to its upstream_hash, so the definition is not the one a person reviewed.`,
        expected: "Each lock entry's upstream_hash is the SHA-256 of its upstream.",
        fix: RESYNC,
      }),
    );
  }
  return findings;
}

// ── Tool checks ──────────────────────────────────────────────────────────────

function toolField(tool: string, field: string | undefined): string {
  return field === undefined ? `tools.${tool}` : `tools.${tool}.${field}`;
}

/**
 * The tool checks the seam leaves out, since another check reports the same
 * fault. The references check reports a credential the vault does not hold as
 * credential-exists, with its line and the closest name. The lock stands in
 * for what the source offers, so tool_not_offered would repeat two compile
 * findings: lock-matches reports a tool the lock does not hold, and it passes
 * one whose operation the OpenAPI document holds, which the next sync adds.
 * server-compiles reports a locked tool that selects nothing.
 */
const REPORTED_ELSEWHERE: ReadonlySet<string> = new Set(["unknown_credential", "tool_not_offered"]);

function lintFindings(name: string, texts: FolderTexts, found: readonly LintFinding[]): Finding[] {
  return found.filter((item) => !REPORTED_ELSEWHERE.has(item.rule)).map((item) => {
    const onTool = item.tool !== undefined;
    const field = item.tool === undefined ? (item.field ?? null) : toolField(item.tool, item.field);
    return find({
      rule: `lint-${item.rule.replaceAll("_", "-")}`,
      severity: item.level === "error" ? "error" : "warning",
      path: onTool ? toolsTomlPath(name) : serverTomlPath(name),
      line: field === null ? null : tomlLine(onTool ? texts.tools : texts.server, field),
      field,
      message: closed(item.message),
      expected: `${name} passes the ${item.rule} tool check.`,
      fix: closed(item.fix),
      detail: { tool_check: item.rule, level: item.level },
    });
  });
}

// ── Compile ──────────────────────────────────────────────────────────────────

function compileFinding(name: string, texts: FolderTexts, issue: CompileIssue): Finding {
  const onTool = issue.tool !== undefined;
  const field = issue.tool === undefined ? (issue.field ?? null) : toolField(issue.tool, issue.field);
  return find({
    rule: "server-compiles",
    path: onTool ? toolsTomlPath(name) : serverTomlPath(name),
    line: field === null ? null : tomlLine(onTool ? texts.tools : texts.server, field),
    field,
    message: closed(issue.message),
    expected: `${serverFolderPath(name)} compiles against its lock: every tool maps to a locked upstream, and every name and scheme applies.`,
    fix: onTool
      ? `Correct [tools.${issue.tool}] in tools.toml, or sync the server in Studio if the upstream changed.`
      : "Correct server.toml, or sync the server in Studio if the upstream changed.",
  });
}

/**
 * tools.toml with only the tools the lock holds. A tool that only the OpenAPI
 * document holds compiles when Oxagen syncs the server, and lock-matches
 * reports a tool that neither holds.
 */
function lockedOnly(tools: McpTools, lock: McpToolsLock): McpTools {
  const entries = Object.entries(tools.tools ?? {}).filter(([key]) => Object.hasOwn(lock.tools, key));
  return { ...tools, tools: Object.fromEntries(entries) };
}

function staleFindings(name: string, texts: FolderTexts, compiled: CompiledServer, lock: McpToolsLock): Finding[] {
  const findings: Finding[] = [];
  for (const [key, tool] of Object.entries(compiled.tools)) {
    const locked = lock.tools[key];
    if (locked === undefined || locked.definition_hash === tool.definition_hash) continue;
    findings.push(
      find({
        rule: "lock-current",
        severity: "warning",
        path: toolsTomlPath(name),
        line: tomlLine(texts.tools, `tools.${key}`),
        field: `tools.${key}`,
        message: `This change makes a new definition for ${name}__${key}, and the lock still pins the old one.`,
        expected: "Each tool's definition_hash in the lock is the hash of the definition tools.toml compiles to.",
        fix: "Nothing blocks the merge. Oxagen writes the new definition_hash and version when it syncs the server after the merge. To see the new lock first, sync the server in Studio.",
      }),
    );
  }
  return findings;
}

/** The lock with each compiled tool's definition_hash, so the change's definitions replay. */
function currentLock(lock: McpToolsLock, compiled: CompiledServer): McpToolsLock {
  const copy = structuredClone(lock);
  for (const [key, tool] of Object.entries(compiled.tools)) {
    const entry = copy.tools[key];
    if (entry !== undefined) entry.definition_hash = tool.definition_hash;
  }
  return copy;
}

// ── Replay ───────────────────────────────────────────────────────────────────

interface ReplayTally {
  /** Calls to a tool tools.toml no longer imports. */
  removed: number;
  /** Calls to a tool tools.toml imports and the lock does not hold yet. */
  unlocked: number;
  /** Why replayCall skipped a call, for each call it skipped. */
  skipped: string[];
}

function callsLabel(n: number): string {
  return n === 1 ? "1 recorded call" : `${n} recorded calls`;
}

function replayNotes(path: string, tally: ReplayTally): string[] {
  const notes: string[] = [];
  if (tally.removed > 0) {
    notes.push(`Replay skipped ${callsLabel(tally.removed)} in ${path}, because tools.toml no longer imports their tools.`);
  }
  if (tally.unlocked > 0) {
    notes.push(`Replay skipped ${callsLabel(tally.unlocked)} in ${path}, because the lock does not hold their tools yet.`);
  }
  for (const reason of new Set(tally.skipped)) notes.push(`Replay skipped a call in ${path}: ${closed(reason)}`);
  return notes;
}

function replayFinding(path: string, index: number, call: RecordedCall, message: string, detail: Record<string, unknown>): Finding {
  return find({
    rule: "replay-matches",
    path,
    line: index + 1,
    field: null,
    message: `The recorded ${call.tool} call no longer replays. ${message}`,
    expected: `Each call in ${path} replays with the requests and the result it recorded.`,
    fix: "If you meant to change the tool, run the call again in Studio's Try it panel and save it as a test to replace this line. Otherwise correct tools.toml so the replay matches.",
    detail,
  });
}

async function replayFolder(
  name: string,
  text: string,
  tools: McpTools,
  manifest: ManifestServer,
): Promise<ServerCheckOutcome> {
  const path = `${serverFolderPath(name)}/${CALLS_FILE}`;
  const read = parseRecordedCalls(text);
  if (!read.ok) {
    const findings = read.issues.map((issue) =>
      find({
        rule: "replay-parses",
        path,
        line: issue.line,
        field: issue.field,
        message: `The recorded call does not parse: ${closed(issue.message)}`,
        expected: "Each line of tests/calls.jsonl is one call, as Studio's Save as test writes it.",
        fix: "Save the call again from Studio's Try it panel, or remove the line.",
      }),
    );
    return { findings, notes: [] };
  }
  const tally: ReplayTally = { removed: 0, unlocked: 0, skipped: [] };
  const findings: Finding[] = [];
  // In order, one at a time: each call's line is its place in the file.
  for (const [index, call] of read.value.entries()) {
    if (!Object.hasOwn(manifest.tools, call.tool)) {
      if (Object.hasOwn(tools.tools ?? {}, call.tool)) tally.unlocked += 1;
      else tally.removed += 1;
      continue;
    }
    const result = await replayCall(manifest, call);
    if (result.status === "skipped") tally.skipped.push(result.reason);
    if (result.status !== "differs") continue;
    const { part, exchange, message } = result.difference;
    const detail: Record<string, unknown> = { tool: call.tool, part };
    if (exchange !== undefined) detail.exchange = exchange;
    findings.push(replayFinding(path, index, call, message, detail));
  }
  return { findings, notes: replayNotes(path, tally) };
}

// ── One folder ───────────────────────────────────────────────────────────────

interface FolderTexts {
  server: string;
  tools: string;
}

async function checkFolder(
  name: string,
  files: SteeringTree,
  context: LintContext,
  lint: ServerLint,
): Promise<ServerCheckOutcome> {
  const texts = { server: files.get(serverTomlPath(name)), tools: files.get(toolsTomlPath(name)) };
  if (texts.server === undefined || texts.tools === undefined) return { findings: [], notes: [] };
  const server = parseServerToml(texts.server);
  const tools = parseToolsToml(texts.tools);
  // The schema check reports a file that does not parse.
  if (!server.ok || !tools.ok) return { findings: [], notes: [] };
  const folderTexts: FolderTexts = { server: texts.server, tools: texts.tools };

  const lockText = files.get(toolsLockPath(name));
  const lockRead = lockText === undefined ? undefined : readLock(lockText);
  const lock = lockRead?.ok === true ? lockRead.lock : undefined;

  const folder: LintServerFolder = {
    name,
    server: server.value,
    tools: tools.value,
    lock,
    // The check reaches no network, so what the source offers is what the lock pins.
    offered: lock === undefined ? [] : lockedUpstreamTools(lock),
    notes: [],
  };
  const findings = lintFindings(name, folderTexts, lint(folder, context));

  // A server Oxagen has not imported yet has no lock, and its first import writes one.
  if (lockText === undefined || lockRead === undefined) return { findings, notes: [] };
  if (!lockRead.ok) {
    for (const issue of lockRead.issues) {
      findings.push(
        find({
          rule: "lock-parses",
          path: toolsLockPath(name),
          line: issue.line,
          field: issue.field,
          message: `The lock does not parse: ${closed(issue.message)}`,
          expected: "A tools.lock.json in the mcp-tools-lock/v1 form Oxagen writes.",
          fix: RESYNC,
        }),
      );
    }
    return { findings, notes: [] };
  }

  const pinned = lockRead.lock;
  const broken = lockFindings(name, lockText, pinned);
  if (broken.length > 0) return { findings: [...findings, ...broken], notes: [] };

  if (server.value.source.type === "grpc") {
    // #4627: compile needs the descriptor set the gRPC importer builds from the folder's proto files.
    return { findings, notes: [`The check does not compile or replay a gRPC server yet, so it skipped ${name}.`] };
  }

  let compiled: CompiledServer;
  try {
    compiled = compile({
      server: server.value,
      tools: lockedOnly(tools.value, pinned),
      upstream: lockedUpstreamTools(pinned),
      security_schemes: lockedSecuritySchemes(pinned),
      descriptor_set: undefined,
    });
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return { findings: [...findings, ...error.issues.map((issue) => compileFinding(name, folderTexts, issue))], notes: [] };
  }
  findings.push(...staleFindings(name, folderTexts, compiled, pinned));

  const callsText = files.get(`${serverFolderPath(name)}/${CALLS_FILE}`);
  if (callsText === undefined) return { findings, notes: [] };
  const manifest = toManifestServer(compiled, currentLock(pinned, compiled));
  const replayed = await replayFolder(name, callsText, tools.value, manifest);
  return { findings: [...findings, ...replayed.findings], notes: replayed.notes };
}

// ── Every changed folder ─────────────────────────────────────────────────────

function serverNames(paths: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    if (path.startsWith(`${TOOL_SERVERS_DIR}/`) && parts.length >= 4) names.add(parts[2] as string);
  }
  return [...names].sort();
}

/** The server folders a change touches, by name. With no base, every folder. */
export function changedServers(files: SteeringTree, base: SteeringTree | null): string[] {
  const { changed, removed } = changedPaths(files, base);
  return serverNames([...changed, ...removed]);
}

interface Change {
  base: SteeringTree | null;
  changed: ReadonlySet<string>;
  removed: ReadonlySet<string>;
}

/**
 * The findings the change brings, by the rule runChecks keeps: each one in a
 * changed file, and each other one the base does not have. The base's folder
 * runs only when a finding sits in a file the change leaves alone.
 */
async function broughtByChange(
  name: string,
  head: Finding[],
  change: Change,
  context: LintContext,
  lint: ServerLint,
): Promise<Finding[]> {
  const { base, changed, removed } = change;
  if (base === null || head.every((finding) => changed.has(finding.path) || removed.has(finding.path))) return head;
  const before = await checkFolder(name, base, context, lint);
  return brought(head, before.findings, changed, removed);
}

/**
 * Compile, verify, and replay each server folder the change touches. A folder
 * whose check throws reports one internal error, and the other folders still run.
 */
export async function checkServerFolders(
  input: Pick<CheckInput, "files" | "base" | "context">,
  options: ServerCheckOptions = {},
): Promise<ServerCheckOutcome> {
  const context: LintContext = {
    // The context holds vault names, and a tool check compares references.
    credentials: new Set(input.context.credentials.map((credential) => `${CREDENTIAL_REF_PREFIX}${credential}`)),
    accepted_unchanged: new Set(),
  };
  const lint = options.lint ?? toolChecks;
  const { changed, removed } = changedPaths(input.files, input.base);
  const change: Change = { base: input.base, changed, removed };
  const findings: Finding[] = [];
  const notes: string[] = [];
  for (const name of serverNames([...changed, ...removed])) {
    try {
      const outcome = await checkFolder(name, input.files, context, lint);
      findings.push(...(await broughtByChange(name, outcome.findings, change, context, lint)));
      notes.push(...outcome.notes);
    } catch (error) {
      findings.push({ ...internalFinding("compile", error), path: serverTomlPath(name) });
    }
  }
  return { findings, notes };
}

function withServers(entry: CheckResult, outcome: ServerCheckOutcome): CheckResult {
  const findings = [...entry.findings, ...outcome.findings].sort(byPlace);
  const before = countText(entry.findings);
  // Keep the compile check's own note, such as the one about Cedar.
  const note = entry.summary.startsWith(before) ? entry.summary.slice(before.length) : "";
  const extra = outcome.notes.map((line) => ` ${line}`).join("");
  return { ...entry, status: statusOf(findings), summary: `${countText(findings)}${note}${extra}`, findings };
}

/**
 * runChecks, plus the servers half of the compile check. It passes MCP
 * Studio's readers to the schema check unless the input names its own. Like
 * runChecks, it never throws.
 */
export async function runChecksWithServers(
  input: CheckInput,
  options: ServerCheckOptions = {},
): Promise<CheckReport> {
  const report = runChecks({ ...input, servers: input.servers ?? SERVER_READERS });
  if (input.checks !== undefined && !input.checks.includes("compile")) return report;
  let outcome: ServerCheckOutcome;
  try {
    outcome = await checkServerFolders(input, options);
  } catch (error) {
    outcome = { findings: [internalFinding("compile", error)], notes: [] };
  }
  if (outcome.findings.length === 0 && outcome.notes.length === 0) return report;
  const results = report.results.map((entry) => (entry.check === "compile" ? withServers(entry, outcome) : entry));
  const findings = results.flatMap((entry) => entry.findings);
  return { passed: !findings.some((finding) => finding.severity === "error"), results, findings };
}
