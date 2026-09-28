// paging.ts: how to page an operation, when its parameters and its result
// match a pattern import knows.
//
// Cursor paging needs a cursor query parameter and a result field that names
// the next cursor. An operation with a cursor parameter and no such field
// falls through to page and offset. Page and offset paging need a page or
// offset query parameter. Every style needs the array the pages add to. When
// no pattern fits, the tool has no paging.
import type { HttpParameter, Paging } from "../model/upstream-tool";
import { isList, isRecord, type JsonRecord } from "./json";

const CURSOR_INPUTS = [
  "cursor",
  "page_token",
  "pageToken",
  "next_token",
  "nextToken",
  "continuation_token",
  "continuationToken",
  "after",
  "page_cursor",
  "marker",
];

const NEXT_FIELDS = [
  "next_cursor",
  "nextCursor",
  "next_page_token",
  "nextPageToken",
  "next_token",
  "nextToken",
  "continuation_token",
  "continuationToken",
];

const PAGE_INPUTS = ["page", "page_number", "pageNumber", "page_num"];
const PAGE_LIMITS = ["per_page", "perPage", "page_size", "pageSize", "limit", "size", "max_results", "maxResults"];

const OFFSET_INPUTS = ["offset", "skip", "start", "start_index", "startIndex"];
const OFFSET_LIMITS = [
  "limit",
  "count",
  "size",
  "max_results",
  "maxResults",
  "page_size",
  "pageSize",
  "per_page",
  "perPage",
  "top",
  "take",
];

const HAS_MORE_FIELDS = ["has_more", "hasMore", "has_next", "hasNext", "has_next_page", "hasNextPage"];

/** The array fields import prefers, in order, when a result has more than one. */
const ITEM_FIELDS = ["data", "items", "results", "records", "entries", "values", "list"];

const RESULT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*$/;

function hasType(schema: unknown, type: string): boolean {
  if (!isRecord(schema)) return false;
  const declared = schema.type;
  if (declared === type) return true;
  return isList(declared) && declared.includes(type) && declared.every((item) => item === type || item === "null");
}

function isArraySchema(schema: unknown): boolean {
  return hasType(schema, "array") || (isRecord(schema) && schema.type === undefined && schema.items !== undefined);
}

function propertiesOf(schema: JsonRecord): JsonRecord {
  return isRecord(schema.properties) ? schema.properties : {};
}

/** The first field among `names`, at the top level or one level down, whose schema has `type`. */
function findField(output: JsonRecord, names: readonly string[], type: string): string | undefined {
  const top = propertiesOf(output);
  for (const name of names) {
    if (Object.hasOwn(top, name) && hasType(top[name], type)) return name;
  }
  for (const [parent, schema] of Object.entries(top)) {
    if (!RESULT_PATH.test(parent) || !isRecord(schema)) continue;
    const nested = propertiesOf(schema);
    for (const name of names) {
      if (Object.hasOwn(nested, name) && hasType(nested[name], type)) return `${parent}.${name}`;
    }
  }
  return undefined;
}

function findItems(output: JsonRecord, wrapped: boolean): string | undefined {
  if (wrapped) return "items";
  const properties = propertiesOf(output);
  for (const name of ITEM_FIELDS) {
    if (Object.hasOwn(properties, name) && isArraySchema(properties[name])) return name;
  }
  const arrays = Object.keys(properties).filter((name) => isArraySchema(properties[name]));
  const only = arrays.length === 1 ? arrays[0] : undefined;
  return only !== undefined && RESULT_PATH.test(only) ? only : undefined;
}

function queryParameter(parameters: readonly HttpParameter[], names: readonly string[]): HttpParameter | undefined {
  for (const name of names) {
    const found = parameters.find((parameter) => parameter.in === "query" && parameter.name === name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The paging an operation supports, or undefined. `output` is the tool's
 * outputSchema, and `wrapped` is true when an array result arrives as
 * { items }.
 */
export function detectPaging(
  parameters: readonly HttpParameter[],
  output: JsonRecord | undefined,
  wrapped: boolean,
): Paging | undefined {
  if (output === undefined) return undefined;
  const items = findItems(output, wrapped);
  if (items === undefined) return undefined;
  const hasMore = findField(output, HAS_MORE_FIELDS, "boolean");

  const build = (style: Paging["style"], input: HttpParameter, limits: readonly string[], next?: string): Paging => {
    const paging: Paging = { style, input: input.property, items };
    if (next !== undefined) paging.next = next;
    if (hasMore !== undefined) paging.has_more = hasMore;
    const limit = queryParameter(parameters, limits);
    if (limit !== undefined) paging.limit = limit.property;
    return paging;
  };

  const cursor = queryParameter(parameters, CURSOR_INPUTS);
  if (cursor !== undefined) {
    const next = findField(output, NEXT_FIELDS, "string");
    if (next !== undefined) return build("cursor", cursor, PAGE_LIMITS, next);
  }
  const page = queryParameter(parameters, PAGE_INPUTS);
  if (page !== undefined) return build("page", page, PAGE_LIMITS);
  const offset = queryParameter(parameters, OFFSET_INPUTS);
  if (offset !== undefined) return build("offset", offset, OFFSET_LIMITS);
  return undefined;
}
