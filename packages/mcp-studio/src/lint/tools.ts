// tools.ts: the checks on each [tools.<key>] table in tools.toml, and on the
// definition budget the imported tools add up to.
//
// Most checks read the upstream tool an entry selects from what the source
// offers now, shaped the way compile would serve it (shape.ts). When the
// source no longer offers it, tool_not_offered reports the entry and the
// checks that need the upstream skip it.
import { toolEgressClassSchema, toolRiskGradeSchema, toolSideEffectClassSchema } from "@oxagen/oxagen/contracts/tool.classification";
import {
  SERVER_NAME_PATTERN,
  TOOL_KEY_PATTERN,
  TOOL_NAME_MAX,
  TOOL_SEPARATOR,
} from "@oxagen/oxagen/steering-repo/names";
import { DEFAULT_SERVER_DEFINITION_BUDGET } from "@oxagen/oxagen/steering-repo/tokens";
import { isRecord, propertiesOf } from "../compile/json-schema";
import { definitionTokens } from "../contract/hashes";
import { SEARCH_MODE_TOOLS } from "../contract/manifest";
import type { ServerSourceType } from "../contract/server";
import { TOOL_DESCRIPTION_MAX, type ToolsEntry } from "../contract/tools";
import type { UpstreamTool } from "../model/upstream-tool";
import type { LintContext, ServerFolder } from "./index";
import { andList, count, orList, type Report } from "./report";
import { distinguishable, selectionDepth, walkSchemas } from "./schema";
import { effectiveDefinition, NOUNS, requestKindOf, SELECTORS, selectedName, servedOutput, shapedInput } from "./shape";

/** The three classification fields, each with the values it takes. */
const CLASSIFICATION = [
  ["risk", toolRiskGradeSchema.options],
  ["side_effect", toolSideEffectClassSchema.options],
  ["egress", toolEgressClassSchema.options],
] as const;

/** Past this many inputs, models fill the form poorly. */
const MANY_INPUTS = 20;
/** Past this many values, an enum costs more than a lookup tool. */
const LARGE_ENUM = 50;
/** Past this many levels, a GraphQL selection makes large results and slow queries. */
const DEEP_SELECTION = 3;
/** GraphQL argument names that page a list, lowercased. */
const PAGE_ARGUMENTS = new Set([
  "first",
  "last",
  "after",
  "before",
  "limit",
  "offset",
  "page",
  "skip",
  "take",
  "cursor",
  "page_size",
  "pagesize",
  "per_page",
  "perpage",
]);
/** The note openapi import leaves when it cuts a schema that refers to itself. */
const RECURSIVE_NOTE = /^Import cut the recursive schema (\S+) at depth (\d+)\.$/;

/** "an operation" or "a field": a selector's noun with its article. */
function aNoun(noun: string): string {
  return `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
}

/** "an openapi source" or "a graphql source", as a message names it. */
function aSource(type: ServerSourceType): string {
  return `${aNoun(type)} source`;
}

function quoted(values: readonly string[]): string {
  return orList(values.map((value) => JSON.stringify(value)));
}

function isArraySchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  return schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"));
}

export function lintTools(folder: ServerFolder, context: LintContext, report: Report): void {
  const { server } = folder;
  let imported = 0;
  let tokens = 0;
  for (const [key, entry] of Object.entries(folder.tools.tools ?? {})) {
    lintClassification(key, entry, report);
    const upstream = findUpstream(folder, key, entry, report);
    const description = descriptionOf(entry, upstream);
    if (description?.trim() === "") {
      report("no_description", {
        tool: key,
        field: "description",
        message: `${key} has no description, and the model picks a tool by its description.`,
        fix: `Set description in [tools.${key}] to what the tool does and when to call it.`,
      });
    }
    lintName(folder, key, report);
    if (description !== undefined) lintLength(key, entry, description, report);
    if (upstream !== undefined) {
      lintUpstream(folder, context, key, entry, upstream, report);
      imported += 1;
      tokens += definitionTokens(effectiveDefinition(server.name, key, entry, upstream));
    }
  }

  const budget = server.exposure.definition_budget ?? DEFAULT_SERVER_DEFINITION_BUDGET;
  if (server.exposure.mode === "direct" && tokens > budget) {
    report("over_definition_budget", {
      tool: undefined,
      field: "exposure.mode",
      message: `${imported === 1 ? "The one imported tool costs" : `The ${imported} imported tools cost`} about ${count(tokens)} tokens on every request, over the definition_budget of ${count(budget)}.`,
      fix: `Set exposure.mode = "search" in server.toml, so each request lists ${SEARCH_MODE_TOOLS.length} tools (${andList([...SEARCH_MODE_TOOLS])}) in place of ${imported}.`,
    });
  }
}

function lintClassification(key: string, entry: ToolsEntry, report: Report): void {
  for (const [field, options] of CLASSIFICATION) {
    const value: unknown = entry[field];
    if (typeof value === "string" && (options as readonly string[]).includes(value)) continue;
    report("missing_classification", {
      tool: key,
      field,
      message:
        value === undefined
          ? `${key} has no ${field}, and Oxagen decides each call from risk, side_effect, and egress.`
          : `${key} sets ${field} to ${JSON.stringify(value)}, which is not a ${field} Oxagen knows.`,
      fix: `Set ${field} in [tools.${key}] to ${quoted(options)}.`,
    });
  }
}

/** The upstream tool an entry selects, as compile finds it, or undefined after a finding. */
function findUpstream(folder: ServerFolder, key: string, entry: ToolsEntry, report: Report): UpstreamTool | undefined {
  const type = folder.server.source.type;
  const kind = requestKindOf(type);
  const selector = SELECTORS[kind];
  const noun = NOUNS[kind];
  const wrong = Object.values(SELECTORS).filter((field) => field !== selector && entry[field] !== undefined);
  for (const field of wrong) {
    report("tool_not_offered", {
      tool: key,
      field,
      message: `${key} sets ${field}, which ${aSource(type)} does not read, so the entry selects no ${noun}.`,
      fix: `Replace ${field} with ${selector} in [tools.${key}].`,
    });
  }
  if (wrong.length > 0) return undefined;

  const name = kind === "mcp" ? (entry.upstream ?? key) : entry[selector];
  if (name === undefined) {
    report("tool_not_offered", {
      tool: key,
      field: selector,
      message: `${key} does not say which ${noun} it imports.`,
      fix: `Set ${selector} in [tools.${key}] to the ${noun} it imports.`,
    });
    return undefined;
  }
  const found = folder.offered.find((tool) => tool.request.kind === kind && selectedName(tool) === name);
  if (found === undefined) {
    report("tool_not_offered", {
      tool: key,
      field: selector,
      message: `${key} imports ${noun} ${name}, and the source no longer offers it.`,
      fix: `Remove [tools.${key}] from tools.toml, or set ${selector} to ${aNoun(noun)} the source offers.`,
    });
  }
  return found;
}

/**
 * The description the model sees, "" when neither tools.toml nor the source
 * gives one, or undefined when only the missing upstream could say.
 */
function descriptionOf(entry: ToolsEntry, upstream: UpstreamTool | undefined): string | undefined {
  if (entry.description !== undefined) return entry.description;
  return upstream === undefined ? undefined : (upstream.description ?? "");
}

function lintLength(key: string, entry: ToolsEntry, description: string, report: Report): void {
  // Import cuts a source's description at 1,024 characters, or 1,023 when the
  // cut would split a surrogate pair, so a source's text at the cut ran long.
  const own = entry.description !== undefined;
  const long = own ? description.length > TOOL_DESCRIPTION_MAX : description.length >= TOOL_DESCRIPTION_MAX - 1;
  if (!long) return;
  report("long_description", {
    tool: key,
    field: "description",
    message: own
      ? `${key}'s description is ${count(description.length)} characters, over the ${count(TOOL_DESCRIPTION_MAX)} a description may be, and every request pays for it.`
      : `The source's description of ${key} is ${count(description.length)} characters, at the ${count(TOOL_DESCRIPTION_MAX)} import cuts a description to, and every request pays for it.`,
    fix: `Set description in [tools.${key}] to a summary under ${count(TOOL_DESCRIPTION_MAX)} characters.`,
  });
}

function lintName(folder: ServerFolder, key: string, report: Report): void {
  const server = folder.server.name;
  const name = `${server}${TOOL_SEPARATOR}${key}`;
  if (!TOOL_KEY_PATTERN.test(key)) {
    report("invalid_name", {
      tool: key,
      field: "name",
      message: `${JSON.stringify(key)} is not a tool key, so model APIs would reject ${name}.`,
      fix: `Rename [tools.${key}] to lowercase letters, digits, and underscores, starting with a letter.`,
    });
    return;
  }
  if (folder.server.exposure.mode === "search" && (SEARCH_MODE_TOOLS as readonly string[]).includes(key)) {
    report("invalid_name", {
      tool: key,
      field: "name",
      message: `${name} names two tools, because search mode serves its own ${name}.`,
      fix: `Rename [tools.${key}] to a key other than ${orList([...SEARCH_MODE_TOOLS])}.`,
    });
  }
  // lintServer reports a bad server name, which breaks every tool's name at once.
  if (SERVER_NAME_PATTERN.test(server) && name.length > TOOL_NAME_MAX) {
    const room = TOOL_NAME_MAX - server.length - TOOL_SEPARATOR.length;
    report("invalid_name", {
      tool: key,
      field: "name",
      message: `${name} is ${count(name.length)} characters, and model APIs reject a tool name over ${TOOL_NAME_MAX}.`,
      fix: `Rename [tools.${key}] to at most ${room} characters.`,
    });
  }
}

/** The checks that read the upstream tool, in the Tool checks table's order. */
function lintUpstream(
  folder: ServerFolder,
  context: LintContext,
  key: string,
  entry: ToolsEntry,
  upstream: UpstreamTool,
  report: Report,
): void {
  const input = shapedInput(entry, upstream);
  const output = upstream.outputSchema === undefined ? undefined : servedOutput(upstream.outputSchema, entry.select ?? []);

  const inputs = Object.keys(propertiesOf(input)).length;
  if (inputs > MANY_INPUTS) {
    report("many_inputs", {
      tool: key,
      field: "inputSchema.properties",
      message: `${key} takes ${inputs} inputs, and models fill a form of more than ${MANY_INPUTS} poorly.`,
      fix: `Remove inputs the agent never sets with hide or fixed in [tools.${key}], until at most ${MANY_INPUTS} remain.`,
    });
  }

  walkSchemas(input, "inputSchema", (node, at) => {
    if (!Array.isArray(node.enum) || node.enum.length <= LARGE_ENUM) return;
    report("large_enum", {
      tool: key,
      field: `${at}.enum`,
      message: `${at} lists ${node.enum.length} values, and every request pays for each one.`,
      fix: `Hide the input or fix its value in [tools.${key}], or import a tool that looks the values up.`,
    });
  });

  if (entry.side_effect === "irreversible" && context.accepted_unchanged.has(key)) {
    report("irreversible_suggestion_unreviewed", {
      tool: key,
      field: "side_effect",
      message: `${key} is irreversible, and its suggested classification was accepted without a change.`,
      fix: `Review risk, side_effect, egress, and impacts in [tools.${key}] before the steering PR merges.`,
    });
  }

  if (output === undefined) {
    report("no_output_schema", {
      tool: key,
      field: "outputSchema",
      message: `${key} has no JSON schema for its 2xx response, so the model gets its result as text only.`,
      fix: "Add a JSON schema to the operation's 2xx response in the OpenAPI document, then sync.",
    });
  }

  const { request } = upstream;
  if (
    request.kind === "http" &&
    request.response?.wrap === "items" &&
    upstream.paging === undefined &&
    (entry.select ?? []).length === 0
  ) {
    report("unbounded_array", {
      tool: key,
      field: "select",
      message: `${key} returns an array with no paging, so one result can fill the context.`,
      fix: `Keep only the fields the agent needs with select in [tools.${key}], such as items[].id, and cap the result with max_result_bytes.`,
    });
  }

  const oneOf = (node: Record<string, unknown>, at: string): void => {
    if (!Array.isArray(node.oneOf) || isRecord(node.discriminator) || distinguishable(node.oneOf)) return;
    report("undiscriminated_one_of", {
      tool: key,
      field: `${at}.oneOf`,
      message: `${at} is a oneOf of ${node.oneOf.length} branches with no discriminator, so the model guesses the branch.`,
      fix: "Give each branch a property with its own const value, such as type, in the OpenAPI document, then sync.",
    });
  };
  walkSchemas(input, "inputSchema", oneOf);
  walkSchemas(output, "outputSchema", oneOf);

  const kind = request.kind;
  const selector = SELECTORS[kind];
  const selected = selectedName(upstream);
  if (upstream.deprecated === true) {
    report("deprecated_imported", {
      tool: key,
      field: selector,
      message: `${key} imports ${NOUNS[kind]} ${selected}, which the source marks deprecated, so it may go away.`,
      fix: `Import the ${NOUNS[kind]} that replaces ${selected}, or remove [tools.${key}].`,
    });
  }

  for (const note of folder.notes) {
    const cut = note.tool === upstream.name ? RECURSIVE_NOTE.exec(note.message) : null;
    const schema = cut?.[1];
    const depth = cut?.[2];
    if (schema === undefined || depth === undefined) continue;
    report("recursive_schema", {
      tool: key,
      field: undefined,
      message: `${key} holds ${schema}, a schema that refers to itself, and import cut it at depth ${depth}.`,
      fix: `No change is required. The model sees ${schema} to depth ${depth} and a stub below it.`,
    });
  }

  if (request.kind === "graphql") lintGraphql(key, entry, upstream, report);
  if (request.kind === "grpc") lintGrpc(key, entry, upstream, input, output, report);
}

function lintGraphql(key: string, entry: ToolsEntry, upstream: UpstreamTool, report: Report): void {
  const { request } = upstream;
  if (request.kind !== "graphql") return;

  const selection = entry.selection ?? request.selection;
  const depth = selection === undefined ? 0 : selectionDepth(selection);
  if (depth > DEEP_SELECTION) {
    report("deep_selection", {
      tool: key,
      field: "selection",
      message: `${key}'s selection set nests ${depth} levels, and a set deeper than ${DEEP_SELECTION} makes large results and slow queries.`,
      fix: `Cut the selection in [tools.${key}] to at most ${DEEP_SELECTION} levels.`,
    });
  }

  if (upstream.outputSchema === undefined || upstream.paging !== undefined) return;
  const properties = propertiesOf(upstream.outputSchema);
  const names = Object.keys(properties);
  const list =
    names.length === 1 && names[0] === "items" && isArraySchema(properties.items)
      ? "items"
      : isArraySchema(properties.edges)
        ? "edges"
        : undefined;
  if (list === undefined) return;
  if (request.arguments.some((argument) => PAGE_ARGUMENTS.has(argument.name.toLowerCase()))) return;
  report("unpaged_list", {
    tool: key,
    field: `outputSchema.properties.${list}`,
    message: `${key} returns a list, and field ${request.field} takes no paging argument, so one result can fill the context.`,
    fix: `Add a first or limit argument to ${request.field} in the GraphQL schema, then sync. Until then, keep fewer fields with select in [tools.${key}].`,
  });
}

function lintGrpc(
  key: string,
  entry: ToolsEntry,
  upstream: UpstreamTool,
  input: unknown,
  output: unknown,
  report: Report,
): void {
  const { request } = upstream;
  if (request.kind !== "grpc") return;

  const any = (node: Record<string, unknown>, at: string): void => {
    if (!Object.hasOwn(propertiesOf(node), "@type")) return;
    report("any_field", {
      tool: key,
      field: at,
      message: `${at} is a google.protobuf.Any, whose type is known only at run time, so the model cannot tell what it holds.`,
      fix: at.startsWith("inputSchema")
        ? `Hide the input or fix its value in [tools.${key}].`
        : `Leave the field out of the result with select in [tools.${key}].`,
    });
  };
  walkSchemas(input, "inputSchema", any);
  walkSchemas(output, "outputSchema", any);

  if (request.streaming === "server" && entry.max_items === undefined) {
    report("unbounded_stream", {
      tool: key,
      field: "max_items",
      message: `${key} imports server-streaming method ${request.method} without max_items, so a stream that never ends runs to its deadline on every call.`,
      fix: `Set max_items in [tools.${key}] to the most messages one call should read.`,
    });
  }

  if (request.idempotency_level === "IDEMPOTENCY_UNKNOWN") {
    report("no_idempotency_level", {
      tool: key,
      field: "method",
      message: `${request.method} sets no idempotency_level, so the suggestion falls back to write and high.`,
      fix: `Set option idempotency_level to NO_SIDE_EFFECTS or IDEMPOTENT on ${request.method} in the .proto file, or review side_effect and risk in [tools.${key}].`,
    });
  }
}
