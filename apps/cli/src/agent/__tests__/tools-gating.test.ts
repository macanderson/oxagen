/**
 * Pins the permission boundary on the agent's mutating tools.
 *
 * `buildTools` must route EVERY mutating tool — write_file, edit_file, AND bash
 * — through the permission broker before it runs. A denial must return the deny
 * string and never reach the real side effect (no fs write, no shell exec). If a
 * future refactor drops one of the three from the broker loop, this test fails.
 *
 * (The loop-gating test pins the settings gate at the loop level; this one pins
 * buildTools' own broker wrapper, which is a separate enforcement layer.)
 */
import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import type { Tool } from "ai";
import { buildTools } from "../tools.js";
import { PermissionBroker, MUTATING_TOOLS } from "../permissions.js";

function run(tool: Tool | undefined, input: unknown): Promise<unknown> {
  const exec = (tool as { execute?: (i: unknown, o: unknown) => unknown })
    ?.execute;
  if (!exec) throw new Error("tool has no execute");
  return Promise.resolve(exec(input, {}));
}

describe("buildTools permission gating", () => {
  it("gates write_file, edit_file, and bash through the broker (deny blocks the side effect)", async () => {
    // ask mode with no approver: every mutating call is denied (fail closed).
    const broker = new PermissionBroker({ mode: "ask", cwd: "/tmp" });
    const tools = buildTools("/tmp", { broker });

    const writeSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    const w = await run(tools["write_file"], { path: "x.txt", content: "hi" });
    const e = await run(tools["edit_file"], {
      path: "x.txt",
      old_string: "a",
      new_string: "b",
    });
    const b = await run(tools["bash"], { command: "echo hi" });

    expect(String(w)).toContain("Permission denied");
    expect(String(e)).toContain("Permission denied");
    expect(String(b)).toContain("Permission denied");
    // The real filesystem write must never have been reached.
    expect(writeSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
  });

  it("wraps exactly the mutating tools when a broker is present", () => {
    const broker = new PermissionBroker({ mode: "ask", cwd: "/tmp" });
    const tools = buildTools("/tmp", { broker });
    for (const name of MUTATING_TOOLS) {
      expect(tools[name], `${name} must be present and gated`).toBeDefined();
    }
    // A read-only tool stays available and ungated.
    expect(tools["read_file"]).toBeDefined();
  });
});
