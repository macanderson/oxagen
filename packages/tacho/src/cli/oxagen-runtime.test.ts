/**
 * `oxagenRuntimeCommands` (#4879): what the hooks and the service run when
 * the `oxagen` CLI enrolls a machine. Each command names the `oxagen`
 * executable running now, never a bare name a PATH lookup would have to find.
 */
import { describe, expect, it } from "vitest";
import { oxagenRuntimeCommands } from "./deps";

const nothing = () => false;

describe("oxagenRuntimeCommands", () => {
  it("names the compiled executable itself", () => {
    const runtime = oxagenRuntimeCommands(
      "/Users/dev/.local/bin/oxagen",
      {},
      "/Users/dev/Library/Application Support/oxagen/bin/2.1.4/oxagen",
      "darwin",
      true,
      nothing,
    );
    const exe = "/Users/dev/Library/Application Support/oxagen/bin/2.1.4/oxagen";
    expect(runtime).toEqual({
      hookCommand: `'${exe}' hook`,
      credentialHelperCommand: `'${exe}' credential issue --harness claude-code`,
      daemonCommand: [exe, "daemon"],
      mcpStdioCommand: [exe, "mcp-stdio"],
      binDir: "/Users/dev/Library/Application Support/oxagen/bin/2.1.4",
      program: "oxagen",
    });
  });

  it("follows Homebrew's stable path rather than the versioned cellar", () => {
    const runtime = oxagenRuntimeCommands(
      undefined,
      {},
      "/opt/homebrew/Cellar/oxagen/2.1.4/bin/oxagen",
      "darwin",
      true,
      (candidate) => candidate === "/opt/homebrew/opt/oxagen/bin/oxagen",
    );
    expect(runtime.hookCommand).toBe("/opt/homebrew/opt/oxagen/bin/oxagen hook");
    expect(runtime.daemonCommand).toEqual([
      "/opt/homebrew/opt/oxagen/bin/oxagen",
      "daemon",
    ]);
  });

  it("runs the bundle with this node, from an npm install", () => {
    const runtime = oxagenRuntimeCommands(
      "/usr/local/lib/node_modules/@oxagen/cli/oxagen.mjs",
      {},
      "/usr/local/bin/node",
      "linux",
      false,
      nothing,
    );
    expect(runtime).toMatchObject({
      hookCommand:
        "/usr/local/bin/node /usr/local/lib/node_modules/@oxagen/cli/oxagen.mjs hook",
      daemonCommand: [
        "/usr/local/bin/node",
        "/usr/local/lib/node_modules/@oxagen/cli/oxagen.mjs",
        "daemon",
      ],
      mcpStdioCommand: [
        "/usr/local/bin/node",
        "/usr/local/lib/node_modules/@oxagen/cli/oxagen.mjs",
        "mcp-stdio",
      ],
      binDir: "/usr/local/lib/node_modules/@oxagen/cli",
      program: "oxagen",
    });
  });

  it("runs the bundle with Homebrew's opt node, which brew upgrade keeps", () => {
    // A versioned formula keeps its `@` in both paths.
    const cellar = "/opt/homebrew/Cellar/node@22/22.9.0/bin/node";
    const opt = "/opt/homebrew/opt/node@22/bin/node";
    const entry = "/opt/homebrew/lib/node_modules/@oxagen/cli/oxagen.mjs";
    const runtime = oxagenRuntimeCommands(
      entry,
      {},
      cellar,
      "darwin",
      false,
      (candidate) => candidate === opt,
    );
    expect(runtime).toEqual({
      hookCommand: `${opt} ${entry} hook`,
      credentialHelperCommand: `${opt} ${entry} credential issue --harness claude-code`,
      daemonCommand: [opt, entry, "daemon"],
      mcpStdioCommand: [opt, entry, "mcp-stdio"],
      binDir: "/opt/homebrew/lib/node_modules/@oxagen/cli",
      program: "oxagen",
    });
    // No opt link: the path it has is the best there is.
    expect(
      oxagenRuntimeCommands(entry, {}, cellar, "darwin", false, nothing)
        .daemonCommand,
    ).toEqual([cellar, entry, "daemon"]);
  });

  it("quotes a Windows path for cmd.exe", () => {
    const runtime = oxagenRuntimeCommands(
      undefined,
      {},
      "C:\\Program Files\\Oxagen\\oxagen.exe",
      "win32",
      true,
      nothing,
    );
    expect(runtime.hookCommand).toBe(
      '"C:\\Program Files\\Oxagen\\oxagen.exe" hook',
    );
  });

  it("flags a bin dir that is gone once the process exits", () => {
    const runtime = oxagenRuntimeCommands(
      undefined,
      {},
      "/Volumes/Oxagen/Oxagen.app/Contents/MacOS/oxagen",
      "darwin",
      true,
      nothing,
    );
    expect(runtime.transient).toBe("a mounted disk image");
  });

  it("names the copy TACHO_BIN_DIR points at, never the bundle it runs from", () => {
    const kept = "/Users/dev/Library/Application Support/oxagen/bin/2.1.4";
    const runtime = oxagenRuntimeCommands(
      undefined,
      { TACHO_BIN_DIR: kept },
      "/Applications/Oxagen.app/Contents/MacOS/oxagen",
      "darwin",
      true,
      (candidate) => candidate === `${kept}/oxagen`,
    );
    expect(runtime.daemonCommand).toEqual([`${kept}/oxagen`, "daemon"]);
    expect(runtime.executableProblem).toBeUndefined();
    // Before the app has made its copy, enrolling is refused, not pointed at
    // the bundle.
    const early = oxagenRuntimeCommands(
      undefined,
      { TACHO_BIN_DIR: kept },
      "/Applications/Oxagen.app/Contents/MacOS/oxagen",
      "darwin",
      true,
      nothing,
    );
    expect(early.executableProblem).toBe(
      `TACHO_BIN_DIR names ${kept}, which holds no oxagen`,
    );
    expect(early.hookCommand).not.toContain("/Applications/");
  });

  it("falls back to the recorder's own layout from source, which nothing moves a machine to", () => {
    const runtime = oxagenRuntimeCommands(
      "/repo/apps/cli/src/index.ts",
      {},
      "/usr/local/bin/node",
      "darwin",
      false,
      nothing,
    );
    expect(runtime.program).toBeUndefined();
    expect(runtime.hookCommand).toContain("tacho-hook.mjs");
  });
});
