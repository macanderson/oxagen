// shape.ts: what compile would serve for one tools.toml entry, read without
// compiling.
//
// compile throws at the first folder that cannot build, and exports none of
// these steps, so lint repeats them here: which upstream an entry selects, the
// inputSchema the agent sees, and the outputSchema select leaves. Keep each
// function in step with its twin in src/compile/index.ts. The definition
// budget test in tools.test.ts compares the two token counts on a fixture.
import { isRecord, propertiesOf, requiredOf, setRequired } from "../compile/json-schema";
import { effectiveAnnotations } from "../contract/classification";
import type { EffectiveDefinition } from "../contract/manifest";
import type { ServerSourceType } from "../contract/server";
import type { ToolsEntry } from "../contract/tools";
import type { RequestKind, UpstreamTool } from "../model/upstream-tool";

type ObjectSchema = UpstreamTool["inputSchema"];

/** The tools.toml key that selects an upstream, per request kind. */
export const SELECTORS = {
  mcp: "upstream",
  http: "operation",
  graphql: "field",
  grpc: "method",
} as const satisfies Record<RequestKind, keyof ToolsEntry>;

/** What a selector names, as a message says it. */
export const NOUNS = {
  mcp: "tool",
  http: "operation",
  graphql: "field",
  grpc: "method",
} as const satisfies Record<RequestKind, string>;

export function requestKindOf(source: ServerSourceType): RequestKind {
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
 * The inputSchema the agent sees: compile's shapeInput without its issues. A
 * name hide, fixed, defaults, or rename gets wrong is skipped here, and
 * compile reports it.
 */
export function shapedInput(entry: ToolsEntry, upstream: UpstreamTool): ObjectSchema {
  const original = upstream.inputSchema;
  const properties = propertiesOf(original);
  const removed = new Set([...(entry.hide ?? []), ...Object.keys(entry.fixed ?? {}), ...idempotencyInputs(entry, upstream)]);
  const defaults = Object.entries(entry.defaults ?? {});
  const rename = Object.entries(entry.rename ?? {});
  if (removed.size === 0 && defaults.length === 0 && rename.length === 0) return original;

  let shaped = Object.fromEntries(Object.entries(properties).filter(([name]) => !removed.has(name)));
  let required = requiredOf(original).filter((name) => !removed.has(name));
  for (const [name, value] of defaults) {
    if (!Object.hasOwn(shaped, name)) continue;
    const property = shaped[name];
    shaped[name] = { ...(isRecord(property) ? property : {}), default: value };
    required = required.filter((other) => other !== name);
  }
  const renamed = new Map(rename.filter(([from]) => Object.hasOwn(shaped, from)));
  if (renamed.size > 0) {
    shaped = Object.fromEntries(Object.entries(shaped).map(([name, schema]) => [renamed.get(name) ?? name, schema]));
    required = required.map((name) => renamed.get(name) ?? name);
  }
  const out: ObjectSchema = { ...original, properties: shaped };
  setRequired(out, required);
  return out;
}

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

/** The outputSchema compile serves: only the selected paths. */
export function servedOutput(outputSchema: ObjectSchema, select: readonly string[]): ObjectSchema {
  if (select.length === 0) return outputSchema;
  return trimObject(outputSchema, selectTree(select)) as ObjectSchema;
}

/** The tools/list entry compile would build for one tool, for its token count. */
export function effectiveDefinition(
  server: string,
  key: string,
  entry: ToolsEntry,
  upstream: UpstreamTool,
): EffectiveDefinition {
  const definition: EffectiveDefinition = {
    name: `${server}__${key}`,
    inputSchema: shapedInput(entry, upstream),
    annotations: effectiveAnnotations(entry),
  };
  if (upstream.title !== undefined) definition.title = upstream.title;
  const description = entry.description ?? upstream.description;
  if (description !== undefined) definition.description = description;
  if (upstream.outputSchema !== undefined) definition.outputSchema = servedOutput(upstream.outputSchema, entry.select ?? []);
  return definition;
}
