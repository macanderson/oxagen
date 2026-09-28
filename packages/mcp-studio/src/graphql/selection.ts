// selection.ts: a root field's generated selection set, the outputSchema it
// implies, and a connection's paging (mcp-studio-spec, Mapping: GraphQL, and
// the tools file's selection and paginate).
//
// The selection goes 2 levels below the root field and stops at connections.
// Each set lists scalar and enum fields first, then object fields, and keeps
// at most 20. A field is left out when it is deprecated or has a required
// argument, since the selection passes no arguments. An interface or union
// adds __typename, and a union selects each member in an inline fragment at
// the same depth. A root field that returns a connection selects its edges'
// nodes and pageInfo, and gets connection paging when it takes after.
import {
  assertLeafType,
  getNamedType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isRequiredArgument,
  isUnionType,
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLNamedOutputType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLUnionType,
} from "graphql";
import type { Paging } from "../model/upstream-tool";
import { leafSchema, orNull, withDescription, type JsonSchema, type ObjectSchema } from "./json-schema";
import type { Notes } from "./notes";

/** The longest selection the request template holds. */
const SELECTION_LENGTH_MAX = 16_384;
const SELECTION_FIELDS_MAX = 20;
const SELECTION_DEPTH = 2;

type Field = GraphQLField<unknown, unknown>;
type FieldsType = GraphQLObjectType | GraphQLInterfaceType;
type CompositeType = FieldsType | GraphQLUnionType;

interface Picked {
  field: Field;
  /** The sub-selection of an object field. Absent for a scalar or enum field. */
  sub: Selection | undefined;
}

interface Selection {
  owner: CompositeType;
  typename: boolean;
  fields: Picked[];
  fragments: { on: GraphQLObjectType; selection: Selection }[];
}

interface Connection {
  type: FieldsType;
  edges: Field;
  edge: FieldsType;
  node: Field;
  pageInfo: Field;
  info: FieldsType;
  hasNextPage: Field;
  endCursor: Field;
}

interface Context {
  schema: GraphQLSchema;
  tool: string;
  notes: Notes;
}

/** What a root field's result maps to. */
export interface ResultMapping {
  selection: string | undefined;
  outputSchema: ObjectSchema | undefined;
  paging: Paging | undefined;
}

/**
 * The selection, outputSchema, and paging for one root field. A scalar or
 * enum result has no selection. A list result is { items }, as the executor
 * returns it. A selection longer than 16,384 characters stops at depth 1, and
 * then at __typename, each with a note.
 */
export function resultOf(field: Field, path: string, context: Context): ResultMapping {
  const type = isNonNullType(field.type) ? field.type.ofType : field.type;
  const named = getNamedType(field.type);
  const items = (selection: Selection | undefined): ObjectSchema => ({
    type: "object",
    properties: { items: outputType(field.type, selection, context) },
  });
  if (isLeafType(named)) {
    return { selection: undefined, outputSchema: isListType(type) ? items(undefined) : undefined, paging: undefined };
  }

  const connection = isListType(type) ? undefined : connectionOf(named);
  let paging = connection === undefined ? undefined : pagingOf(field, path, context);
  let selection = rooted(
    connection === undefined ? select(named, SELECTION_DEPTH, context) : selectConnection(connection, context),
    context,
  );
  let text = printSelection(selection);
  if (text.length > SELECTION_LENGTH_MAX) {
    context.notes.add(
      context.tool,
      `The selection set to depth ${SELECTION_DEPTH} is longer than 16,384 characters, so it stops at depth 1.`,
    );
    if (paging !== undefined) {
      context.notes.add(context.tool, "Paging needs edges and pageInfo in the selection set, so the tool has no paging.");
      paging = undefined;
    }
    selection = rooted(select(named, 1, context), context);
    text = printSelection(selection);
  }
  if (text.length > SELECTION_LENGTH_MAX) {
    context.notes.add(
      context.tool,
      "The selection set at depth 1 is still longer than 16,384 characters, so it selects only __typename.",
    );
    selection = typenameOnly(named);
    text = printSelection(selection);
  }
  return { selection: text, outputSchema: isListType(type) ? items(selection) : outputOf(selection, context), paging };
}

// ── Selecting ────────────────────────────────────────────────────────────────

function select(type: CompositeType, levels: number, context: Context): Selection {
  return isUnionType(type) ? selectUnion(type, levels, context) : selectFields(type, levels, context);
}

function selectFields(type: FieldsType, levels: number, context: Context): Selection {
  const leaves: Field[] = [];
  const composites: { field: Field; named: CompositeType }[] = [];
  for (const field of Object.values(type.getFields())) {
    if (field.deprecationReason != null || !callable(field)) continue;
    const named = getNamedType(field.type);
    if (isLeafType(named)) leaves.push(field);
    else composites.push({ field, named });
  }
  const fields: Picked[] = leaves.slice(0, SELECTION_FIELDS_MAX).map((field) => ({ field, sub: undefined }));
  let dropped = leaves.length > SELECTION_FIELDS_MAX;
  if (levels > 1) {
    for (const { field, named } of composites) {
      if (connectionOf(named) !== undefined) continue;
      if (fields.length === SELECTION_FIELDS_MAX) {
        dropped = true;
        break;
      }
      const sub = select(named, levels - 1, context);
      if (!isEmpty(sub)) fields.push({ field, sub });
    }
  }
  if (dropped) {
    context.notes.add(
      context.tool,
      `The selection set on ${type.name} keeps its first ${SELECTION_FIELDS_MAX} fields, scalar and enum fields first.`,
    );
  }
  return { owner: type, typename: isInterfaceType(type), fields, fragments: [] };
}

/**
 * Each member in an inline fragment. Two members may not return different
 * types under one response name, so the later field is left out.
 */
function selectUnion(type: GraphQLUnionType, levels: number, context: Context): Selection {
  const shapes = new Map<string, string>();
  const fragments: Selection["fragments"] = [];
  for (const member of type.getTypes()) {
    const selection = selectFields(member, levels, context);
    selection.fields = selection.fields.filter(({ field }) => {
      const shape = String(field.type);
      const first = shapes.get(field.name);
      if (first === undefined) shapes.set(field.name, shape);
      else if (first !== shape) {
        context.notes.add(
          context.tool,
          `${member.name}.${field.name} is left out of the ${type.name} selection, because another member returns ${first} under that name.`,
        );
        return false;
      }
      return true;
    });
    if (!isEmpty(selection)) fragments.push({ on: member, selection });
  }
  return { owner: type, typename: true, fields: [], fragments };
}

/** A root connection: its own scalar fields, then edges with the node's scalar fields, then pageInfo. */
function selectConnection(connection: Connection, context: Context): Selection {
  const selection = selectFields(connection.type, 1, context);
  const edge = selectFields(connection.edge, 1, context);
  edge.fields = edge.fields.filter(({ field }) => field !== connection.node);
  const node = getNamedType(connection.node.type);
  edge.fields.push({ field: connection.node, sub: isLeafType(node) ? undefined : nonEmpty(select(node, 1, context)) });
  const pageInfo: Selection = {
    owner: connection.info,
    typename: false,
    fields: [
      { field: connection.hasNextPage, sub: undefined },
      { field: connection.endCursor, sub: undefined },
    ],
    fragments: [],
  };
  selection.fields.push({ field: connection.edges, sub: edge }, { field: connection.pageInfo, sub: pageInfo });
  return selection;
}

/** The root selection, or __typename alone when no field can be selected. */
function rooted(selection: Selection, context: Context): Selection {
  if (!isEmpty(selection)) return selection;
  context.notes.add(
    context.tool,
    `No field of ${selection.owner.name} can be selected, so the selection set asks only for __typename.`,
  );
  return typenameOnly(selection.owner);
}

function nonEmpty(selection: Selection): Selection {
  return isEmpty(selection) ? typenameOnly(selection.owner) : selection;
}

function typenameOnly(owner: CompositeType): Selection {
  return { owner, typename: true, fields: [], fragments: [] };
}

function isEmpty(selection: Selection): boolean {
  return selection.fields.length === 0 && selection.fragments.length === 0;
}

function callable(field: Field): boolean {
  return !field.args.some(isRequiredArgument);
}

function hasFields(type: GraphQLNamedOutputType): type is FieldsType {
  return isObjectType(type) || isInterfaceType(type);
}

/**
 * The type's connection fields, or undefined when it is not a connection: a
 * list of edges that each hold a node, and a pageInfo with hasNextPage and
 * endCursor.
 */
function connectionOf(type: CompositeType): Connection | undefined {
  if (isUnionType(type)) return undefined;
  const fields = type.getFields();
  const edges = fields.edges;
  const pageInfo = fields.pageInfo;
  if (edges === undefined || pageInfo === undefined) return undefined;
  const list = isNonNullType(edges.type) ? edges.type.ofType : edges.type;
  const edge = getNamedType(edges.type);
  const info = getNamedType(pageInfo.type);
  if (!isListType(list) || !hasFields(edge) || !hasFields(info)) return undefined;
  const node = edge.getFields().node;
  const { hasNextPage, endCursor } = info.getFields();
  if (node === undefined || hasNextPage === undefined || endCursor === undefined) return undefined;
  if (!isLeafType(getNamedType(hasNextPage.type)) || !isLeafType(getNamedType(endCursor.type))) return undefined;
  if (![edges, pageInfo, node, hasNextPage, endCursor].every(callable)) return undefined;
  return { type, edges, edge, node, pageInfo, info, hasNextPage, endCursor };
}

function pagingOf(field: Field, path: string, context: Context): Paging | undefined {
  const names = new Set(field.args.map((arg) => arg.name));
  if (!names.has("after")) {
    context.notes.add(context.tool, `${path} returns a connection but takes no after argument, so the tool has no paging.`);
    return undefined;
  }
  return {
    style: "connection",
    input: "after",
    next: "pageInfo.endCursor",
    has_more: "pageInfo.hasNextPage",
    items: "edges",
    ...(names.has("first") ? { limit: "first" } : {}),
  };
}

// ── Printing and outputSchema ────────────────────────────────────────────────

/** The selection on one line: { id title author { name } }. */
function printSelection(selection: Selection): string {
  const parts: string[] = selection.typename ? ["__typename"] : [];
  for (const { field, sub } of selection.fields) {
    parts.push(sub === undefined ? field.name : `${field.name} ${printSelection(sub)}`);
  }
  for (const { on, selection: inner } of selection.fragments) parts.push(`... on ${on.name} ${printSelection(inner)}`);
  return `{ ${parts.join(" ")} }`;
}

/** The object a selection returns. A union's members share one object, since their fields cannot conflict. */
function outputOf(selection: Selection, context: Context): ObjectSchema {
  const properties: Record<string, JsonSchema> = {};
  if (selection.typename) properties.__typename = typenameSchema(selection.owner, context.schema);
  for (const { field, sub } of selection.fields) {
    properties[field.name] = withDescription(outputType(field.type, sub, context), field.description);
  }
  for (const { selection: inner } of selection.fragments) {
    for (const [name, schema] of Object.entries(outputOf(inner, context).properties)) {
      if (!Object.hasOwn(properties, name)) properties[name] = schema;
    }
  }
  return { type: "object", properties };
}

function outputType(type: GraphQLOutputType, sub: Selection | undefined, context: Context): JsonSchema {
  if (isNonNullType(type)) return bareOutput(type.ofType, sub, context);
  return orNull(bareOutput(type, sub, context));
}

function bareOutput(type: GraphQLOutputType, sub: Selection | undefined, context: Context): JsonSchema {
  if (isListType(type)) return { type: "array", items: outputType(type.ofType, sub, context) };
  if (sub !== undefined) return outputOf(sub, context);
  return leafSchema(assertLeafType(getNamedType(type)));
}

/** __typename as the object types it can name, sorted. */
function typenameSchema(owner: CompositeType, schema: GraphQLSchema): JsonSchema {
  const names = isObjectType(owner) ? [owner.name] : schema.getPossibleTypes(owner).map((type) => type.name);
  return names.length === 0 ? { type: "string" } : { type: "string", enum: names.sort() };
}
