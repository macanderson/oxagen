// compile: a server folder's effective tools (lane M4; mcp-studio-spec,
// Tools file, Risk classification, Tool names, and Large servers).
//
// compile() finds each tools.toml entry's upstream by upstream, operation,
// field, or method, and applies description, hide, fixed, defaults, rename,
// and a GraphQL selection. It derives annotations from the classification,
// never from the upstream, and prefixes names with toolName(). In search
// mode it adds <server>__search, __describe, and __call and keeps every
// imported tool behind them. It assigns no version: lock() does, and
// toManifestServer() joins the two.
//
// compile accepts a mutual_tls scheme only when every environment routes
// through a relay. The relay holds the client certificate and presents it in
// the TLS handshake, so a cloud or local route could never send it.
import { toolName } from "@oxagen/oxagen/steering-repo/names";
import { DEFAULT_SERVER_DEFINITION_BUDGET } from "@oxagen/oxagen/steering-repo/tokens";
import { effectiveAnnotations } from "../contract/classification";
import { definitionHash, definitionTokens } from "../contract/hashes";
import type { McpToolsLock } from "../contract/lock";
import {
  manifestServerSchema,
  SEARCH_MODE_TOOLS,
  type EffectiveDefinition,
  type ManifestEnvironment,
  type ManifestServer,
  type ManifestShaping,
  type ManifestTool,
} from "../contract/manifest";
import { agentEnvironment, AUTH_SCHEMES, type McpServer, type ServerSourceType } from "../contract/server";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_RESULT_BYTES,
  MAX_ITEMS_LIMIT,
  type McpTools,
  type ToolsEntry,
} from "../contract/tools";
import { builtinSecurityScheme, type SecurityScheme } from "../model/security-scheme";
import type { RequestKind, RequestTemplate, UpstreamTool } from "../model/upstream-tool";
import { isRecord, propertiesOf, requiredOf, setRequired } from "./json-schema";

export interface CompileInput {
  /** server.toml, parsed. */
  server: McpServer;
  /** tools.toml, parsed. */
  tools: McpTools;
  /** Every tool the source offers: an importer's result, or tools/list through upstreamFromMcpTool. */
  upstream: readonly UpstreamTool[];
  /**
   * OpenAPI's components.securitySchemes by name, from import or from the
   * lock's source. Empty for every other source, whose auth.scheme is
   * builtinSecurityScheme's.
   */
  security_schemes: Readonly<Record<string, SecurityScheme>>;
  /** gRPC only: the serialized FileDescriptorSet the importer returned. */
  descriptor_set: Uint8Array | undefined;
}

/** One tool as compile returns it: its manifest entry before the lock assigns a version, and the upstream it came from. */
export type CompiledTool = Omit<ManifestTool, "version" | "upstream_hash"> & {
  /** The UpstreamTool the entry was compiled from, which lock() pins. */
  upstream: UpstreamTool;
};

/** A server as compile returns it: the manifest entry without the lock's pins. */
export type CompiledServer = Omit<ManifestServer, "pinned" | "tools"> & {
  tools: Record<string, CompiledTool>;
};

/** One reason a server does not compile. */
export interface CompileIssue {
  /** The tools.toml key, or undefined for the server as a whole. */
  tool: string | undefined;
  /** The field at fault: operation, name, auth.scheme. */
  field: string | undefined;
  message: string;
}

/**
 * A server that does not compile: a tools.toml entry with no upstream, a name
 * collision, a name over 64 characters, or a scheme compile cannot apply.
 * issues lists every problem found, not only the first.
 */
export class CompileError extends Error {
  readonly issues: readonly CompileIssue[];

  constructor(issues: readonly CompileIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "CompileError";
    this.issues = issues;
  }
}

type ObjectSchema = UpstreamTool["inputSchema"];
type Issues = CompileIssue[];

// ── Upstream ─────────────────────────────────────────────────────────────────

/** The tools.toml key that selects an upstream, per request kind. */
const SELECTORS = {
  mcp: "upstream",
  http: "operation",
  graphql: "field",
  grpc: "method",
} as const satisfies Record<RequestKind, keyof ToolsEntry>;

function requestKindOf(source: ServerSourceType): RequestKind {
  switch (source) {
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

/** The name an upstream tool answers to under its selector. */
function selectedName(tool: UpstreamTool): string {
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

/** "an openapi source" or "a remote source", as a message names it. */
function aSource(type: ServerSourceType): string {
  return `${type === "openapi" ? "an" : "a"} ${type} source`;
}

function findUpstream(
  key: string,
  entry: ToolsEntry,
  sourceType: ServerSourceType,
  upstream: readonly UpstreamTool[],
  issues: Issues,
): UpstreamTool | undefined {
  const kind = requestKindOf(sourceType);
  const selector = SELECTORS[kind];
  const wrong = Object.values(SELECTORS).filter((field) => field !== selector && entry[field] !== undefined);
  for (const field of wrong) {
    issues.push({ tool: key, field, message: `${key}: ${field} does not apply to ${aSource(sourceType)}. Use ${selector}.` });
  }
  if (wrong.length > 0) return undefined;

  const name = kind === "mcp" ? (entry.upstream ?? key) : entry[selector];
  if (name === undefined) {
    issues.push({ tool: key, field: selector, message: `${key}: ${aSource(sourceType)} needs ${selector}.` });
    return undefined;
  }
  const found = upstream.find((tool) => tool.request.kind === kind && selectedName(tool) === name);
  if (found === undefined) {
    issues.push({ tool: key, field: selector, message: `${key}: the source offers no ${selector} ${name}.` });
  }
  return found;
}

// ── Input shaping ────────────────────────────────────────────────────────────

/** The inputs an idempotency header fills: header parameters of that name, in any case. */
function idempotencyInputs(entry: ToolsEntry, upstream: UpstreamTool): string[] {
  const header = entry.idempotency_header;
  if (header === undefined || upstream.request.kind !== "http") return [];
  const lower = header.toLowerCase();
  return upstream.request.parameters
    .filter((parameter) => parameter.in === "header" && parameter.name.toLowerCase() === lower)
    .map((parameter) => parameter.property);
}

/**
 * The inputSchema the agent sees. Hidden and fixed inputs and the
 * idempotency header leave it, defaults stop being required and carry their
 * default, and renamed inputs take their new names. The upstream schema comes
 * back unchanged when nothing applies.
 */
function shapeInput(key: string, entry: ToolsEntry, upstream: UpstreamTool, issues: Issues): ObjectSchema {
  const original = upstream.inputSchema;
  const properties = propertiesOf(original);
  const known = (name: string): boolean => Object.hasOwn(properties, name);

  const removed = new Set<string>();
  for (const [field, names] of [
    ["hide", entry.hide ?? []],
    ["fixed", Object.keys(entry.fixed ?? {})],
  ] as const) {
    for (const name of names) {
      if (!known(name)) {
        issues.push({ tool: key, field, message: `${key}: ${field} names ${name}, which is not an input of ${upstream.name}.` });
      }
      removed.add(name);
    }
  }
  for (const name of idempotencyInputs(entry, upstream)) removed.add(name);

  const defaults = Object.entries(entry.defaults ?? {});
  const rename = Object.entries(entry.rename ?? {});
  if (removed.size === 0 && defaults.length === 0 && rename.length === 0) return original;

  let shaped = Object.fromEntries(Object.entries(properties).filter(([name]) => !removed.has(name)));
  let required = requiredOf(original).filter((name) => !removed.has(name));

  /** True when field may shape name: the agent still sends it. */
  const usable = (field: "defaults" | "rename", name: string): boolean => {
    if (removed.has(name)) {
      issues.push({ tool: key, field, message: `${key}: ${field} names ${name}, which hide or fixed takes out of the input.` });
      return false;
    }
    if (!known(name)) {
      issues.push({ tool: key, field, message: `${key}: ${field} names ${name}, which is not an input of ${upstream.name}.` });
      return false;
    }
    return true;
  };

  for (const [name, value] of defaults) {
    if (!usable("defaults", name)) continue;
    const property = shaped[name];
    shaped[name] = { ...(isRecord(property) ? property : {}), default: value };
    required = required.filter((other) => other !== name);
  }

  const renamed = new Map<string, string>();
  for (const [from, to] of rename) {
    if (usable("rename", from)) renamed.set(from, to);
  }
  if (renamed.size > 0) {
    const owners = new Map<string, string>();
    for (const name of Object.keys(shaped)) {
      const final = renamed.get(name) ?? name;
      const owner = owners.get(final);
      if (owner === undefined) owners.set(final, name);
      else {
        issues.push({
          tool: key,
          field: "rename",
          message: `${key}: rename gives ${owner} and ${name} one name, ${final}.`,
        });
      }
    }
    shaped = Object.fromEntries(Object.entries(shaped).map(([name, schema]) => [renamed.get(name) ?? name, schema]));
    required = required.map((name) => renamed.get(name) ?? name);
  }

  const out: ObjectSchema = { ...original, properties: shaped };
  setRequired(out, required);
  return out;
}

// ── Result shaping ───────────────────────────────────────────────────────────

/** One field of a select tree: kept whole, or cut to its children. */
interface SelectNode {
  whole: boolean;
  /** The path steps into the array's items: data[] in data[].id. */
  array: boolean;
  children: Map<string, SelectNode>;
}

function selectTree(paths: readonly string[]): Map<string, SelectNode> {
  const root = new Map<string, SelectNode>();
  for (const path of paths) {
    let level = root;
    const steps = path.split(".");
    steps.forEach((step, index) => {
      const array = step.endsWith("[]");
      const name = array ? step.slice(0, -2) : step;
      const node = level.get(name) ?? { whole: false, array: false, children: new Map<string, SelectNode>() };
      node.array ||= array;
      if (index === steps.length - 1) node.whole = true;
      level.set(name, node);
      level = node.children;
    });
  }
  return root;
}

/** An object schema cut to the selected properties. A schema with no properties stays whole. */
function trimObject(schema: Record<string, unknown>, children: Map<string, SelectNode>): Record<string, unknown> {
  if (!isRecord(schema.properties)) return schema;
  const properties = schema.properties;
  const kept: Record<string, unknown> = {};
  for (const [name, node] of children) {
    if (Object.hasOwn(properties, name)) kept[name] = trimNode(properties[name], node);
  }
  const out: Record<string, unknown> = { ...schema, properties: kept };
  setRequired(
    out,
    requiredOf(schema).filter((name) => Object.hasOwn(kept, name)),
  );
  return out;
}

function trimNode(schema: unknown, node: SelectNode): unknown {
  if (node.whole || !isRecord(schema)) return schema;
  if (!node.array) return trimObject(schema, node.children);
  return isRecord(schema.items) ? { ...schema, items: trimObject(schema.items, node.children) } : schema;
}

/** The served outputSchema: only the selected paths, so structuredContent still matches it. */
function selectOutput(outputSchema: ObjectSchema, select: readonly string[]): ObjectSchema {
  if (select.length === 0) return outputSchema;
  return trimObject(outputSchema, selectTree(select)) as ObjectSchema;
}

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * Why a GraphQL selection set cannot be sent, or undefined. This checks the
 * brackets and strings only: the server checks the fields.
 */
function selectionProblem(selection: string): string | undefined {
  const open: string[] = [];
  let quoted = false;
  for (let index = 0; index < selection.length; index += 1) {
    const char = selection[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "(") open.push(char);
    else if (char === "}" || char === ")") {
      const expected = char === "}" ? "{" : "(";
      if (open.pop() !== expected) return `selection has an unmatched ${char} at character ${index + 1}.`;
    }
  }
  if (quoted) return "selection has a string with no closing quote.";
  const unclosed = open.pop();
  if (unclosed !== undefined) return `selection has an unclosed ${unclosed}.`;
  if (!/[_A-Za-z]/.test(selection)) return "selection names no field.";
  return undefined;
}

/** The request template, with tools.toml's GraphQL selection in place of the generated one. */
function shapeRequest(key: string, entry: ToolsEntry, upstream: UpstreamTool, issues: Issues): RequestTemplate {
  const request = upstream.request;
  if (entry.selection === undefined || request.kind !== "graphql") return request;
  const problem = selectionProblem(entry.selection);
  if (problem !== undefined) issues.push({ tool: key, field: "selection", message: `${key}: ${problem}` });
  return { ...request, selection: entry.selection };
}

// ── Tools ────────────────────────────────────────────────────────────────────

function compileTool(input: CompileInput, key: string, entry: ToolsEntry, issues: Issues): CompiledTool | undefined {
  const { server, tools } = input;
  if (server.exposure.mode === "search" && (SEARCH_MODE_TOOLS as readonly string[]).includes(key)) {
    issues.push({
      tool: key,
      field: "name",
      message: `${key}: ${server.name}__${key} names two tools. ${key} is reserved when the exposure mode is search.`,
    });
    return undefined;
  }
  let name: string;
  try {
    name = toolName(server.name, key);
  } catch (error) {
    issues.push({ tool: key, field: "name", message: `${key}: ${(error as Error).message}` });
    return undefined;
  }
  const upstream = findUpstream(key, entry, server.source.type, input.upstream, issues);
  if (upstream === undefined) return undefined;

  const definition: EffectiveDefinition = {
    name,
    inputSchema: shapeInput(key, entry, upstream, issues),
    annotations: effectiveAnnotations(entry),
  };
  if (upstream.title !== undefined) definition.title = upstream.title;
  const description = entry.description ?? upstream.description;
  if (description !== undefined) definition.description = description;
  if (upstream.outputSchema !== undefined) definition.outputSchema = selectOutput(upstream.outputSchema, entry.select ?? []);

  const shaping: ManifestShaping = {
    hide: entry.hide ?? [],
    fixed: entry.fixed ?? {},
    defaults: entry.defaults ?? {},
    rename: entry.rename ?? {},
    select: entry.select ?? [],
    redact: entry.redact ?? [],
    max_result_bytes: entry.max_result_bytes ?? tools.defaults?.max_result_bytes ?? DEFAULT_MAX_RESULT_BYTES,
    deadline_ms: entry.deadline_ms ?? DEFAULT_DEADLINE_MS,
  };
  const streams = upstream.request.kind === "grpc" && upstream.request.streaming === "server";
  if (entry.paginate !== undefined) {
    const style = upstream.paging?.style;
    if (style !== entry.paginate) {
      issues.push({
        tool: key,
        field: "paginate",
        message:
          style === undefined
            ? `${key}: paginate is ${entry.paginate}, and ${upstream.name} has no paging pattern.`
            : `${key}: paginate is ${entry.paginate}, and ${upstream.name} pages by ${style}.`,
      });
    }
    shaping.paginate = entry.paginate;
    shaping.max_items = entry.max_items ?? MAX_ITEMS_LIMIT;
  } else if (streams) {
    shaping.max_items = entry.max_items ?? MAX_ITEMS_LIMIT;
  } else if (entry.max_items !== undefined) {
    issues.push({
      tool: key,
      field: "max_items",
      message: `${key}: max_items caps auto paging or a gRPC server stream, and ${upstream.name} has neither.`,
    });
  }
  if (entry.idempotency_header !== undefined) shaping.idempotency_header = entry.idempotency_header;

  const tool: CompiledTool = {
    name,
    definition_hash: definitionHash(definition),
    definition,
    tokens: definitionTokens(definition),
    classification: {
      risk: entry.risk,
      side_effect: entry.side_effect,
      egress: entry.egress,
      impacts: entry.impacts ?? [],
      measures: entry.measures ?? {},
      data_classes: entry.data_classes ?? [],
    },
    shaping,
    request: shapeRequest(key, entry, upstream, issues),
    upstream,
  };
  if (upstream.paging !== undefined) tool.paging = upstream.paging;
  if (upstream.deprecated === true) tool.deprecated = true;
  return tool;
}

// ── Search mode ──────────────────────────────────────────────────────────────

/** The three tools a search-mode server shows in place of its imported ones. */
function searchDefinitions(server: McpServer, tools: readonly CompiledTool[]): EffectiveDefinition[] {
  const lookup = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const toolInput = { type: "string", description: "The tool's name, as search returns it: create_refund." };
  return [
    {
      name: toolName(server.name, "search"),
      description: `Search the ${server.label} tools you may call. Returns up to 10, one line each.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What the tool should do." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "How many tools to return. 10 by default." },
        },
        required: ["query"],
      },
      annotations: lookup,
    },
    {
      name: toolName(server.name, "describe"),
      description: `One ${server.label} tool's description and input schema.`,
      inputSchema: { type: "object", properties: { tool: toolInput }, required: ["tool"] },
      annotations: lookup,
    },
    {
      name: toolName(server.name, "call"),
      description: `Call one ${server.label} tool. Call describe first for its input schema.`,
      inputSchema: {
        type: "object",
        properties: {
          tool: toolInput,
          arguments: { type: "object", description: "The tool's input, as describe's schema gives it." },
        },
        required: ["tool", "arguments"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: tools.some((tool) => tool.definition.annotations.destructiveHint),
        openWorldHint: tools.some((tool) => tool.definition.annotations.openWorldHint),
      },
    },
  ];
}

// ── Server ───────────────────────────────────────────────────────────────────

/** True when the local gateway runs the server: a local source, or a registry package on machines. */
function runsLocally(server: McpServer): boolean {
  const source = server.source;
  return source.type === "local" || (source.type === "registry" && source.machines !== undefined);
}

function resolveEnvironments(server: McpServer, issues: Issues): Record<string, ManifestEnvironment> {
  if (runsLocally(server)) return { default: { sandbox: true, network: "local" } };
  let sandbox: string;
  try {
    sandbox = agentEnvironment(server);
  } catch (error) {
    issues.push({ tool: undefined, field: "environments", message: (error as Error).message });
    return {};
  }
  const source = server.source;
  // Only a remote source's url is an endpoint. A definition source's url is
  // where the document is fetched, so its environments name the endpoint.
  const sourceUrl = source.type === "remote" ? source.url : undefined;
  const sourceNetwork = "network" in source ? source.network : undefined;
  const out: Record<string, ManifestEnvironment> = {};
  for (const [name, env] of Object.entries(server.environments ?? { [sandbox]: {} })) {
    const resolved: ManifestEnvironment = { sandbox: name === sandbox, network: env.network ?? sourceNetwork ?? "cloud" };
    const url = env.url ?? sourceUrl;
    if (url !== undefined) resolved.url = url;
    // Mode none sends no credential, even one an environment names.
    const credential = server.auth?.mode === "none" ? undefined : (env.credential ?? server.auth?.credential);
    if (credential !== undefined) resolved.credential = credential;
    out[name] = resolved;
  }
  return out;
}

function resolveAuth(
  input: CompileInput,
  environments: Record<string, ManifestEnvironment>,
  issues: Issues,
): ManifestServer["auth"] {
  const declared = input.server.auth;
  if (declared === undefined || declared.mode === "none" || declared.scheme === undefined) return null;
  const mode = declared.mode;
  const scheme = declared.scheme;
  const fail = (message: string): null => {
    issues.push({ tool: undefined, field: "auth.scheme", message });
    return null;
  };

  let apply: SecurityScheme | undefined;
  if (input.server.source.type === "openapi") {
    apply = Object.hasOwn(input.security_schemes, scheme) ? input.security_schemes[scheme] : undefined;
    if (apply === undefined) return fail(`auth.scheme ${scheme} is not a security scheme the OpenAPI document declares.`);
  } else {
    if (!(AUTH_SCHEMES as readonly string[]).includes(scheme)) {
      return fail(`auth.scheme ${scheme} is not one of ${AUTH_SCHEMES.join(", ")}.`);
    }
    try {
      apply = builtinSecurityScheme(scheme as (typeof AUTH_SCHEMES)[number], declared.header);
    } catch (error) {
      return fail((error as Error).message);
    }
  }
  if (apply.type === "mutual_tls") {
    // Only a relay holds the client certificate, so every route must be one.
    const offRelay = Object.entries(environments).filter(([, env]) => !env.network.startsWith("relay:"));
    if (offRelay.length > 0) {
      const routes = offRelay.map(([name, env]) => `Environment ${name} routes over ${env.network}.`).join(" ");
      return fail(
        `auth.scheme ${scheme} is mutual TLS, which only a relay that holds the client certificate can present. ${routes} Set each environment's network to relay:<name>.`,
      );
    }
  }
  return { mode, scheme, apply };
}

/** The effective tools of one server folder. Throws CompileError. */
export function compile(input: CompileInput): CompiledServer {
  const { server } = input;
  const issues: Issues = [];

  const tools: Record<string, CompiledTool> = {};
  for (const [key, entry] of Object.entries(input.tools.tools ?? {})) {
    const tool = compileTool(input, key, entry, issues);
    if (tool !== undefined) tools[key] = tool;
  }
  const environments = resolveEnvironments(server, issues);
  const auth = resolveAuth(input, environments, issues);

  let descriptorSet: string | undefined;
  if (server.source.type === "grpc") {
    if (input.descriptor_set === undefined) {
      issues.push({
        tool: undefined,
        field: "descriptor_set",
        message: "A gRPC server needs the FileDescriptorSet its import returned.",
      });
    } else {
      descriptorSet = Buffer.from(input.descriptor_set).toString("base64");
    }
  }
  if (issues.length > 0) throw new CompileError(issues);

  const compiled = Object.values(tools);
  const definitions = compiled.reduce((sum, tool) => sum + tool.tokens, 0);
  const search = server.exposure.mode === "search" ? searchDefinitions(server, compiled) : null;
  const request = search === null ? definitions : search.reduce((sum, definition) => sum + definitionTokens(definition), 0);

  const out: CompiledServer = {
    name: server.name,
    label: server.label,
    description: server.description,
    source: server.source,
    auth,
    environments,
    exposure: {
      mode: server.exposure.mode,
      definition_budget: server.exposure.definition_budget ?? DEFAULT_SERVER_DEFINITION_BUDGET,
    },
    tokens: { definitions, request },
    search,
    tools,
  };
  if (descriptorSet !== undefined) out.descriptor_set = descriptorSet;
  return out;
}

/**
 * Each environment's url, from a registry lock whose entry names a remote
 * server. server.toml names no url for one: the catalog entry does.
 */
function withLockedUrl(
  environments: CompiledServer["environments"],
  source: McpToolsLock["source"],
): CompiledServer["environments"] {
  if (source.type !== "registry" || source.url === undefined) return environments;
  const url = source.url;
  return Object.fromEntries(
    Object.entries(environments).map(([name, env]) => [name, env.url === undefined ? { ...env, url } : env]),
  );
}

/**
 * The manifest entry for a compiled server and the lock written for it: each
 * tool takes its version and upstream_hash from the lock, and pinned is the
 * lock's source. Throws when the lock does not cover every compiled tool.
 */
export function toManifestServer(compiled: CompiledServer, lock: McpToolsLock): ManifestServer {
  if (lock.server !== compiled.name) {
    throw new Error(`The lock is for ${lock.server}, and the compiled server is ${compiled.name}.`);
  }
  const tools: Record<string, ManifestTool> = {};
  for (const [key, { upstream: _upstream, ...tool }] of Object.entries(compiled.tools)) {
    const locked = Object.hasOwn(lock.tools, key) ? lock.tools[key] : undefined;
    if (locked === undefined) throw new Error(`The lock for ${compiled.name} has no entry for ${key}. Run lock again.`);
    if (locked.definition_hash !== tool.definition_hash) {
      throw new Error(`The lock's definition_hash for ${key} is not the compiled one. Run lock again.`);
    }
    tools[key] = { ...tool, version: locked.version, upstream_hash: locked.upstream_hash };
  }
  const { tools: _compiledTools, ...server } = compiled;
  return manifestServerSchema.parse({
    ...server,
    environments: withLockedUrl(compiled.environments, lock.source),
    pinned: lock.source,
    tools,
  } satisfies ManifestServer);
}
