// tools.result-shape.test.ts — every MCP tool must answer with a CallToolResult.
//
// xmcp 0.6.13 turns a returned object into `structuredContent` only when the
// tool's metadata declares an `outputSchema`. None of ours does, so a tool
// that returns its parsed output as a plain object fails every call with
// "Tool handler must return at least 'content' or 'structuredContent'"
// (#5463). Typecheck and the per-tool tests do not catch that: the plain
// object is a valid return type, and the tests call the default export
// directly, never through xmcp. This guard walks every tool file on disk and
// asserts its default export returns through toolResult() in
// src/tool-result.ts.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const toolsDir = fileURLToPath(new URL("./tools", import.meta.url));

/**
 * Tool files xmcp registers: every `.ts` under src/tools/ except test files and
 * `_`-prefixed shared helpers, which xmcp's discovery also skips.
 */
const toolFiles = readdirSync(toolsDir)
  .filter((name) => name.endsWith(".ts"))
  .filter((name) => !name.endsWith(".test.ts"))
  .filter((name) => !name.startsWith("_"))
  .sort();

/** The source from `export default` to the end of the file. */
function defaultExport(source: string): string {
  const start = source.indexOf("export default");
  return start === -1 ? "" : source.slice(start);
}

/** Each line of the source that starts with a `return` statement. */
function returnLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^return\b/.test(line));
}

describe("mcp tool result shape", () => {
  it("discovers the tool directory (sanity: the glob still matches something)", () => {
    expect(toolFiles.length).toBeGreaterThan(100);
  });

  it("reads a plain-object return as a failure (sanity: the check bites)", () => {
    const bare = [
      "export default async function tool(args: Args) {",
      "  const ctx = await buildContext(headers());",
      "  return contract.output.parse(await invoke(name, args, ctx));",
      "}",
    ].join("\n");
    const lines = returnLines(defaultExport(bare));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/^return toolResult\(/);
  });

  for (const file of toolFiles) {
    it(`${file} returns through toolResult()`, () => {
      const source = readFileSync(join(toolsDir, file), "utf8");
      expect(source).toContain('import { toolResult } from "../tool-result";');
      const body = defaultExport(source);
      expect(body).not.toBe("");
      // At least one return, so an arrow default with an implicit return
      // fails here, and every return goes through the helper.
      const lines = returnLines(body);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/^return toolResult\(/);
      }
    });
  }
});
