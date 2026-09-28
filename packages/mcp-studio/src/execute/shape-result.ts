// shape-result.ts: turn the upstream's value into the tools/call result the
// agent receives (mcp-studio-spec, Call path, Shape the result).
//
// select keeps only the listed result paths, and redact removes its paths.
// Both apply to a structured result and to every text item that parses as a
// JSON object, so a redacted field cannot reach the agent through the text
// rendering. An MCP error result takes redact only. Other text takes only the
// size cap.
//
// The size cap counts UTF-8 bytes after select and redact. It counts every
// content item and structuredContent together, because the agent receives
// both. A result over it first loses items from the end of its list, so what
// remains is still valid JSON. When no list can be cut, the result carries no
// structuredContent, and text over the cap is cut at the cap. Every note about
// a cut or a stopped page goes in its own text item after the result, never
// inside structuredContent.
import type { ManifestShaping } from "../contract/manifest";
import type { Paging } from "../model/upstream-tool";
import { decodeText, encodeText, parseJson } from "./body";
import { itemsPath } from "./paging";
import type { CallToolResult } from "./transport";
import { isList, isRecord, valueAt, withValueAt } from "./util";

type Content = CallToolResult["content"][number];

/** One step of the select or redact paths. */
export interface PathNode {
  /** A path ends here: select keeps the whole value, and redact removes it. */
  end: boolean;
  fields: Map<string, PathNode>;
  /** The node for each element of a list, from a [] step. */
  each: PathNode | undefined;
}

function node(): PathNode {
  return { end: false, fields: new Map(), each: undefined };
}

/** The paths as a tree, or undefined when there are none. data[].id is data, then each element, then id. */
function pathTree(paths: readonly string[]): PathNode | undefined {
  if (paths.length === 0) return undefined;
  const root = node();
  for (const path of paths) {
    let at = root;
    for (const step of path.split(".")) {
      const list = step.endsWith("[]");
      const name = list ? step.slice(0, -2) : step;
      let next = at.fields.get(name);
      if (next === undefined) {
        next = node();
        at.fields.set(name, next);
      }
      at = next;
      if (list) {
        at.each ??= node();
        at = at.each;
      }
    }
    at.end = true;
  }
  return root;
}

const ABSENT = Symbol("absent");

/** The value with only the tree's paths kept, or ABSENT when none of them is there. */
function project(value: unknown, at: PathNode): unknown {
  if (at.end) return value;
  if (isList(value) && at.each !== undefined) {
    const each = at.each;
    return value.map((item) => project(item, each)).filter((item) => item !== ABSENT);
  }
  if (isRecord(value) && at.fields.size > 0) {
    const kept: Array<[string, unknown]> = [];
    for (const [name, child] of at.fields) {
      if (!Object.hasOwn(value, name)) continue;
      const out = project(value[name], child);
      if (out !== ABSENT) kept.push([name, out]);
    }
    return Object.fromEntries(kept);
  }
  return ABSENT;
}

/** The value with the tree's paths removed, or ABSENT when the whole value is removed. */
function remove(value: unknown, at: PathNode): unknown {
  if (at.end) return ABSENT;
  if (isList(value) && at.each !== undefined) {
    const each = at.each;
    return value.map((item) => remove(item, each)).filter((item) => item !== ABSENT);
  }
  if (isRecord(value) && at.fields.size > 0) {
    const kept: Array<[string, unknown]> = [];
    for (const [name, item] of Object.entries(value)) {
      const child = at.fields.get(name);
      const out = child === undefined ? item : remove(item, child);
      if (out !== ABSENT) kept.push([name, out]);
    }
    return Object.fromEntries(kept);
  }
  return value;
}

/** select and redact as trees, compiled once per call. */
export interface ResultRules {
  select: PathNode | undefined;
  redact: PathNode | undefined;
  max_result_bytes: number;
  /** The list the size cap cuts: the paging items path, else items. */
  list: string;
  /** The hint the size-cap note gives, naming inputs the agent can see. */
  hint: string;
}

/** The agent-facing name of an upstream input, or undefined when the agent cannot set it. */
export function visibleInput(shaping: ManifestShaping, upstream: string | undefined): string | undefined {
  if (upstream === undefined || shaping.hide.includes(upstream) || Object.hasOwn(shaping.fixed, upstream)) {
    return undefined;
  }
  return Object.hasOwn(shaping.rename, upstream) ? shaping.rename[upstream] : upstream;
}

export function resultRules(shaping: ManifestShaping, paging: Paging | undefined): ResultRules {
  const limit = visibleInput(shaping, paging?.limit);
  const input = visibleInput(shaping, paging?.input);
  let hint = "";
  if (limit !== undefined) {
    hint = input === undefined ? ` Set ${limit} lower to get whole pages.` : ` Set ${limit} lower to get whole pages, and page with ${input}.`;
  }
  return {
    select: pathTree(shaping.select),
    redact: pathTree(shaping.redact),
    max_result_bytes: shaping.max_result_bytes,
    list: paging === undefined ? "items" : itemsPath(paging),
    hint,
  };
}

/** A JSON object with select and redact applied. isError results take redact only. */
function shapeRecord(value: Record<string, unknown>, rules: ResultRules, isError: boolean): Record<string, unknown> {
  let out: unknown = value;
  if (rules.select !== undefined && !isError) out = project(out, rules.select);
  if (rules.redact !== undefined) out = remove(out, rules.redact);
  // A record projects and redacts to a record.
  return isRecord(out) ? out : {};
}

/** A JSON value with select and redact applied. Only an object has paths to apply them to. */
export function shapeJson(value: unknown, rules: ResultRules): unknown {
  return isRecord(value) ? shapeRecord(value, rules, false) : value;
}

/** The UTF-8 length of text. */
export function byteLength(text: string): number {
  return encodeText(text).byteLength;
}

/** The text cut to at most max UTF-8 bytes, never inside a character. */
function cutBytes(text: string, max: number): string {
  const bytes = encodeText(text);
  if (bytes.byteLength <= max) return text;
  let end = max;
  // A continuation byte at the cut belongs to a character that starts before it.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return decodeText(bytes.subarray(0, end));
}

function textItem(text: string): Content {
  return { type: "text", text };
}

function cutNote(max: number): string {
  return `The result was cut at the ${max}-byte limit, so its text is incomplete.`;
}

/** What one content item costs against the size cap: its text, or the item's JSON. */
function itemBytes(item: Content): number {
  return item.type === "text" && typeof item.text === "string" ? byteLength(item.text) : byteLength(JSON.stringify(item));
}

/** What a result costs against the size cap: every content item, plus the JSON of structuredContent. */
function resultBytes(content: readonly Content[], structured: Record<string, unknown> | undefined): number {
  const items = content.reduce((sum, item) => sum + itemBytes(item), 0);
  return structured === undefined ? items : items + byteLength(JSON.stringify(structured));
}

/** The result for a shaped JSON value: its text, and the value as structuredContent when it is an object. */
function jsonResult(value: unknown, text: string): CallToolResult {
  const result: CallToolResult = { content: [textItem(text)] };
  if (isRecord(value)) result.structuredContent = value;
  return result;
}

/** True when the result's content and structuredContent together fit the size cap. */
function fitsCap(result: CallToolResult, rules: ResultRules): boolean {
  return resultBytes(result.content, result.structuredContent) <= rules.max_result_bytes;
}

/**
 * The result with the list at rules.list cut to the longest head whose text
 * and structuredContent together fit, and the note that says so, or
 * undefined when no list can be cut to fit.
 */
function cutList(value: unknown, rules: ResultRules): { result: CallToolResult; note: string } | undefined {
  const list = valueAt(value, rules.list);
  if (!isList(list) || list.length === 0) return undefined;
  const render = (count: number): CallToolResult => {
    const head = withValueAt(value, rules.list, list.slice(0, count));
    return jsonResult(head, JSON.stringify(head));
  };
  const fits = (count: number): boolean => fitsCap(render(count), rules);
  if (!fits(0)) return undefined;
  // The whole list does not fit, so the answer is below list.length.
  let low = 0;
  let high = list.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const note =
    `The result holds the first ${low} of ${list.length} items, cut to fit the ${rules.max_result_bytes}-byte limit.` +
    rules.hint;
  return { result: render(low), note };
}

/**
 * The result for a JSON value from an HTTP, GraphQL, or gRPC call. An object
 * becomes structuredContent and its compact JSON text, and the size cap
 * counts both, as it does for an MCP result. A string that parses as JSON
 * counts as that JSON. Other text takes only the size cap.
 */
export function shapeValue(value: unknown, rules: ResultRules, notes: readonly string[]): CallToolResult {
  if (value === undefined) return withNotes({ content: [textItem("The upstream returned no content.")] }, notes);
  let json: unknown = value;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (!parsed.ok) return withNotes(cutText(value, rules), notes);
    json = parsed.value;
  }
  const shaped = shapeJson(json, rules);
  const text = JSON.stringify(shaped);
  const whole = jsonResult(shaped, text);
  if (fitsCap(whole, rules)) return withNotes(whole, notes);
  const cut = cutList(shaped, rules);
  if (cut === undefined) return withNotes(cutText(text, rules), notes);
  return withNotes(cut.result, [...notes, cut.note]);
}

/** Plain text under the size cap, with a note when it was cut. */
function cutText(text: string, rules: ResultRules): CallToolResult {
  if (byteLength(text) <= rules.max_result_bytes) return { content: [textItem(text)] };
  return {
    content: [textItem(cutBytes(text, rules.max_result_bytes)), textItem(cutNote(rules.max_result_bytes))],
  };
}

function withNotes(result: CallToolResult, notes: readonly string[]): CallToolResult {
  if (notes.length === 0) return result;
  return { ...result, content: [...result.content, ...notes.map(textItem)] };
}

/** A text item with select and redact applied when its text is a JSON object. */
function shapeTextItem(item: Content, rules: ResultRules, isError: boolean): Content {
  const text = item.text;
  if (typeof text !== "string") return item;
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) return item;
  return { ...item, text: JSON.stringify(shapeRecord(parsed.value, rules, isError)) };
}

/**
 * The result from an MCP server, shaped. select and redact apply to
 * structuredContent and to each text item that parses as a JSON object. A
 * result over the size cap loses structuredContent, then keeps the content
 * items that fit, in order, with the first text item that does not fit cut
 * at the cap.
 */
export function shapeToolResult(result: CallToolResult, rules: ResultRules, notes: readonly string[]): CallToolResult {
  const isError = result.isError === true;
  const shapes = rules.select !== undefined || rules.redact !== undefined;
  const content = shapes
    ? result.content.map((item) => (item.type === "text" ? shapeTextItem(item, rules, isError) : item))
    : [...result.content];
  const structured =
    result.structuredContent === undefined ? undefined : shapeRecord(result.structuredContent, rules, isError);

  const shaped: CallToolResult = { content };
  if (isError) shaped.isError = true;
  if (resultBytes(content, structured) <= rules.max_result_bytes) {
    if (structured !== undefined) shaped.structuredContent = structured;
    return withNotes(shaped, notes);
  }

  let budget = rules.max_result_bytes;
  const kept: Content[] = [];
  for (const item of content) {
    const cost = itemBytes(item);
    if (cost <= budget) {
      kept.push(item);
      budget -= cost;
    } else if (item.type === "text" && typeof item.text === "string" && budget > 0) {
      kept.push({ ...item, text: cutBytes(item.text, budget) });
      budget = 0;
    }
  }
  return withNotes({ ...shaped, content: kept }, [...notes, cutNote(rules.max_result_bytes)]);
}
