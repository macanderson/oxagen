import { describe, expect, it, vi } from "vitest";
import { cursorFacts } from "./deps";

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
});
