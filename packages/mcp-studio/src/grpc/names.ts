// names.ts: the tool name a method suggests. PostEntry suggests post_entry
// (mcp-studio-spec, Mapping (gRPC)).
import { TOOL_KEY_MAX } from "../contract/primitives";
import type { Notes } from "../graphql/notes";

/** The method name in snake case, as a tool key: GetHTTPRoute is get_http_route. */
function snakeKey(methodName: string): string {
  const snake = methodName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return /^[a-z]/.test(snake) ? snake : `method_${snake}`.replace(/_$/, "");
}

/**
 * A tool key for the method that no earlier method took. A key longer than a
 * tool key may be is cut, and a taken key gets _2, _3, and so on. Each change
 * adds a note. `path` is the method as the request template names it:
 * a_intel.ledger.v1.Ledger/PostEntry.
 */
export function toolKeyFor(path: string, methodName: string, taken: Set<string>, notes: Notes): string {
  const snake = snakeKey(methodName);
  const base = snake.length > TOOL_KEY_MAX ? snake.slice(0, TOOL_KEY_MAX).replace(/_+$/, "") : snake;
  let key = base;
  for (let n = 2; taken.has(key); n += 1) {
    const suffix = `_${n}`;
    key = `${base.slice(0, TOOL_KEY_MAX - suffix.length).replace(/_+$/, "")}${suffix}`;
  }
  taken.add(key);
  if (base !== snake) {
    notes.add(key, `${path} suggests a name longer than ${TOOL_KEY_MAX} characters, so it is cut to ${base}.`);
  }
  if (key !== base) notes.add(key, `Another method already takes ${base}, so ${path} takes ${key}.`);
  return key;
}
