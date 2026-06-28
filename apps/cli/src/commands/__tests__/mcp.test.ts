import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

let dir: string;
let ctx: McpCtx;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-mcp-"));
  ctx = { cwd: dir, userSettingsPath: join(dir, "user-settings.json") };
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const text = () => out.join("\n");

describe("mcp command handlers", () => {
  it("adds a stdio server, then lists it", () => {
    mcpAdd("fs", { command: "npx", arg: ["-y", "server-fs"] }, ctx);
    expect(text()).toContain('Added MCP server "fs" (stdio)');
    out = [];
    mcpList(ctx);
    expect(text()).toContain("fs");
    expect(text()).toContain("npx -y server-fs");
    expect(text()).toContain("(project)");
  });

  it("adds an http server with bearer auth and reminds about the token", () => {
    mcpAdd("gh", { url: "https://mcp.example.com", auth: "bearer", envToken: "GH_TOKEN" }, ctx);
    expect(text()).toContain('Added MCP server "gh" (streamable-http)');
    expect(text()).toContain("export GH_TOKEN");
  });

  it("errors when neither --command nor --url is given", () => {
    mcpAdd("bad", {}, ctx);
    expect(err.join("\n")).toContain("either --command");
    expect(process.exitCode).toBe(1);
  });

  it("errors on an unknown scope", () => {
    mcpAdd("x", { command: "true", scope: "bogus" }, ctx);
    expect(err.join("\n")).toContain("Unknown scope");
    expect(process.exitCode).toBe(1);
  });

  it("errors on a bad transport", () => {
    mcpAdd("x", { url: "https://e.com", transport: "carrier-pigeon" }, ctx);
    expect(err.join("\n")).toContain("--transport must be");
    expect(process.exitCode).toBe(1);
  });

  it("lists nothing when empty", () => {
    mcpList(ctx);
    expect(text()).toContain("No MCP servers configured");
  });

  it("removes a server, and reports not-found otherwise", () => {
    mcpAdd("fs", { command: "true" }, ctx);
    out = [];
    mcpRemove("fs", undefined, ctx);
    expect(text()).toContain('Removed MCP server "fs"');

    mcpRemove("ghost", undefined, ctx);
    expect(err.join("\n")).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("enables and disables a server", () => {
    mcpAdd("fs", { command: "true" }, ctx);
    out = [];
    mcpSetEnabled("fs", false, undefined, ctx);
    expect(text()).toContain('Disabled MCP server "fs"');
    out = [];
    mcpSetEnabled("fs", true, undefined, ctx);
    expect(text()).toContain('Enabled MCP server "fs"');
  });

  it("check reports not-found for an unknown server without connecting", async () => {
    await mcpCheck("ghost", ctx);
    expect(err.join("\n")).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("check says nothing to do when no servers are enabled", async () => {
    await mcpCheck(undefined, ctx);
    expect(text()).toContain("No enabled MCP servers");
  });
});
