/**
 * Writes `policy/schema.cedarschema`, the Cedar schema every steering policy
 * is validated against and every request is checked against (lane S12).
 *
 * Oxagen writes the file on each publish from two sources: the workspace's
 * imported tools, read from the compiled tool manifest, and the built-in tool
 * vocabulary in `@oxagen/recorder/policy`. A person never edits it. The next
 * publish replaces it.
 *
 * The schema declares three entity types. An `Agent` is an operator, a
 * runtime, and a harness, in one `Workspace`. A `Target` is what a call acts
 * on, and every request names the one target `Target::"call"`. The context is
 * the agent policy spec's `Call` type plus `harness_tool` and `skill`.
 *
 * `context.args` holds every argument a rule can read, each optional, so a
 * rule tests an argument with `has` before it reads it. Every tool shares one
 * `Args` type while the tools agree on each argument's type. A tool whose
 * argument disagrees with an earlier tool's gets its own `Args_<n>` and
 * `Call_<n>`, so a rule over `amount` still validates for the tools that
 * agree.
 */
import type { CedarToolEntry } from "@oxagen/recorder";
import {
  BUILTIN_NAMES,
  CEDAR_ARG_TYPES,
  type CedarArgType,
  type CedarToolClass,
} from "@oxagen/recorder/policy";

/** Where the schema lives in the steering repo. */
export const SCHEMA_PATH = "policy/schema.cedarschema";

/**
 * The arguments of a built-in call, in the names the hook sends them
 * (`builtinArgSets` in `@oxagen/recorder/policy`).
 */
export const BUILTIN_ARG_TYPES: Readonly<Record<string, CedarArgType>> = {
  command: "String",
  path: "String",
  pattern: "String",
  query: "String",
  subagent: "String",
  url: "String",
};

/** The most arguments one tool carries into Cedar, as the signed bundle allows. */
export const MAX_TOOL_ARGS = 256;

/** One tool in `tool-manifest/v1`, in the fields the schema reads. */
export interface ManifestToolLike {
  /** The full name, `<server>__<tool>`, which is the Cedar action id. */
  name: string;
  version: number;
  definition: { inputSchema: Readonly<Record<string, unknown>> };
  classification: Pick<CedarToolClass, "risk" | "side_effect" | "egress"> & {
    impacts: readonly string[];
  };
}

/** The compiled tool manifest, `tool-manifest/v1`, in the fields the schema reads. */
export interface ToolManifestLike {
  servers: readonly {
    name: string;
    tools: Readonly<Record<string, ManifestToolLike>>;
  }[];
}

/** An argument, or a whole tool, that Cedar cannot read. */
export interface SkippedArg {
  action: string;
  /** Absent when the whole tool was skipped. */
  arg?: string;
  reason: string;
}

export interface CedarTools {
  /** Each imported tool by its action id, as the signed bundle carries it. */
  tools: Record<string, CedarToolEntry>;
  skipped: SkippedArg[];
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLong(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** The Cedar type of a set of literal values, when they all share one. */
function literalType(values: readonly unknown[]): CedarArgType | undefined {
  if (values.length === 0) return undefined;
  if (values.every((v) => typeof v === "string")) return "String";
  if (values.every(isLong)) return "Long";
  if (values.every((v) => typeof v === "boolean")) return "Bool";
  return undefined;
}

/** A JSON Schema `type`, with `"null"` dropped from a list. */
function declaredType(schema: Readonly<Record<string, unknown>>): string | undefined {
  const type = schema["type"];
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const rest = type.filter((t) => t !== "null");
    return rest.length === 1 && typeof rest[0] === "string" ? rest[0] : undefined;
  }
  return undefined;
}

/**
 * The Cedar type of one argument's JSON Schema, or why Cedar cannot hold it.
 * Cedar has no decimal, so a `number` is skipped. A rule over a whole number
 * reads an `integer` argument.
 */
export function argTypeOf(schema: unknown): CedarArgType | { reason: string } {
  if (!isObject(schema)) return { reason: "The argument has no JSON Schema." };
  const type = declaredType(schema);
  if (type === undefined) {
    const values = Array.isArray(schema["enum"])
      ? (schema["enum"] as unknown[])
      : "const" in schema
        ? [schema["const"]]
        : [];
    const literal = literalType(values);
    return literal ?? { reason: "The argument has no single JSON type." };
  }
  switch (type) {
    case "string":
      return "String";
    case "integer":
      return "Long";
    case "boolean":
      return "Bool";
    case "array": {
      const items = schema["items"];
      const item = isObject(items) ? declaredType(items) : undefined;
      if (item === "string") return "Set<String>";
      if (item === "integer") return "Set<Long>";
      return { reason: "Cedar reads a list of strings or whole numbers only." };
    }
    case "number":
      return { reason: "Cedar holds whole numbers only. Declare the argument an integer." };
    default:
      return { reason: `Cedar cannot read an argument of type ${type}.` };
  }
}

/**
 * The imported tools as the signed bundle carries them: each tool's
 * classification and the Cedar type of each argument a rule can read. An
 * argument Cedar cannot type is skipped, and a rule cannot read it.
 */
export function cedarTools(manifest: ToolManifestLike): CedarTools {
  const tools: Record<string, CedarToolEntry> = {};
  const skipped: SkippedArg[] = [];
  for (const server of manifest.servers) {
    for (const tool of Object.values(server.tools)) {
      const action = tool.name;
      if (action.startsWith("builtin__")) {
        skipped.push({ action, reason: "The builtin server name belongs to Oxagen's built-in tools." });
        continue;
      }
      const properties = tool.definition.inputSchema["properties"];
      const args: Record<string, CedarArgType> = {};
      const names = isObject(properties) ? Object.keys(properties).sort() : [];
      for (const name of names) {
        const type = argTypeOf((properties as Readonly<Record<string, unknown>>)[name]);
        if (typeof type !== "string") {
          skipped.push({ action, arg: name, reason: type.reason });
        } else if (Object.keys(args).length >= MAX_TOOL_ARGS) {
          skipped.push({ action, arg: name, reason: `Cedar reads the first ${MAX_TOOL_ARGS} arguments of a tool.` });
        } else {
          args[name] = type;
        }
      }
      tools[action] = {
        version: tool.version,
        risk: tool.classification.risk,
        side_effect: tool.classification.side_effect,
        egress: tool.classification.egress,
        impacts: [...tool.classification.impacts],
        args,
      };
    }
  }
  return { tools, skipped };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Words the schema writes quoted. Cedar reserves the first ten in policies.
 * The rest are schema keywords, quoted so no attribute name reads as one.
 */
const RESERVED = new Set([
  "true",
  "false",
  "if",
  "then",
  "else",
  "in",
  "is",
  "like",
  "has",
  "__cedar",
  "action",
  "appliesTo",
  "context",
  "entity",
  "enum",
  "namespace",
  "principal",
  "resource",
  "tags",
  "type",
]);

/** A Cedar string literal: the text quoted, with every special character escaped. */
export function cedarString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\0") out += "\\0";
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Whether a name can stand bare in Cedar, as an attribute name or after a dot. */
export function isCedarIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

function attrName(name: string): string {
  return isCedarIdentifier(name) ? name : cedarString(name);
}

function argsType(typeName: string, args: ReadonlyMap<string, CedarArgType>): string {
  const lines = [...args.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, type]) => `  ${attrName(name)}?: ${type}`);
  return `type ${typeName} = {\n${lines.join(",\n")}\n};`;
}

function callType(typeName: string, argsTypeName: string): string {
  return `type ${typeName} = {
  tool: Tool,
  args: ${argsTypeName},
  taint: { tainted: Bool, sources: Set<String> },
  time: { hour_utc: Long, weekday: Bool },
  rate: { calls_last_hour: Long, calls_last_minute: Long },
  run: { prior_calls: Set<String>, prior_reads: Set<String> },
  operator: { role: String },
  tier: String,
  budget: { remaining_cents: Long },
  mandate?: { remaining_cents: Long },
  approval: { granted: Bool, approvers: Long },
  harness_tool?: String,
  skill?: String
};`;
}

function actionBlock(actions: readonly string[], context: string): string {
  return `action ${actions.map(cedarString).join(",\n       ")}
  appliesTo {
    principal: Agent,
    resource: Target,
    context: ${context}
  };`;
}

function isArgType(type: string): type is CedarArgType {
  return (CEDAR_ARG_TYPES as readonly string[]).includes(type);
}

interface ArgGroup {
  args: Map<string, CedarArgType>;
  actions: string[];
}

/**
 * The shared group holds the built-in arguments and every tool that agrees
 * with it. Tools are placed in action order, so the same tools always give
 * the same schema.
 */
function argGroups(tools: Readonly<Record<string, CedarToolEntry>>): ArgGroup[] {
  const shared: ArgGroup = {
    args: new Map(Object.entries(BUILTIN_ARG_TYPES)),
    actions: BUILTIN_NAMES.map((n) => `builtin__${n}`),
  };
  const own: ArgGroup[] = [];
  for (const action of Object.keys(tools).sort()) {
    const entry = tools[action] as CedarToolEntry;
    const args = Object.entries(entry.args).filter(([, type]) => isArgType(type));
    const agrees = args.every(([name, type]) => (shared.args.get(name) ?? type) === type);
    if (agrees) {
      for (const [name, type] of args) shared.args.set(name, type);
      shared.actions.push(action);
    } else {
      own.push({ args: new Map(args), actions: [action] });
    }
  }
  return [shared, ...own];
}

const HEADER = `// Written by Oxagen on each publish, from the workspace's imported tools
// and the built-in tool vocabulary. Do not edit: the next publish replaces it.`;

const ENTITIES = `entity Workspace;

// An agent is an operator, a runtime, and a harness, in one workspace.
entity Agent in [Workspace] {
  operator: String,
  runtime: String,
  harness: String
};

// What a call acts on. Every request names Target::"call".
entity Target;

// The tool version, as the tool manifest classifies it.
type Tool = {
  name: String,
  version: Long,
  risk: String,
  side_effect: String,
  egress: String,
  impacts: Set<String>
};`;

/**
 * The text of `policy/schema.cedarschema` for the workspace's imported
 * tools, keyed by action id.
 */
export function writeCedarSchema(tools: Readonly<Record<string, CedarToolEntry>>): string {
  const groups = argGroups(tools);
  const parts = [HEADER, ENTITIES];
  groups.forEach((group, i) => {
    const suffix = i === 0 ? "" : `_${i}`;
    parts.push(
      i === 0
        ? `// Each argument a rule can read. Test it with has before reading it.\n${argsType("Args", group.args)}`
        : `// ${group.actions[0] ?? ""} types an argument differently from the tools above.\n${argsType(`Args${suffix}`, group.args)}`,
    );
    parts.push(callType(`Call${suffix}`, `Args${suffix}`));
    parts.push(actionBlock(group.actions, `Call${suffix}`));
  });
  return `${parts.join("\n\n")}\n`;
}
