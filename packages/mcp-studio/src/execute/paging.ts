// paging.ts: auto paging (mcp-studio-spec, Tools file, paginate and max_items).
//
// When tools.toml sets paginate and import found the tool's paging, one agent
// call reads page after page and returns every item in one result. Each page
// is its own send with its own retries, so a paged call records one exchange
// per page. Paging stops at the first of these:
//
// - max_items items are collected (MAX_ITEMS_LIMIT when tools.toml sets none);
// - a page holds no items;
// - has_more is present and not true;
// - the next cursor is absent, null, empty, or one already sent;
// - the call's deadline passes;
// - the collected items pass max_result_bytes, so more would be cut anyway;
// - a later page fails, or holds no item list.
//
// The first page decides the rest: when it fails, the call fails, and when it
// has no item list at the paging path, its value returns as it came.
import type { ManifestShaping } from "../contract/manifest";
import { MAX_ITEMS_LIMIT } from "../contract/tools";
import type { RecordedExchange } from "../contract/tests-files";
import type { Paging } from "../model/upstream-tool";
import type { SendError, SendResult, UpstreamArguments } from "./sender";
import { isList, isRecord, valueAt, withValueAt } from "./util";

/** Why auto paging stopped. */
export type PagingStop = "last_page" | "max_items" | "deadline" | "size" | "repeated_cursor" | "failed" | "no_items";

export interface PagedValue {
  /** The last page's value, with every collected item at the paging path. */
  value: unknown;
  /** The pages that returned items or ended the listing. */
  pages: number;
  /** The items collected. */
  items: number;
  stop: PagingStop;
  /** The later page's error, when stop is failed. */
  error?: SendError;
}

export type PagedResult =
  | { ok: true; paged: PagedValue | undefined; value: unknown; exchanges: RecordedExchange[] }
  | { ok: false; error: SendError; exchanges: RecordedExchange[] };

export interface PagingOptions {
  shaping: Pick<ManifestShaping, "deadline_ms" | "max_items" | "max_result_bytes">;
  /** The effective inputSchema, for the page input's default and minimum. */
  inputSchema: Record<string, unknown>;
  /** The agent-facing name of each upstream input, for reading inputSchema. */
  agentName: (upstream: string) => string;
  /** The size one page's value adds to the result, in bytes, after select and redact. */
  measure: (value: unknown) => number;
  /** Milliseconds since the epoch. Tests pass a clock. */
  now?: () => number;
}

/** Sends one page with these arguments and this much time left. */
export type SendPage = (args: UpstreamArguments, deadline_ms: number) => Promise<SendResult>;

/** The paging items path without a trailing []: data[] reads the list at data. */
export function itemsPath(paging: Paging): string {
  return paging.items.endsWith("[]") ? paging.items.slice(0, -2) : paging.items;
}

/** A copy of args with name set to value. A computed key keeps __proto__ as data. */
function withArgument(args: UpstreamArguments, name: string, value: unknown): UpstreamArguments {
  return { ...args, [name]: value };
}

/** A whole number from a number or a numeric string. */
function wholeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * The position of the first page: the argument the agent or tools.toml set,
 * else the input's schema default, else its minimum, else 1 for a page
 * number and 0 for an offset.
 */
function firstPosition(paging: Paging, args: UpstreamArguments, options: PagingOptions): number {
  const sent = wholeNumber(args[paging.input]);
  if (sent !== undefined) return sent;
  if (paging.style === "offset") return 0;
  const properties = options.inputSchema.properties;
  const name = options.agentName(paging.input);
  const property = isRecord(properties) && Object.hasOwn(properties, name) ? properties[name] : undefined;
  if (isRecord(property)) {
    const fallback = wholeNumber(property.default) ?? wholeNumber(property.minimum);
    if (fallback !== undefined) return fallback;
  }
  return 1;
}

/**
 * Send the first page, then each next page until a stop rule holds. Returns
 * the merged value, or the first page's error.
 */
export async function sendPages(
  paging: Paging,
  first: UpstreamArguments,
  options: PagingOptions,
  send: SendPage,
): Promise<PagedResult> {
  const now = options.now ?? Date.now;
  const path = itemsPath(paging);
  const max_items = options.shaping.max_items ?? MAX_ITEMS_LIMIT;
  const deadline = now() + options.shaping.deadline_ms;
  const exchanges: RecordedExchange[] = [];
  const collected: unknown[] = [];
  const cursors = new Set<string>();
  const numbered = paging.style === "page" || paging.style === "offset";
  // A page number or offset the agent sent as a string goes back as a string.
  const asString = typeof first[paging.input] === "string";
  let position = numbered ? firstPosition(paging, first, options) : 0;
  const sentCursor = first[paging.input];
  if (!numbered && sentCursor !== undefined) cursors.add(JSON.stringify(sentCursor));

  let args = first;
  let last: unknown;
  let pages = 0;
  let bytes = 0;
  let stop: PagingStop;
  let error: SendError | undefined;

  for (;;) {
    const remaining = Math.floor(deadline - now());
    if (pages > 0 && remaining < 1) {
      stop = "deadline";
      break;
    }
    const result = await send(args, pages === 0 ? options.shaping.deadline_ms : remaining);
    if (result.exchanges !== undefined) exchanges.push(...result.exchanges);
    if (!result.ok) {
      if (pages === 0) return { ok: false, error: result.error, exchanges };
      stop = "failed";
      error = result.error;
      break;
    }
    const list = valueAt(result.value, path);
    if (!isList(list)) {
      if (pages === 0) return { ok: true, paged: undefined, value: result.value, exchanges };
      stop = "no_items";
      break;
    }
    pages += 1;
    last = result.value;
    if (list.length === 0) {
      stop = "last_page";
      break;
    }
    const room = max_items - collected.length;
    collected.push(...list.slice(0, room));
    if (collected.length >= max_items) {
      stop = "max_items";
      break;
    }
    bytes += options.measure(result.value);
    if (bytes > options.shaping.max_result_bytes) {
      stop = "size";
      break;
    }
    if (paging.has_more !== undefined && valueAt(result.value, paging.has_more) !== true) {
      stop = "last_page";
      break;
    }
    if (numbered) {
      position += paging.style === "page" ? 1 : list.length;
      args = withArgument(args, paging.input, asString ? String(position) : position);
      continue;
    }
    // A cursor listing with no next path has no way to ask for the next page.
    if (paging.next === undefined) {
      stop = "last_page";
      break;
    }
    const cursor = valueAt(result.value, paging.next);
    if (cursor === undefined || cursor === null || cursor === "") {
      stop = "last_page";
      break;
    }
    const key = JSON.stringify(cursor);
    if (cursors.has(key)) {
      stop = "repeated_cursor";
      break;
    }
    cursors.add(key);
    args = withArgument(args, paging.input, cursor);
  }

  const paged: PagedValue = { value: withValueAt(last, path, collected), pages, items: collected.length, stop };
  if (error !== undefined) paged.error = error;
  return { ok: true, paged, value: paged.value, exchanges };
}

/** The error's text in a result: its title, its status when there is one, and its detail. */
export function errorText(error: SendError): string {
  return error.status === undefined
    ? `${error.title}: ${error.detail}`
    : `${error.title} (status ${error.status}): ${error.detail}`;
}

/** The text with a closing period when it has no closing punctuation. */
function asSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What the agent reads about a paged call that stopped before the listing
 * ended, or undefined when it read every page.
 */
export function pagingNote(paged: PagedValue, options: Pick<PagingOptions, "shaping">): string | undefined {
  const read = `${plural(paged.items, "item", "items")} from ${plural(paged.pages, "page", "pages")}`;
  switch (paged.stop) {
    case "last_page":
      return undefined;
    case "max_items":
      return `Auto paging stopped at max_items: the result holds ${read}, and more may remain.`;
    case "deadline":
      return `Auto paging stopped at the ${options.shaping.deadline_ms} ms deadline: the result holds ${read}, and more may remain.`;
    case "size":
      return `Auto paging stopped at the ${options.shaping.max_result_bytes}-byte result limit: the result holds ${read}, and more may remain.`;
    case "repeated_cursor":
      return `Auto paging stopped because the upstream sent a cursor it had sent before: the result holds ${read}.`;
    case "no_items":
      return `Auto paging stopped because page ${paged.pages + 1} held no item list: the result holds ${read}.`;
    case "failed": {
      const reason = paged.error === undefined ? "" : ` ${asSentence(errorText(paged.error))}`;
      return `Auto paging stopped because page ${paged.pages + 1} failed: the result holds ${read}.${reason}`;
    }
  }
}
