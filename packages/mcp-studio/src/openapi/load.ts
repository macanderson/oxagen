// load.ts: the size check and the parse, before import reads any field.
import { parse as parseYaml } from "yaml";
import { OpenApiImportError, count, firstLine } from "./errors";
import { copyJson, type NodeBudget } from "./json";
import { DEFINITION_BYTES_MAX } from "./limits";

/** The UTF-8 length of a string, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Refuses a document, or an overlay, over DEFINITION_BYTES_MAX, with the size and the limit. */
export function checkSize(bytes: number, what: string): void {
  if (bytes <= DEFINITION_BYTES_MAX) return;
  throw new OpenApiImportError(
    "too_large",
    `${what} is ${count(bytes)} bytes, over the ${count(DEFINITION_BYTES_MAX)}-byte (25 MB) limit. ` +
      "Remove unused operations or examples, or split the API into two servers, then import again.",
    { limit: DEFINITION_BYTES_MAX },
  );
}

/**
 * One file's text as plain JSON. A .json file parses as JSON and anything
 * else as YAML. The copy after the parse counts nodes and depth, so a file
 * built from YAML aliases to expand without end is refused.
 */
export function parseFile(text: string, path: string, budget: NodeBudget): unknown {
  let parsed: unknown;
  try {
    parsed = path.toLowerCase().endsWith(".json")
      ? (JSON.parse(text.replace(/^\uFEFF/, "")) as unknown)
      : parseYaml(text, { logLevel: "error" });
  } catch (error) {
    throw new OpenApiImportError(
      "parse",
      `${path} is not valid ${path.toLowerCase().endsWith(".json") ? "JSON" : "YAML"}: ${firstLine(error)}. ` +
        "Fix the file and import again.",
    );
  }
  return copyJson(parsed, budget, path);
}
