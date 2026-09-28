// overlay.ts: overlay.yaml, an OpenAPI Overlay 1.0, applied to the bundle.
//
// Each action names its targets with a JSONPath (RFC 9535). `update` merges
// into each object it matches and appends to each array. `remove: true`
// deletes each match, and wins over `update` in the same action. The overlay
// changes what import reads. It never changes document_hash, which covers
// the definition as committed.
import { exec, type JsonValue } from "jsonpath-rfc9535";
import type { ImportNote } from "../model/import-result";
import { OpenApiImportError, firstLine } from "./errors";
import { NodeBudget, copyJson, isRecord, setOwn, valueAt, type JsonRecord } from "./json";
import { PARSED_NODES_MAX } from "./limits";
import { parseFile } from "./load";

const OVERLAY_FILE = "overlay.yaml";

type Path = (string | number)[];

interface Action {
  target: string;
  update: unknown;
  remove: boolean;
}

function invalid(why: string): OpenApiImportError {
  return new OpenApiImportError("overlay", `${OVERLAY_FILE} is not a valid Overlay 1.0 document: ${why}. Fix it and import again.`);
}

function readActions(overlay: unknown): Action[] {
  if (!isRecord(overlay)) throw invalid("it is not a mapping");
  const version = overlay.overlay;
  if (typeof version !== "string" || !version.startsWith("1.")) throw invalid("its overlay field is not 1.0.0");
  const actions = overlay.actions;
  if (!Array.isArray(actions)) throw invalid("it has no actions list");
  return actions.map((action, index) => {
    const n = index + 1;
    if (!isRecord(action)) throw invalid(`action ${n} is not a mapping`);
    const { target, update, remove } = action;
    if (typeof target !== "string" || target === "") throw invalid(`action ${n} has no target`);
    if (remove !== undefined && typeof remove !== "boolean") throw invalid(`action ${n} has a remove that is not true or false`);
    return { target, update, remove: remove === true };
  });
}

const ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", "'": "'", "\\": "\\" };

/** A path key as the document spells it. The JSONPath library returns keys in normalized, escaped form. */
function unescapeKey(key: string): string {
  return key.replace(/\\(u[0-9a-f]{4}|[bfnrt'\\])/g, (_, escape: string) =>
    escape.startsWith("u") ? String.fromCharCode(Number.parseInt(escape.slice(1), 16)) : (ESCAPES[escape] ?? escape),
  );
}

function comparePaths(a: Path, b: Path): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return a.length - b.length;
}

function mergeInto(target: JsonRecord, update: JsonRecord, budget: NodeBudget): void {
  for (const [key, value] of Object.entries(update)) {
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isRecord(current) && isRecord(value)) mergeInto(current, value, budget);
    else if (Array.isArray(current) && Array.isArray(value)) {
      setOwn(target, key, [...(current as unknown[]), ...(copyJson(value, budget, OVERLAY_FILE) as unknown[])]);
    } else setOwn(target, key, copyJson(value, budget, OVERLAY_FILE));
  }
}

function describe(path: Path): string {
  return `$${path.map((key) => (typeof key === "number" ? `[${key}]` : `['${key}']`)).join("")}`;
}

function matchesOf(document: unknown, action: Action, n: number): { value: unknown; path: Path }[] {
  const matches: { value: unknown; path: Path }[] = [];
  try {
    exec(document as JsonValue, action.target, (value, path) => {
      matches.push({ value, path: path.map((key) => (typeof key === "number" ? key : unescapeKey(key))) });
    });
  } catch (error) {
    throw new OpenApiImportError(
      "overlay",
      `Action ${n} in ${OVERLAY_FILE} has a target that is not valid JSONPath (${action.target}): ${firstLine(error)}. ` +
        "Fix the target and import again.",
    );
  }
  return matches;
}

function remove(document: unknown, matches: { path: Path }[], n: number): void {
  const seen = new Set<string>();
  const paths = matches
    .map((match) => match.path)
    .filter((path) => {
      const key = JSON.stringify(path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(comparePaths)
    .reverse();
  for (const path of paths) {
    if (path.length === 0) {
      throw new OpenApiImportError(
        "overlay",
        `Action ${n} in ${OVERLAY_FILE} removes the whole document. Point its target inside the document and import again.`,
      );
    }
    const parent = valueAt(document, path.slice(0, -1).map(String));
    const key = path[path.length - 1] as string | number;
    if (!parent.found) continue;
    if (Array.isArray(parent.value) && typeof key === "number") parent.value.splice(key, 1);
    else if (isRecord(parent.value) && typeof key === "string") delete parent.value[key];
  }
}

/**
 * Applies overlay.yaml to the bundled document in place. An action that
 * matches nothing, or cannot apply, leaves a note and changes nothing.
 */
export function applyOverlay(document: unknown, text: string, notes: ImportNote[]): void {
  const budget = new NodeBudget(PARSED_NODES_MAX, "The overlay");
  const actions = readActions(parseFile(text, OVERLAY_FILE, budget));
  actions.forEach((action, index) => {
    const n = index + 1;
    const matches = matchesOf(document, action, n);
    if (matches.length === 0) {
      notes.push({ tool: undefined, message: `Overlay action ${n} matched nothing: ${action.target}.` });
      return;
    }
    if (action.remove) {
      remove(document, matches, n);
      return;
    }
    if (action.update === undefined) {
      notes.push({ tool: undefined, message: `Overlay action ${n} has no update and no remove, so import skipped it.` });
      return;
    }
    for (const match of matches) {
      if (Array.isArray(match.value)) {
        match.value.push(copyJson(action.update, budget, OVERLAY_FILE));
      } else if (isRecord(match.value) && isRecord(action.update)) {
        mergeInto(match.value, action.update, budget);
      } else {
        notes.push({
          tool: undefined,
          message: `Overlay action ${n} cannot update ${describe(match.path)}: an update merges into an object or appends to an array.`,
        });
      }
    }
  });
}
