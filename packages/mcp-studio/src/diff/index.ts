// diff: the tool surface diff a sync PR or an import PR shows (lane M4;
// mcp-studio-spec, Sync).
//
// diff() compares the lock and manifest entry the gateway serves now with
// the ones a steering PR proposes, and lists every tool the source offers
// that is not imported. A breaking change keeps the tool withheld until the
// steering PR merges.
//
// Inputs are read from the effective definitions, because the agent sends
// what those name, after hide, fixed, defaults, and rename. Response fields
// are read from the upstreams, because select names upstream paths and
// trims the served outputSchema to them. A classification change moves
// neither hash, so it is not a tool surface change and is not listed.
import { isRecord, propertiesOf, requiredOf } from "../compile/json-schema";
import { canonicalText } from "../contract/json";
import type { LockedTool, McpToolsLock } from "../contract/lock";
import type { ManifestServer, ManifestTool } from "../contract/manifest";
import type { LockedMcpTool } from "../contract/mcp-tool";
import type { RequestKind, UpstreamTool } from "../model/upstream-tool";

/**
 * Why a change breaks an agent that already calls the tool:
 *
 * - removed_tool: the proposed lock drops it, because the source no longer
 *   offers it or tools.toml no longer imports it.
 * - new_required_input: the input schema requires a property it did not.
 * - narrowed_type: an input accepts fewer values, such as a smaller enum or
 *   a tighter type.
 * - removed_selected_field: the result no longer has a field that
 *   tools.toml's select names.
 */
export const BREAKING_REASONS = [
  "removed_tool",
  "new_required_input",
  "narrowed_type",
  "removed_selected_field",
] as const;
export type BreakingReason = (typeof BREAKING_REASONS)[number];

export interface BreakingChange {
  reason: BreakingReason;
  /** One line for the steering PR: "new required input: currency (string, ISO 4217)". */
  detail: string;
}

/** One side of the diff: a lock and the manifest entry compiled from it. */
export interface DiffSide {
  lock: McpToolsLock;
  server: ManifestServer;
}

export interface DiffInput {
  /** What the gateway serves now, from the production branch. */
  served: DiffSide;
  /** What the steering PR proposes. A tool the source no longer offers is absent from it. */
  proposed: DiffSide;
  /** Every tool the source offers now, imported or not. */
  offered: readonly UpstreamTool[];
}

/**
 * One line of the diff:
 *
 * - offered: the source has a tool nobody imported.
 * - added: a tool the proposed lock imports and the served one does not.
 * - changed: an imported tool whose upstream or definition changed.
 * - removed: an imported tool the proposed lock drops.
 */
export type ToolSurfaceDiffEntry =
  | {
      change: "offered";
      /** The upstream name: list_disputes. */
      upstream: string;
    }
  | {
      change: "added";
      /** The tools.toml key. */
      key: string;
      /** The full name: billing__list_disputes. */
      tool: string;
      version: number;
    }
  | {
      change: "changed";
      /** The tools.toml key. */
      key: string;
      /** The full name: billing__create_refund. */
      tool: string;
      /** The served version and the proposed one. They are equal when only the upstream changed. */
      version: { served: number; proposed: number };
      breaking: BreakingChange[];
      /** The upstream description, when it changed and tools.toml sets none, so the agent reads the new one. */
      description: { served: string | undefined; proposed: string | undefined } | undefined;
      /** Changes that break nothing: "response field data[].fee added (not in select, not returned)". */
      notes: string[];
    }
  | {
      change: "removed";
      key: string;
      tool: string;
      breaking: BreakingChange[];
      notes: string[];
    };

export interface ToolSurfaceDiff {
  server: string;
  entries: ToolSurfaceDiffEntry[];
  /** Definition tokens per request, served and proposed, against the server's definition_budget. */
  tokens: { served: number; proposed: number; budget: number };
  /** True when any entry is breaking. */
  breaking: boolean;
}

type LockedUpstream = LockedMcpTool | UpstreamTool;
type ChangedEntry = Extract<ToolSurfaceDiffEntry, { change: "changed" }>;

/** What each source's removal says when the source no longer offers the tool. */
const REMOVED_FROM = {
  mcp: "tool removed from tools/list",
  http: "operation removed from the document",
  graphql: "field removed from the schema",
  grpc: "method removed from the service definition",
} as const satisfies Record<RequestKind, string>;

/** Bounds that narrow an input when they rise. */
const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems"] as const;
/** Bounds that narrow an input when they fall. */
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems"] as const;

function byText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byText);
}

function lockedTools(lock: McpToolsLock): Record<string, LockedTool> {
  return lock.tools;
}

/** A lock's tools in key order. */
function lockedEntries(lock: McpToolsLock): Array<[string, LockedTool]> {
  return Object.entries(lockedTools(lock)).sort(([a], [b]) => byText(a, b));
}

function lockedTool(lock: McpToolsLock, key: string): LockedTool | undefined {
  const tools = lockedTools(lock);
  return Object.hasOwn(tools, key) ? tools[key] : undefined;
}

function manifestTool(side: DiffSide, which: string, key: string): ManifestTool {
  const tool = Object.hasOwn(side.server.tools, key) ? side.server.tools[key] : undefined;
  if (tool === undefined) throw new Error(`The ${which} lock pins ${key}, and the ${which} manifest has no such tool.`);
  return tool;
}

/**
 * The name tools.toml selects an upstream by: an MCP tool's own name, or an
 * operation, field, or method. A locked MCP tool keeps no request, and its
 * name is the one tools/list sent.
 */
function identityOf(upstream: LockedUpstream): string {
  if (!("request" in upstream)) return upstream.name;
  const { request } = upstream;
  switch (request.kind) {
    case "mcp":
      return request.tool;
    case "http":
      return request.operation;
    case "graphql":
      return request.field;
    case "grpc":
      return request.method;
  }
}

function kindOf(upstream: LockedUpstream): RequestKind {
  return "request" in upstream ? upstream.request.kind : "mcp";
}

function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalText(a) === canonicalText(b);
}

// ── Inputs ───────────────────────────────────────────────────────────────────

interface Findings {
  breaking: BreakingChange[];
  notes: string[];
}

function pathOf(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}.${name}`;
}

function typesOf(node: Record<string, unknown>): string[] | undefined {
  const { type } = node;
  if (typeof type === "string") return [type];
  if (!Array.isArray(type)) return undefined;
  const types = type.filter((item): item is string => typeof item === "string");
  return types.length > 0 ? types : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** "string, ISO 4217": the input's type and the first line of its description. */
function describeInput(node: unknown): string {
  if (!isRecord(node)) return "any";
  const type = typesOf(node)?.join(" | ") ?? "any";
  const line = typeof node.description === "string" ? node.description.split("\n")[0]?.trim() : undefined;
  return line === undefined || line === "" ? type : `${type}, ${line}`;
}

/** Every way the proposed input accepts fewer values than the served one. */
function narrowings(served: Record<string, unknown>, proposed: Record<string, unknown>, path: string): string[] {
  const found: string[] = [];

  const servedTypes = typesOf(served);
  const proposedTypes = typesOf(proposed);
  if (proposedTypes !== undefined) {
    const covered = (type: string): boolean =>
      proposedTypes.includes(type) || (type === "integer" && proposedTypes.includes("number"));
    if (servedTypes === undefined || !servedTypes.every(covered)) {
      found.push(`input ${path}: type ${servedTypes?.join(" | ") ?? "any"} → ${proposedTypes.join(" | ")}`);
    }
  }

  if (Array.isArray(proposed.enum)) {
    const accepted = proposed.enum.map(canonicalText);
    if (!Array.isArray(served.enum)) {
      found.push(`input ${path}: accepts only ${accepted.join(", ")}`);
    } else {
      const kept = new Set(accepted);
      const lost = served.enum.map(canonicalText).filter((value) => !kept.has(value));
      if (lost.length > 0) found.push(`input ${path}: no longer accepts ${lost.join(", ")}`);
    }
  }

  if (proposed.const !== undefined && !same(served.const, proposed.const)) {
    found.push(`input ${path}: accepts only ${canonicalText(proposed.const)}`);
  }

  for (const key of LOWER_BOUNDS) {
    const was = numberOf(served[key]);
    const now = numberOf(proposed[key]);
    if (now !== undefined && (was === undefined || now > was)) {
      found.push(`input ${path}: ${key} ${was ?? "none"} → ${now}`);
    }
  }
  for (const key of UPPER_BOUNDS) {
    const was = numberOf(served[key]);
    const now = numberOf(proposed[key]);
    if (now !== undefined && (was === undefined || now < was)) {
      found.push(`input ${path}: ${key} ${was ?? "none"} → ${now}`);
    }
  }

  const pattern = typeof proposed.pattern === "string" ? proposed.pattern : undefined;
  const servedPattern = typeof served.pattern === "string" ? served.pattern : undefined;
  if (pattern !== undefined && pattern !== servedPattern) {
    found.push(`input ${path}: pattern ${servedPattern ?? "none"} → ${pattern}`);
  }

  return found;
}

/** Required and present inputs of one object, then each input both sides share. */
function compareObject(
  served: Record<string, unknown>,
  proposed: Record<string, unknown>,
  prefix: string,
  findings: Findings,
): void {
  const servedProperties = propertiesOf(served);
  const proposedProperties = propertiesOf(proposed);
  const servedRequired = new Set(requiredOf(served));
  const proposedRequired = new Set(requiredOf(proposed));

  for (const name of sorted(proposedRequired)) {
    if (servedRequired.has(name)) continue;
    const path = pathOf(prefix, name);
    const detail = Object.hasOwn(servedProperties, name)
      ? `input ${path} is now required`
      : `new required input: ${path} (${describeInput(proposedProperties[name])})`;
    findings.breaking.push({ reason: "new_required_input", detail });
  }
  for (const name of sorted(Object.keys(proposedProperties))) {
    if (!Object.hasOwn(servedProperties, name) && !proposedRequired.has(name)) {
      findings.notes.push(`input ${pathOf(prefix, name)} added`);
    }
  }
  for (const name of sorted(Object.keys(servedProperties))) {
    const path = pathOf(prefix, name);
    if (Object.hasOwn(proposedProperties, name)) {
      compareNode(servedProperties[name], proposedProperties[name], path, findings);
    } else {
      findings.notes.push(`input ${path} removed`);
    }
  }
}

function compareNode(served: unknown, proposed: unknown, path: string, findings: Findings): void {
  if (!isRecord(served) || !isRecord(proposed)) return;
  for (const detail of narrowings(served, proposed, path)) findings.breaking.push({ reason: "narrowed_type", detail });
  compareObject(served, proposed, path, findings);
  if (isRecord(served.items) && isRecord(proposed.items)) {
    compareNode(served.items, proposed.items, `${path}[]`, findings);
  }
}

// ── Response fields ──────────────────────────────────────────────────────────

/** A result path's field names: data[].id is data, id. */
function stepsOf(path: string): string[] {
  return path.split(".").map((step) => (step.endsWith("[]") ? step.slice(0, -2) : step));
}

function startsWith(steps: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= steps.length && prefix.every((step, index) => steps[index] === step);
}

/**
 * True only when the schema shows the path is absent: some step's object
 * lists its properties and the step's name is not among them. A schema that
 * does not list properties could return anything, so it lacks nothing.
 */
function lacks(schema: unknown, path: string): boolean {
  let node = schema;
  for (const step of path.split(".")) {
    const array = step.endsWith("[]");
    const name = array ? step.slice(0, -2) : step;
    if (!isRecord(node) || !isRecord(node.properties)) return false;
    if (!Object.hasOwn(node.properties, name)) return true;
    node = node.properties[name];
    if (array) node = isRecord(node) ? node.items : undefined;
  }
  return false;
}

/** Every property path in a schema, with an array's items at name[].child. */
function fieldPaths(schema: unknown, prefix: string, into: Set<string>): Set<string> {
  if (!isRecord(schema)) return into;
  const properties = propertiesOf(schema);
  for (const name of Object.keys(properties)) {
    const path = pathOf(prefix, name);
    const node = properties[name];
    into.add(path);
    fieldPaths(node, path, into);
    if (isRecord(node)) fieldPaths(node.items, `${path}[]`, into);
  }
  return into;
}

/** The field a path sits in: data[].id sits in data. */
function parentOf(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const parent = path.slice(0, dot);
  return parent.endsWith("[]") ? parent.slice(0, -2) : parent;
}

/** The paths in one set and not the other, each only where its parent is not also listed. */
function topmost(from: ReadonlySet<string>, without: ReadonlySet<string>): string[] {
  const only = new Set([...from].filter((path) => !without.has(path)));
  return sorted([...only].filter((path) => !only.has(parentOf(path) ?? "")));
}

function compareOutputs(
  served: Record<string, unknown> | undefined,
  proposed: Record<string, unknown> | undefined,
  select: readonly string[],
  broken: readonly string[],
): string[] {
  if (served === undefined) return proposed === undefined ? [] : ["output schema added"];
  if (proposed === undefined) return ["output schema removed"];
  const servedPaths = fieldPaths(served, "", new Set());
  const proposedPaths = fieldPaths(proposed, "", new Set());
  const selected = select.map(stepsOf);
  const brokenSteps = broken.map(stepsOf);
  const notes: string[] = [];
  for (const path of topmost(proposedPaths, servedPaths)) {
    const steps = stepsOf(path);
    const returned =
      selected.length === 0 || selected.some((chosen) => startsWith(steps, chosen) || startsWith(chosen, steps));
    notes.push(`response field ${path} added${returned ? "" : " (not in select, not returned)"}`);
  }
  for (const path of topmost(servedPaths, proposedPaths)) {
    const steps = stepsOf(path);
    if (!brokenSteps.some((field) => startsWith(field, steps))) notes.push(`response field ${path} removed`);
  }
  return notes;
}

// ── Entries ──────────────────────────────────────────────────────────────────

function changedEntry(
  key: string,
  locks: { served: LockedTool; proposed: LockedTool },
  tools: { served: ManifestTool; proposed: ManifestTool },
): ChangedEntry | undefined {
  const upstreamChanged = locks.served.upstream_hash !== locks.proposed.upstream_hash;
  if (!upstreamChanged && locks.served.definition_hash === locks.proposed.definition_hash) return undefined;
  const servedUpstream = locks.served.upstream;
  const proposedUpstream = locks.proposed.upstream;

  const inputs: Findings = { breaking: [], notes: [] };
  compareObject(tools.served.definition.inputSchema, tools.proposed.definition.inputSchema, "", inputs);

  // A field select named on either side: a steering PR that drops a removed
  // field from select still breaks the agents that read it.
  const broken = sorted([...tools.served.shaping.select, ...tools.proposed.shaping.select]).filter(
    (path) => !lacks(servedUpstream.outputSchema, path) && lacks(proposedUpstream.outputSchema, path),
  );
  const breaking: BreakingChange[] = [
    ...inputs.breaking,
    ...broken.map((path): BreakingChange => ({
      reason: "removed_selected_field",
      detail: `selected response field removed: ${path}`,
    })),
  ];
  const notes = [
    ...sorted(inputs.notes),
    ...compareOutputs(
      servedUpstream.outputSchema,
      proposedUpstream.outputSchema,
      tools.proposed.shaping.select,
      broken,
    ),
  ];

  let description: ChangedEntry["description"];
  if (servedUpstream.description !== proposedUpstream.description) {
    if (tools.proposed.definition.description === proposedUpstream.description) {
      description = { served: servedUpstream.description, proposed: proposedUpstream.description };
    } else {
      notes.push("upstream description changed, and the tools.toml description is still served");
    }
  }

  if (breaking.length === 0 && notes.length === 0 && description === undefined) {
    const [label, before, after]: [string, Record<string, unknown>, Record<string, unknown>] = upstreamChanged
      ? ["upstream", servedUpstream, proposedUpstream]
      : ["definition", tools.served.definition, tools.proposed.definition];
    const keys = sorted([...Object.keys(before), ...Object.keys(after)]).filter(
      (name) => !same(before[name], after[name]),
    );
    notes.push(`${label} ${keys.join(", ")} changed`);
  }

  return {
    change: "changed",
    key,
    tool: tools.proposed.name,
    version: { served: locks.served.version, proposed: locks.proposed.version },
    breaking,
    description,
    notes,
  };
}

function checkServer({ served, proposed }: DiffInput): string {
  const names = [served.server.name, served.lock.server, proposed.server.name, proposed.lock.server];
  const distinct = sorted(names);
  if (distinct.length !== 1) {
    throw new Error(`diff compares one server, and its locks and manifests name ${distinct.join(" and ")}.`);
  }
  return served.server.name;
}

/** The tool surface diff between the served and proposed sides. */
export function diff(input: DiffInput): ToolSurfaceDiff {
  const server = checkServer(input);
  const { served, proposed } = input;

  const imported = new Set(Object.values(lockedTools(proposed.lock)).map((tool) => identityOf(tool.upstream)));
  const offeredNames = new Set(input.offered.map(identityOf));
  const offered = input.offered
    .filter((tool) => !imported.has(identityOf(tool)))
    .map((tool) => tool.name)
    .sort(byText)
    .map((upstream): ToolSurfaceDiffEntry => ({ change: "offered", upstream }));

  const added: ToolSurfaceDiffEntry[] = [];
  const changed: ToolSurfaceDiffEntry[] = [];
  for (const [key, locked] of lockedEntries(proposed.lock)) {
    const tool = manifestTool(proposed, "proposed", key);
    const before = lockedTool(served.lock, key);
    if (before === undefined) {
      added.push({ change: "added", key, tool: tool.name, version: locked.version });
      continue;
    }
    const entry = changedEntry(
      key,
      { served: before, proposed: locked },
      { served: manifestTool(served, "served", key), proposed: tool },
    );
    if (entry !== undefined) changed.push(entry);
  }

  const removed: ToolSurfaceDiffEntry[] = [];
  for (const [key, locked] of lockedEntries(served.lock)) {
    if (lockedTool(proposed.lock, key) !== undefined) continue;
    const detail = offeredNames.has(identityOf(locked.upstream))
      ? "removed from tools.toml"
      : REMOVED_FROM[kindOf(locked.upstream)];
    const { name } = manifestTool(served, "served", key);
    removed.push({ change: "removed", key, tool: name, breaking: [{ reason: "removed_tool", detail }], notes: [] });
  }

  const entries = [...offered, ...added, ...changed, ...removed];
  return {
    server,
    entries,
    tokens: {
      served: served.server.tokens.request,
      proposed: proposed.server.tokens.request,
      budget: proposed.server.exposure.definition_budget,
    },
    breaking: entries.some((entry) => "breaking" in entry && entry.breaking.length > 0),
  };
}
