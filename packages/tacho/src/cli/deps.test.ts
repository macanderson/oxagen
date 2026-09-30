import { describe, expect, it, vi } from "vitest";
import { cursorAppFacts, cursorFacts, runtimeCommands } from "./deps";

/** A machine where no executable is on PATH and nothing is on disk. */
const bareExec = (): { stdout: string; stderr: string; status: number } => ({
  stdout: "",
  stderr: "",
  status: 1,
});

describe("Cursor detection", () => {
  it("does not identify an unrelated generic agent with a semver as Cursor", () => {
    const exec = vi.fn((command: string, args: string[]) => ({
      stdout:
        command === "/usr/bin/agent"
          ? "Other Agent 1.2.3"
          : args.includes("command -v agent")
            ? "/usr/bin/agent"
            : "",
      stderr: "",
      status: 0,
    }));
    expect(cursorFacts(exec, "linux", {}, "/home/test", () => false)).toEqual(
      {},
    );
    expect(
      exec.mock.calls.some(([command]) => command === "/usr/bin/agent"),
    ).toBe(false);
  });

  it("reports the specific Cursor alias", () => {
    const exec = vi.fn((command: string) => ({
      stdout:
        command === "/usr/bin/cursor-agent"
          ? "Cursor 1.2.3"
          : "/usr/bin/cursor-agent",
      stderr: "",
      status: 0,
    }));
    expect(cursorFacts(exec, "linux", {}, "/home/test", () => false)).toEqual({
      path: "/usr/bin/cursor-agent",
      version: "1.2.3",
    });
  });

  it("reports the macOS application when the CLI alias is absent", () => {
    const facts = cursorFacts(
      bareExec,
      "darwin",
      {},
      "/Users/test",
      (candidate) => candidate === "/Applications/Cursor.app",
    );
    expect(facts).toEqual({
      app: { installed: true, path: "/Applications/Cursor.app" },
    });
    expect(facts.path).toBeUndefined();
    expect(facts.version).toBeUndefined();
  });

  it("reports the Windows application when the CLI alias is absent", () => {
    const facts = cursorFacts(
      bareExec,
      "win32",
      { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      "C:\\Users\\test",
      (candidate) =>
        candidate === "C:\\Users\\test\\AppData\\Local\\Programs\\cursor",
    );
    expect(facts.app).toEqual({
      installed: true,
      path: "C:\\Users\\test\\AppData\\Local\\Programs\\cursor",
    });
  });

  it("keeps the executable path off the application signal", () => {
    const exec = vi.fn((command: string) => ({
      stdout:
        command === "/usr/local/bin/cursor-agent"
          ? "Cursor 2.0.1"
          : "/usr/local/bin/cursor-agent",
      stderr: "",
      status: 0,
    }));
    const facts = cursorFacts(
      exec,
      "darwin",
      {},
      "/Users/test",
      (candidate) => candidate === "/Applications/Cursor.app",
    );
    expect(facts.path).toBe("/usr/local/bin/cursor-agent");
    expect(facts.version).toBe("2.0.1");
    expect(facts.app).toEqual({
      installed: true,
      path: "/Applications/Cursor.app",
    });
  });

  it("guesses no Linux install location", () => {
    expect(cursorAppFacts("linux", "/home/test", {}, () => true)).toEqual({
      installed: false,
    });
    expect(
      cursorFacts(bareExec, "linux", {}, "/home/test", () => true),
    ).toEqual({});
  });

  it("reports neither signal on a machine without Cursor", () => {
    expect(
      cursorFacts(bareExec, "darwin", {}, "/Users/test", () => false),
    ).toEqual({});
  });
});

/**
 * ADR-230: the desktop app hands `tacho` its versioned per-user copy in
 * `TACHO_BIN_DIR`, and every command names that copy, never the bundle the
 * sidecar runs from.
 */
describe("the desktop app's per-user copy", () => {
  const bundle = "/Applications/Oxagen.app/Contents/MacOS/tacho";
  const kept = "/Users/dev/Library/Application Support/oxagen/bin/2.1.4-17";

  it("names the copy in every command while the bundle runs", () => {
    const runtime = runtimeCommands(
      undefined,
      { TACHO_BIN_DIR: kept },
      bundle,
      "darwin",
      true,
      (candidate) => candidate === `${kept}/tacho` || candidate === bundle,
    );
    expect(runtime.binDir).toBe(kept);
    expect(runtime.hookCommand).toBe(`'${kept}/tacho' hook`);
    expect(runtime.credentialHelperCommand).toBe(
      `'${kept}/tacho' credential issue --harness claude-code`,
    );
    expect(runtime.daemonCommand).toEqual([`${kept}/tacho`, "daemon"]);
    expect(runtime.mcpStdioCommand).toEqual([`${kept}/tacho`, "mcp-stdio"]);
    expect(runtime).not.toHaveProperty("executableProblem");
    expect(runtime).not.toHaveProperty("transient");
    for (const command of [
      runtime.hookCommand,
      runtime.credentialHelperCommand,
      ...runtime.daemonCommand,
      ...runtime.mcpStdioCommand,
    ])
      expect(command).not.toContain("Oxagen.app");
  });

  it("refuses rather than name the bundle before the copy is made", () => {
    // The launch copies the sidecars off the main thread. An enroll that
    // ran before the copy landed fell back to this process, which is the
    // bundle's sidecar, and wrote the bundle into every hook.
    const runtime = runtimeCommands(
      undefined,
      { TACHO_BIN_DIR: kept },
      bundle,
      "darwin",
      true,
      (candidate) => candidate === bundle,
    );
    expect(runtime.executableProblem).toBe(
      `TACHO_BIN_DIR names ${kept}, which holds no tacho`,
    );
    expect(runtime.hookCommand).not.toContain("Oxagen.app");
  });

  it("still names a Scoop install by its release asset's name", () => {
    // No TACHO_BIN_DIR: the running binary is the one to name.
    const scoop =
      "C:\\Users\\dev\\scoop\\apps\\tacho\\current\\tacho-x86_64-pc-windows-msvc.exe";
    const runtime = runtimeCommands(
      undefined,
      {},
      scoop,
      "win32",
      true,
      () => false,
    );
    expect(runtime.daemonCommand).toEqual([scoop, "daemon"]);
    expect(runtime).not.toHaveProperty("executableProblem");
  });
});
