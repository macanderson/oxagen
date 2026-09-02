// tools.auth-gate.test.ts — every MCP tool must resolve a real principal.
//
// The transport-layer gate in src/middleware.ts (`apiKeyAuthMiddleware`)
// deliberately does NOT authenticate. Its `validateApiKey` only checks that the
// Authorization header is a well-formed `Bearer <token>` — any non-empty token
// passes. The authoritative check (API key -> org/workspace scope, fail-closed
// on invalid/expired) lives in `buildContext()`, which each tool calls for
// itself.
//
// That split is a deliberate trade (one DB lookup per request instead of two),
// but it means a tool that forgets `await buildContext(headers())` executes for
// any caller who sends `Authorization: Bearer x` — with no context to scope it
// and no audit row. Nothing in the type system or the xmcp runtime catches the
// omission. This guard does: it walks every tool file on disk and asserts the
// call is present.
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

describe("mcp tool auth gate", () => {
  it("discovers the tool directory (sanity: the glob still matches something)", () => {
    expect(toolFiles.length).toBeGreaterThan(100);
  });

  for (const file of toolFiles) {
    it(`${file} resolves a principal via buildContext(headers())`, () => {
      const source = readFileSync(join(toolsDir, file), "utf8");
      // Both halves matter: `headers()` supplies the request's Authorization
      // header, and `buildContext` is what turns it into a scoped context or
      // throws McpUnauthorizedError.
      expect(source).toContain("buildContext(headers())");
    });
  }
});
