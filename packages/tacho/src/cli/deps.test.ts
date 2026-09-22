import { describe, expect, it, vi } from "vitest";
import { cursorAppFacts, cursorFacts } from "./deps";

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
