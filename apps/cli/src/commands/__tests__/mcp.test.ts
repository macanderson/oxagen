import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mcpAdd,
  mcpList,
  mcpRemove,
  mcpSetEnabled,
  mcpCheck,
  type McpCtx,
} from "../mcp.js";
import { captureWriter } from "../../lib/capture-writer.js";

let dir: string;
let ctx: McpCtx;
// Every handler under test takes an optional trailing `CommandWriter` (see
// lib/capture-writer.ts — the REPL inline capture-execution seam, PR C item
// 11) instead of writing straight to `console.log`/`console.error`/
// `process.stdout`. Capture through that writer directly — it's the real
// seam every call site now goes through.
let writer: ReturnType<typeof captureWriter>["writer"];
let text: () => string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-mcp-"));
  ctx = { cwd: dir, userSettingsPath: join(dir, "user-settings.json") };
  const cap = captureWriter();
  writer = cap.writer;
  text = cap.output;
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** Start a fresh capture for the next call within a multi-step test. */
function resetCapture(): void {
  const cap = captureWriter();
  writer = cap.writer;
  text = cap.output;
}

describe("mcp command handlers", () => {
  it("adds a stdio server, then lists it", () => {
    mcpAdd("fs", { command: "npx", arg: ["-y", "server-fs"] }, ctx, writer);
    expect(text()).toContain('Added MCP server "fs" (stdio)');
    resetCapture();
    mcpList(ctx, writer);
    expect(text()).toContain("fs");
    expect(text()).toContain("npx -y server-fs");
    expect(text()).toContain("(project)");
  });

  it("adds an http server with bearer auth and reminds about the token", () => {
    mcpAdd(
      "gh",
      { url: "https://mcp.example.com", auth: "bearer", envToken: "GH_TOKEN" },
      ctx,
      writer,
    );
    expect(text()).toContain('Added MCP server "gh" (streamable-http)');
    expect(text()).toContain("export GH_TOKEN");
  });

  it("errors when neither --command nor --url is given", () => {
    mcpAdd("bad", {}, ctx, writer);
    expect(text()).toContain("either --command");
    expect(process.exitCode).toBe(1);
  });

  it("errors on an unknown scope", () => {
    mcpAdd("x", { command: "true", scope: "bogus" }, ctx, writer);
    expect(text()).toContain("Unknown scope");
    expect(process.exitCode).toBe(1);
  });

  it("errors on a bad transport", () => {
    mcpAdd(
      "x",
      { url: "https://e.com", transport: "carrier-pigeon" },
      ctx,
      writer,
    );
    expect(text()).toContain("--transport must be");
    expect(process.exitCode).toBe(1);
  });

  it("lists nothing when empty", () => {
    mcpList(ctx, writer);
    expect(text()).toContain("No MCP servers configured");
  });

  it("removes a server, and reports not-found otherwise", () => {
    mcpAdd("fs", { command: "true" }, ctx, writer);
    resetCapture();
    mcpRemove("fs", undefined, ctx, writer);
    expect(text()).toContain('Removed MCP server "fs"');

    resetCapture();
    mcpRemove("ghost", undefined, ctx, writer);
    expect(text()).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("enables and disables a server", () => {
    mcpAdd("fs", { command: "true" }, ctx, writer);
    resetCapture();
    mcpSetEnabled("fs", false, undefined, ctx, writer);
    expect(text()).toContain('Disabled MCP server "fs"');
    resetCapture();
    mcpSetEnabled("fs", true, undefined, ctx, writer);
    expect(text()).toContain('Enabled MCP server "fs"');
  });

  it("check reports not-found for an unknown server without connecting", async () => {
    await mcpCheck("ghost", ctx, writer);
    expect(text()).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("check says nothing to do when no servers are enabled", async () => {
    await mcpCheck(undefined, ctx, writer);
    expect(text()).toContain("No enabled MCP servers");
  });
});
