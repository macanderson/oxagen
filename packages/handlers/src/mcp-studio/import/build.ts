// build.ts: a Studio draft as a server folder (lane M11, ADR-224).
//
// Review turns the draft's edits into the files of tools/servers/<name>/:
// server.toml, tools.toml, tools.lock.json, the vendored definition, and
// tests/calls.jsonl. The build starts from the production branch's folder
// and applies the draft's ops in order, so a second Review of the same draft
// writes the same files.
//
// The build is pure. The Review handler reads the folders and the
// credentials, and opens the PR.
import { HandlerError } from "@oxagen/oxagen";
import type { StudioDraftOp, StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { TOOL_KEY_PATTERN, TOOL_NAME_MAX, TOOL_SEPARATOR } from "@oxagen/oxagen/steering-repo/names";
import {
  SERVER_TOML_NAME,
  TOOLS_LOCK_NAME,
  TOOLS_TOML_NAME,
  serverFolderPath,
} from "@oxagen/oxagen/steering-repo/paths";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import {
  CompileError,
  agentEnvironment,
  canonicalText,
  compile,
  definitionLockSourceSchema,
  formatJson,
  isDefinitionSource,
  lint,
  lock,
  mcpToolsSchema,
  parseLock,
  parseServerToml,
  parseToolsToml,
  suggest,
  type CompiledServer,
  type DefinitionLockSource,
  type FileIssue,
  type Finding,
  type McpLockSource,
  type McpServer,
  type McpTools,
  type McpToolsLock,
  type RequestKind,
  type SecurityScheme,
  type ServerSourceType,
  type ToolsEntry,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import {
  CALLS_FILE,
  lockedSecuritySchemes,
  lockedUpstreamTools,
} from "@oxagen/steering-check/servers";
import { stringify } from "smol-toml";
import { checkTests, describeIssues, recordedCall } from "./checks";
import {
  GRAPHQL_FILE,
  OPENAPI_FILE,
  OVERLAY_FILE,
  PROTO_DIR,
  type ImportedSource,
} from "./source";

type TestOp = Extract<StudioDraftOp, { kind: "test" }>;
type ClassifyOp = Extract<StudioDraftOp, { kind: "classify" }>;

/** A tool's classification in the contract's words. */
export interface StudioClassification {
  risk: ToolsEntry["risk"];
  sideEffect: ToolsEntry["side_effect"];
  egress: ToolsEntry["egress"];
  impacts: string[];
}

export interface BuildInput {
  draft: {
    server: string;
    ops: readonly StudioDraftOp[];
    serverToml: string | null;
    source: StudioSource | null;
  };
  /** The draft's source, imported again, or null when the draft has none. */
  imported: ImportedSource | null;
  /** The production branch's managed files, by path relative to the folder. */
  production: ReadonlyMap<string, string>;
  /** The workspace's credential references, `oxagen:credential/<name>`. */
  credentials: ReadonlySet<string>;
  /**
   * What an imported tool with no classification does to the build. Review
   * refuses it (the default), because a steering PR must not carry a tool
   * Oxagen cannot decide. list_studio_findings reports it as an error finding
   * and builds the tool with its suggested classification, so the draft's
   * other findings and its definition tokens still come back. A reported
   * build's files are for reading only, never for a commit.
   */
  unclassified?: "refuse" | "report";
}

/** The folder a Review writes, and what it changed. */
export interface BuiltFolder {
  server: string;
  /** True when production has no server.toml for the server. */
  isNew: boolean;
  /** Every managed file the folder holds after the Review, relative to the folder. */
  files: Map<string, string>;
  imported: string[];
  removed: string[];
  reclassified: { tool: string; before: StudioClassification; after: StudioClassification }[];
  described: string[];
  tested: string[];
  tokens: { definitions: number; budget: number };
  findings: {
    rule: string;
    level: Finding["level"];
    tool: string | null;
    field: string | null;
    message: string;
    fix: string;
  }[];
}

/** tools.toml's selector for each request kind. */
const SELECTORS = {
  mcp: "upstream",
  http: "operation",
  graphql: "field",
  grpc: "method",
} as const satisfies Record<RequestKind, keyof ToolsEntry>;

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

const LEVEL_ORDER: Record<Finding["level"], number> = { error: 0, warning: 1, info: 2 };

/** A suggested classification in the contract's words. */
function suggestedClassification(
  upstream: UpstreamTool,
  context: Parameters<typeof suggest>[1],
): StudioClassification {
  const s = suggest(upstream, context);
  return { risk: s.risk, sideEffect: s.side_effect, egress: s.egress, impacts: [...s.impacts] };
}

/** Up to three zod issues as one sentence each. */
function zodIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return describeIssues(
    issues.map((issue) => ({
      line: null,
      field: issue.path.length === 0 ? null : issue.path.map(String).join("."),
      message: issue.message,
    })),
  );
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** A definition file the folder vendors: openapi.yaml, overlay.yaml, schema.graphql, or proto/**. */
export function isDefinitionPath(path: string): boolean {
  return path === OPENAPI_FILE || path === OVERLAY_FILE || path === GRAPHQL_FILE || path.startsWith(PROTO_DIR);
}

/** A file Review writes. Every other file in the folder stays as it is. */
export function isManagedPath(path: string): boolean {
  return (
    path === SERVER_TOML_NAME ||
    path === TOOLS_TOML_NAME ||
    path === TOOLS_LOCK_NAME ||
    path === CALLS_FILE ||
    isDefinitionPath(path)
  );
}

/** A path inside the folder: relative, with no `..`, `.`, empty segment, or backslash. */
export function isFolderPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The commit that turns `current` into `desired`: each managed file whose
 * text differs, and a deletion for each managed file `desired` drops. Paths
 * are the repository's, sorted.
 */
export function folderCommit(
  server: string,
  desired: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): { path: string; content: string | null }[] {
  const folder = serverFolderPath(server);
  const out: { path: string; content: string | null }[] = [];
  for (const [path, text] of desired) {
    if (current.get(path) !== text) out.push({ path: `${folder}/${path}`, content: text });
  }
  for (const path of current.keys()) {
    if (isManagedPath(path) && !desired.has(path)) out.push({ path: `${folder}/${path}`, content: null });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ── Tools ────────────────────────────────────────────────────────────────────

function requestKindOf(type: ServerSourceType): RequestKind {
  switch (type) {
    case "openapi":
      return "http";
    case "graphql":
      return "graphql";
    case "grpc":
      return "grpc";
    default:
      return "mcp";
  }
}

/** The upstream name a tool's request selects: the MCP tool, operation, field, or method. */
export function selectedName(tool: UpstreamTool): string {
  switch (tool.request.kind) {
    case "mcp":
      return tool.request.tool;
    case "http":
      return tool.request.operation;
    case "graphql":
      return tool.request.field;
    case "grpc":
      return tool.request.method;
  }
}

/** The upstream name a tools.toml entry selects, as compile finds it. */
function entrySelects(kind: RequestKind, key: string, entry: ToolsEntry): string | undefined {
  if (kind === "mcp") return entry.upstream ?? key;
  return entry[SELECTORS[kind]];
}

/**
 * The tools.toml key for a newly imported tool: the source's suggested name
 * when it is a valid key, else the upstream name in snake case. It leaves room
 * for `<server>__`, so the full tool name stays within 64 characters.
 */
export function derivedKey(tool: UpstreamTool, server: string): string {
  const room = TOOL_NAME_MAX - server.length - TOOL_SEPARATOR.length;
  const wanted = tool.suggestion?.name ?? tool.name;
  if (TOOL_KEY_PATTERN.test(wanted) && wanted.length <= room) return wanted;
  let key = wanted
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(key)) key = `t_${key}`;
  return key.slice(0, room).replace(/_+$/, "");
}

function classificationOf(entry: ToolsEntry): StudioClassification {
  return {
    risk: entry.risk,
    sideEffect: entry.side_effect,
    egress: entry.egress,
    impacts: [...(entry.impacts ?? [])],
  };
}

function classificationOfOp(op: ClassifyOp): StudioClassification {
  return { risk: op.risk, sideEffect: op.sideEffect, egress: op.egress, impacts: [...op.impacts] };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function sameClassification(a: StudioClassification, b: StudioClassification): boolean {
  return a.risk === b.risk && a.sideEffect === b.sideEffect && a.egress === b.egress && sameSet(a.impacts, b.impacts);
}

/** An entry with the classification applied. An empty impacts list leaves the key out. */
function classified(entry: ToolsEntry, c: StudioClassification): ToolsEntry {
  const next: ToolsEntry = { ...entry, risk: c.risk, side_effect: c.sideEffect, egress: c.egress };
  if (c.impacts.length > 0) next.impacts = [...c.impacts] as ToolsEntry["impacts"];
  else delete next.impacts;
  return next;
}

/** The network suggest() reads: undefined when the machine runs the server, else the agent environment's. */
export function suggestNetwork(server: McpServer): string | undefined {
  const source = server.source;
  if (source.type === "local") return undefined;
  if (source.type === "registry" && source.machines !== undefined) return undefined;
  let environment: string | undefined;
  try {
    environment = agentEnvironment(server);
  } catch {
    environment = undefined;
  }
  const envNetwork = environment === undefined ? undefined : server.environments?.[environment]?.network;
  const sourceNetwork = "network" in source ? source.network : undefined;
  return envNetwork ?? sourceNetwork ?? "cloud";
}

// ── Sources ──────────────────────────────────────────────────────────────────

/** Why the draft's source does not fit server.toml's, or null. */
function sourceMismatch(server: McpServer, draft: StudioSource, imported: ImportedSource): string | null {
  const type = server.source.type;
  if (draft.type === "mcp") {
    if (isDefinitionSource(server.source)) {
      return `server.toml builds ${server.name} from a ${type} definition, and the draft's source is an MCP server.`;
    }
    const lockType = imported.mcpLockSource?.type;
    return lockType === type
      ? null
      : `server.toml's source is ${type}, and the draft's MCP source is ${lockType ?? "missing"}.`;
  }
  if (draft.type !== type || !isDefinitionSource(server.source)) {
    return `server.toml's source is ${type}, and the draft's source is a ${draft.type} definition.`;
  }
  const from = server.source.from;
  const live = "introspection" in draft ? "introspection" : "reflection" in draft ? "reflection" : null;
  if (live !== null && from !== live) {
    return `server.toml reads ${server.name} from ${from}, and the draft's definition came from ${live}.`;
  }
  if (live === null && (from === "introspection" || from === "reflection")) {
    return `server.toml reads ${server.name} from ${from}, and the draft sent the definition's files.`;
  }
  return null;
}

/** The lock's source for a definition imported at Review. */
function definitionLockSource(server: McpServer, imported: ImportedSource): DefinitionLockSource {
  const source = server.source;
  if (!isDefinitionSource(source) || imported.documentHash === null) {
    throw refuse("source_invalid", `The draft's source gives no definition hash for ${server.name}.`);
  }
  const out: Record<string, unknown> = { type: source.type, from: source.from, document_hash: imported.documentHash };
  if (source.from === "repository") {
    if (imported.commit === undefined) {
      throw refuse(
        "source_commit_missing",
        `server.toml reads ${server.name} from ${source.repo ?? "a repository"}, and the draft does not say which commit its definition came from. Import the definition again, then Review.`,
      );
    }
    if (source.repo !== undefined) out.repo = source.repo;
    if (source.path !== undefined) out.path = source.path;
    if (source.ref !== undefined) out.ref = source.ref;
    out.commit = imported.commit;
  }
  if (source.from === "url" && source.url !== undefined) out.url = source.url;
  if (source.type === "openapi" && Object.keys(imported.securitySchemes).length > 0) {
    out.security_schemes = imported.securitySchemes;
  }
  const parsed = definitionLockSourceSchema.safeParse(out);
  if (!parsed.success) {
    throw refuse("source_invalid", `The lock cannot record the draft's source. ${zodIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

// ── Ops ──────────────────────────────────────────────────────────────────────

/**
 * One tool an op names: a tools.toml key, a tool the source offers that no
 * entry selects, or a name neither holds.
 */
type Identity =
  | { kind: "key"; id: string; key: string }
  | { kind: "new"; id: string; upstream: UpstreamTool }
  | { kind: "unknown"; id: string; name: string };

interface Resolver {
  identify(name: string): Identity;
}

/** The name a person reads for an identity: its key, its upstream name, or what the op said. */
function identityName(identity: Identity): string {
  if (identity.kind === "key") return identity.key;
  if (identity.kind === "new") return selectedName(identity.upstream);
  return identity.name;
}

function resolver(kind: RequestKind, tools: Record<string, ToolsEntry>, offered: readonly UpstreamTool[]): Resolver {
  const bySelected = new Map<string, UpstreamTool>();
  const byName = new Map<string, UpstreamTool>();
  for (const tool of offered) {
    bySelected.set(selectedName(tool), tool);
    if (!byName.has(tool.name)) byName.set(tool.name, tool);
  }
  const keyBySelected = new Map<string, string>();
  for (const [key, entry] of Object.entries(tools)) {
    const name = entrySelects(kind, key, entry);
    if (name !== undefined && !keyBySelected.has(name)) keyBySelected.set(name, key);
  }
  return {
    identify(name) {
      if (Object.hasOwn(tools, name)) return { kind: "key", id: `key:${name}`, key: name };
      const upstream = bySelected.get(name) ?? byName.get(name);
      const selected = upstream === undefined ? name : selectedName(upstream);
      const key = keyBySelected.get(selected);
      if (key !== undefined) return { kind: "key", id: `key:${key}`, key };
      if (upstream !== undefined) return { kind: "new", id: `new:${selected}`, upstream };
      return { kind: "unknown", id: `unknown:${name}`, name };
    },
  };
}

interface Staged {
  imports: Map<string, Identity>;
  removed: Set<string>;
  classify: Map<string, { identity: Identity; op: ClassifyOp }>;
  describe: Map<string, { identity: Identity; description: string }>;
  tests: { identity: Identity; op: TestOp }[];
}

/**
 * The ops in order. An import and a remove of one tool cancel each other,
 * and a later classify or describe of a tool replaces an earlier one.
 */
function stage(ops: readonly StudioDraftOp[], resolve: Resolver): Staged {
  const staged: Staged = { imports: new Map(), removed: new Set(), classify: new Map(), describe: new Map(), tests: [] };
  for (const op of ops) {
    const identity = resolve.identify(op.tool);
    switch (op.kind) {
      case "import":
        if (identity.kind === "key") staged.removed.delete(identity.key);
        else staged.imports.set(identity.id, identity);
        break;
      case "remove":
        if (identity.kind === "key") staged.removed.add(identity.key);
        else staged.imports.delete(identity.id);
        break;
      case "classify":
        staged.classify.set(identity.id, { identity, op });
        break;
      case "describe":
        staged.describe.set(identity.id, { identity, description: op.description });
        break;
      case "test":
        staged.tests.push({ identity, op });
        break;
    }
  }
  return staged;
}

// ── Files ────────────────────────────────────────────────────────────────────

function tomlFile(value: McpTools): string {
  return `${schemaDirective("mcp-tools/v1")}\n${stringify(value)}`;
}

/** The lines of tests/calls.jsonl kept: every line but those of a tool that left tools.toml. */
function keptCalls(text: string | undefined, keep: (tool: string) => boolean): string[] {
  if (text === undefined) return [];
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      try {
        const value = JSON.parse(line) as { tool?: unknown };
        return typeof value.tool !== "string" || keep(value.tool);
      } catch {
        return true;
      }
    });
}

function parsedOrRefuse<T>(
  result: { ok: true; value: T } | { ok: false; issues: FileIssue[] },
  reason: string,
  label: string,
): T {
  if (result.ok) return result.value;
  throw refuse(reason, `${label} does not validate. ${describeIssues(result.issues)}`);
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * The server folder the draft makes, from production's folder and the
 * draft's ops. Refuses with a `conflict` HandlerError when the folder would
 * not pass the steering checks, and when an imported tool lacks a
 * classification unless `input.unclassified` is "report".
 */
export function buildFolder(input: BuildInput): BuiltFolder {
  const { draft, imported, production } = input;
  checkTests(draft.ops);

  // server.toml: the draft's, or production's.
  const serverText = draft.serverToml ?? production.get(SERVER_TOML_NAME);
  if (serverText === undefined) {
    throw refuse(
      "server_toml_missing",
      `${draft.server} has no server.toml on the production branch, and the draft holds none. Set up the server's connection, then Review.`,
    );
  }
  const server = parsedOrRefuse(parseServerToml(serverText), "server_toml_invalid", "server.toml");
  if (server.name !== draft.server) {
    throw refuse(
      "server_name_mismatch",
      `server.toml names ${server.name}, and the draft is for ${draft.server}. A folder's server.toml names the folder.`,
    );
  }
  const toolsText = production.get(TOOLS_TOML_NAME);
  const previousTools: McpTools =
    toolsText === undefined
      ? { schema: "mcp-tools/v1" }
      : parsedOrRefuse(parseToolsToml(toolsText), "folder_invalid", "Production's tools.toml");
  const lockText = production.get(TOOLS_LOCK_NAME);
  const previous: McpToolsLock | undefined =
    lockText === undefined ? undefined : parsedOrRefuse(parseLock(lockText), "folder_invalid", "Production's tools.lock.json");

  const kind = requestKindOf(server.source.type);
  if (imported === null || draft.source === null) {
    if (server.source.type === "grpc") {
      throw refuse(
        "source_required",
        `${server.name} is a gRPC server, and Review needs its descriptors. Import the proto files or reflection again, then Review.`,
      );
    }
    if (previous === undefined) {
      throw refuse(
        "source_required",
        `${server.name} has no tools.lock.json yet, so Review needs the draft's source. Import the server's tools, then Review.`,
      );
    }
  } else {
    const mismatch = sourceMismatch(server, draft.source, imported);
    if (mismatch !== null) throw refuse("source_invalid", mismatch);
  }
  const source = imported !== null && draft.source !== null ? imported : null;
  const offered: UpstreamTool[] =
    source !== null ? source.offered : previous !== undefined ? lockedUpstreamTools(previous) : [];
  const securitySchemes: Record<string, SecurityScheme> =
    source !== null ? source.securitySchemes : previous !== undefined ? lockedSecuritySchemes(previous) : {};

  // The ops, against production's tools.toml.
  const before: Record<string, ToolsEntry> = { ...(previousTools.tools ?? {}) };
  const resolve = resolver(kind, before, offered);
  const staged = stage(draft.ops, resolve);

  const pending = [...staged.imports.values()];
  if (source === null && pending.length > 0) {
    throw refuse(
      "source_required",
      `The draft imports ${pending.map(identityName).join(", ")}, and Review needs the draft's source to add a tool. Import the server's tools again, then Review.`,
    );
  }
  const notOffered = pending.filter((identity) => identity.kind === "unknown");
  if (notOffered.length > 0) {
    throw refuse(
      "tool_not_offered",
      `The source does not offer ${notOffered.map(identityName).join(", ")}. Import the server's tools again, or remove the tool from the draft.`,
    );
  }
  const unknownEdits = [...staged.classify.values(), ...staged.describe.values(), ...staged.tests]
    .map(({ identity }) => identity)
    .filter((identity) => identity.kind === "unknown");
  if (unknownEdits.length > 0) {
    throw refuse(
      "tool_not_found",
      `The draft changes ${[...new Set(unknownEdits.map(identityName))].join(", ")}, which neither tools.toml nor the source holds. Discard the change, then Review.`,
    );
  }

  // Keys for the new tools, and their classifications.
  const after: Record<string, ToolsEntry> = {};
  for (const [key, entry] of Object.entries(before)) {
    if (!staged.removed.has(key)) after[key] = entry;
  }
  const context = { source: server.source.type, network: suggestNetwork(server) };
  const newKeys = new Map<string, string>();
  const unclassified: string[] = [];
  for (const identity of staged.imports.values()) {
    if (identity.kind !== "new") continue;
    const key = derivedKey(identity.upstream, server.name);
    if (Object.hasOwn(after, key) || [...newKeys.values()].includes(key)) {
      throw refuse(
        "tool_key_collision",
        `${selectedName(identity.upstream)} would be keyed ${key} in tools.toml, and another tool already has that key. Remove one of them from the draft, then Review.`,
      );
    }
    newKeys.set(identity.id, key);
    if (!staged.classify.has(identity.id)) unclassified.push(key);
  }
  if (unclassified.length > 0 && input.unclassified !== "report") {
    throw refuse(
      "tools_unclassified",
      `Every imported tool needs a risk, a side effect, and an egress before Review opens a steering PR. Classify ${unclassified.join(", ")}.`,
    );
  }

  const keyOf = (identity: Identity): string | undefined => {
    if (identity.kind === "key") return Object.hasOwn(after, identity.key) ? identity.key : undefined;
    if (identity.kind === "new") return newKeys.get(identity.id);
    return undefined;
  };

  const reclassified: BuiltFolder["reclassified"] = [];
  const accepted = new Set<string>();
  const described: string[] = [];

  // Existing entries first, in tools.toml's order, then the new ones.
  for (const [key, entry] of Object.entries(after)) {
    const change = staged.classify.get(`key:${key}`);
    if (change !== undefined) {
      const was = classificationOf(entry);
      const next = classificationOfOp(change.op);
      if (!sameClassification(was, next)) {
        after[key] = classified(entry, next);
        reclassified.push({ tool: key, before: was, after: next });
      }
    }
    const description = staged.describe.get(`key:${key}`)?.description;
    if (description !== undefined && description !== after[key]?.description) {
      after[key] = { ...(after[key] as ToolsEntry), description };
      described.push(key);
    }
  }
  const importedKeys: string[] = [];
  for (const identity of staged.imports.values()) {
    if (identity.kind !== "new") continue;
    const key = newKeys.get(identity.id) as string;
    // Only a reported build reaches here without a classify op.
    const change = staged.classify.get(identity.id);
    const c =
      change === undefined ? suggestedClassification(identity.upstream, context) : classificationOfOp(change.op);
    const entry: Record<string, unknown> = {};
    if (kind === "mcp") {
      if (identity.upstream.request.kind === "mcp" && identity.upstream.request.tool !== key) {
        entry.upstream = identity.upstream.request.tool;
      }
    } else {
      entry[SELECTORS[kind]] = selectedName(identity.upstream);
    }
    entry.risk = c.risk;
    entry.side_effect = c.sideEffect;
    entry.egress = c.egress;
    if (c.impacts.length > 0) entry.impacts = c.impacts;
    const description = staged.describe.get(identity.id)?.description;
    if (description !== undefined) {
      entry.description = description;
      described.push(key);
    }
    after[key] = entry as ToolsEntry;
    importedKeys.push(key);
  }

  // A new tool's classification left as suggested, for lint's irreversible
  // check. A change to a tool already in tools.toml is a deliberate edit.
  // An unclassified tool in a reported build is not counted: nobody accepted
  // its suggestion, and its missing_classification error already stands.
  for (const identity of staged.imports.values()) {
    if (identity.kind !== "new") continue;
    const key = newKeys.get(identity.id) as string;
    const change = staged.classify.get(identity.id);
    if (change === undefined) continue;
    const suggestion = suggestedClassification(identity.upstream, context);
    if (sameClassification(suggestion, classificationOfOp(change.op))) accepted.add(key);
  }

  const toolsValue: Record<string, unknown> = { schema: "mcp-tools/v1" };
  if (previousTools.defaults !== undefined) toolsValue.defaults = previousTools.defaults;
  if (previousTools.tools !== undefined || Object.keys(after).length > 0) toolsValue.tools = after;
  const toolsParsed = mcpToolsSchema.safeParse(toolsValue);
  if (!toolsParsed.success) {
    throw refuse("folder_invalid", `tools.toml would not validate. ${zodIssues(toolsParsed.error.issues)}`);
  }
  const tools = toolsParsed.data;

  // Compile and lock against what the source offers now.
  let compiled: CompiledServer;
  let nextLock: McpToolsLock;
  try {
    compiled = compile({
      server,
      tools,
      upstream: offered,
      security_schemes: securitySchemes,
      descriptor_set: source?.descriptorSet,
    });
    const lockSource: McpLockSource | DefinitionLockSource =
      source === null
        ? (previous as McpToolsLock).source
        : source.type === "mcp"
          ? (source.mcpLockSource as McpLockSource)
          : definitionLockSource(server, source);
    nextLock = lock({ compiled, source: lockSource, previous });
  } catch (err) {
    if (err instanceof HandlerError) throw err;
    if (err instanceof CompileError) {
      throw refuse(
        "folder_invalid",
        `${server.name} does not compile. ${describeIssues(
          err.issues.map((issue) => ({
            line: null,
            field: [issue.tool, issue.field].filter((part) => part !== undefined).join(".") || null,
            message: issue.message,
          })),
        )}`,
      );
    }
    throw refuse("folder_invalid", `${server.name} does not lock. ${err instanceof Error ? err.message : String(err)}`);
  }

  const linted: BuiltFolder["findings"] = lint(
    { name: server.name, server, tools, lock: nextLock, offered, notes: source?.notes ?? [] },
    { credentials: input.credentials, accepted_unchanged: accepted },
  ).map((finding) => ({
    rule: finding.rule,
    level: finding.level,
    tool: finding.tool ?? null,
    field: finding.field ?? null,
    message: finding.message,
    fix: finding.fix,
  }));
  // A reported build's unclassified tools, first among the errors, then
  // lint's findings. The sort is stable, so each level keeps lint's order.
  const findings = [
    ...unclassified.map((key) => ({
      rule: "missing_classification",
      level: "error" as const,
      tool: key,
      field: null,
      message: `${key} has no risk, side effect, or egress yet. Oxagen decides each call from them, so Review refuses the draft until the tool is classified.`,
      fix: `Classify ${key}: set its risk, side effect, and egress.`,
    })),
    ...linted,
  ].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  // The files.
  const files = new Map<string, string>();
  files.set(SERVER_TOML_NAME, serverText);
  files.set(
    TOOLS_TOML_NAME,
    toolsText !== undefined && canonicalText(tools) === canonicalText(previousTools) ? toolsText : tomlFile(tools),
  );
  files.set(TOOLS_LOCK_NAME, formatJson(nextLock));
  if (source !== null) {
    for (const file of source.files) {
      if (!isFolderPath(file.path) || !isDefinitionPath(file.path) || files.has(file.path)) {
        throw refuse(
          "definition_path_invalid",
          `The definition names ${file.path}. A definition file is openapi.yaml, overlay.yaml, schema.graphql, or a file under proto/, named once, inside the server's folder.`,
        );
      }
      files.set(file.path, file.text);
    }
  } else {
    for (const [path, text] of production) {
      if (isDefinitionPath(path)) files.set(path, text);
    }
  }

  // A recorded call production already holds is not added twice, so a Review
  // after the steering PR merges finds nothing new to commit.
  const kept = new Set(Object.keys(after));
  const calls = keptCalls(production.get(CALLS_FILE), (tool) => kept.has(tool));
  const tested: string[] = [];
  for (const { identity, op } of staged.tests) {
    const key = keyOf(identity);
    if (key === undefined) continue;
    const line = JSON.stringify(recordedCall(op, key));
    if (calls.includes(line)) continue;
    calls.push(line);
    tested.push(key);
  }
  if (calls.length > 0) files.set(CALLS_FILE, `${calls.join("\n")}\n`);

  return {
    server: server.name,
    isNew: !production.has(SERVER_TOML_NAME),
    files,
    imported: importedKeys,
    removed: Object.keys(before).filter((key) => staged.removed.has(key)),
    reclassified,
    described,
    tested,
    tokens: { definitions: compiled.tokens.definitions, budget: compiled.exposure.definition_budget },
    findings,
  };
}
