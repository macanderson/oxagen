import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMcpServer,
  removeMcpServer,
  setMcpServerDisabled,
  findServerScope,
} from "../mcp-write.js";
import { loadSettings, clearSettingsCache } from "../resolve.js";

let dir: string;
let userPath: string;

const ctx = () => ({ cwd: dir, userSettingsPath: userPath });
const resolve = () => loadSettings({ ...ctx(), noCache: true }).settings;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-mcpwrite-"));
  userPath = join(dir, "user-settings.json");
  clearSettingsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSettingsCache();
});

describe("writeMcpServer", () => {
  it("adds a stdio server to the project scope", () => {
    writeMcpServer({
      ...ctx(),
      name: "fs",
      config: { transport: "stdio", command: "npx", args: ["-y", "server-fs"] },
    });
    const fs = resolve().mcpServers?.fs;
    expect(fs?.transport).toBe("stdio");
    if (fs?.transport === "stdio") expect(fs.command).toBe("npx");
  });

  it("adds an http server to a chosen scope", () => {
    writeMcpServer({
      ...ctx(),
      scope: "local",
      name: "remote",
      config: {
        transport: "streamable-http",
        url: "https://mcp.example.com",
        auth: "none",
      },
    });
    expect(findServerScope("remote", ctx())?.scope).toBe("local");
  });
});

describe("findServerScope", () => {
  it("returns the highest-precedence scope that defines a server", () => {
    writeMcpServer({
      ...ctx(),
      scope: "project",
      name: "s",
      config: { transport: "stdio", command: "a", args: [] },
    });
    writeMcpServer({
      ...ctx(),
      scope: "local",
      name: "s",
      config: { transport: "stdio", command: "b", args: [] },
    });
    expect(findServerScope("s", ctx())?.scope).toBe("local");
  });

  it("returns null when the server is unknown", () => {
    expect(findServerScope("ghost", ctx())).toBeNull();
  });
});

describe("removeMcpServer", () => {
  it("removes an existing server (auto-detecting its scope)", () => {
    writeMcpServer({
      ...ctx(),
      scope: "project",
      name: "s",
      config: { transport: "stdio", command: "a", args: [] },
    });
    const res = removeMcpServer({ ...ctx(), name: "s" });
    expect(res.found).toBe(true);
    expect(resolve().mcpServers?.s).toBeUndefined();
  });

  it("reports not-found for an unknown server", () => {
    expect(removeMcpServer({ ...ctx(), name: "ghost" }).found).toBe(false);
  });
});

describe("setMcpServerDisabled", () => {
  it("toggles the disabled flag", () => {
    writeMcpServer({
      ...ctx(),
      name: "s",
      config: { transport: "stdio", command: "a", args: [] },
    });
    expect(
      setMcpServerDisabled({ ...ctx(), name: "s", disabled: true }).found,
    ).toBe(true);
    const s = resolve().mcpServers?.s;
    expect(s && "disabled" in s && s.disabled).toBe(true);
    setMcpServerDisabled({ ...ctx(), name: "s", disabled: false });
    const s2 = resolve().mcpServers?.s;
    expect(s2 && "disabled" in s2 && s2.disabled).toBe(false);
  });

  it("reports not-found for an unknown server", () => {
    expect(
      setMcpServerDisabled({ ...ctx(), name: "ghost", disabled: true }).found,
    ).toBe(false);
  });
});
