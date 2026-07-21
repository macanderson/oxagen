/**
 * cli-bridge.ts unit coverage (PR C item 11) — the REPL's inline
 * capture-execution seam that replaced the old "This is an oxagen CLI
 * command — run it from your shell" dead-end.
 */
import { describe, it, expect } from "vitest";
import {
  isExternalOnlyCliCommand,
  isInlineDispatchableCliCommand,
  runInlineCliCommand,
  toShellCommand,
} from "../cli-bridge.js";

describe("isExternalOnlyCliCommand", () => {
  it("flags the long-running/interactive top-level commands", () => {
    expect(isExternalOnlyCliCommand("daemon")).toBe(true);
    expect(isExternalOnlyCliCommand("solve")).toBe(true);
    expect(isExternalOnlyCliCommand("view")).toBe(true);
    expect(isExternalOnlyCliCommand("agents")).toBe(true);
  });

  it("covers every subcommand under an external-only top level via path prefix", () => {
    expect(isExternalOnlyCliCommand("daemon:start")).toBe(true);
    expect(isExternalOnlyCliCommand("daemon:session:list")).toBe(true);
  });

  it("does not flag the safe/read-only commands wired into REGISTRY", () => {
    expect(isExternalOnlyCliCommand("cost")).toBe(false);
    expect(isExternalOnlyCliCommand("graph:search")).toBe(false);
    expect(isExternalOnlyCliCommand("memory:list")).toBe(false);
  });

  it("does not flag `agent` (singular, named-agent-definition CRUD) — it is fast and synchronous, not long-running", () => {
    // See the NOTE in cli-bridge.ts: the audit's original list named "agent"
    // but the actual command is `oxagen agent list/show/new` — config-file
    // CRUD, same shape as `settings`/`mcp`. It just isn't wired into REGISTRY
    // yet, so it falls through to the generic "not yet available inline"
    // message rather than the external-only one.
    expect(isExternalOnlyCliCommand("agent")).toBe(false);
    expect(isExternalOnlyCliCommand("agent:list")).toBe(false);
  });
});

describe("isInlineDispatchableCliCommand", () => {
  it("recognizes every priority command family", () => {
    for (const name of [
      "cost",
      "trace",
      "models:list",
      "models:active",
      "models:pull",
      "models:status",
      "models:use",
      "graph:search",
      "memory:list",
      "memory:show",
      "memory:edit",
      "memory:salience",
      "memory:promote",
      "memory:candidates",
      "memory:rm",
      "memory:import",
      "env:list",
      "env:get",
      "env:create",
      "env:update",
      "env:rm",
      "env:set-default",
      "mcp:add",
      "mcp:list",
      "mcp:remove",
      "mcp:enable",
      "mcp:disable",
      "mcp:check",
      "logs",
      "settings",
      "settings:path",
      "settings:get",
      "settings:set",
      "settings:validate",
      "settings:init",
      "sandbox:files",
      "sandbox:cat",
      "telemetry",
    ]) {
      expect(isInlineDispatchableCliCommand(name)).toBe(true);
    }
  });

  it("accepts the cli: disambiguation prefix transparently", () => {
    expect(isInlineDispatchableCliCommand("cli:cost")).toBe(true);
  });

  it("returns false for a command not (yet) wired into the seam", () => {
    expect(isInlineDispatchableCliCommand("code:map")).toBe(false);
    expect(isInlineDispatchableCliCommand("secret:set")).toBe(false);
  });
});

describe("toShellCommand", () => {
  it("renders a bare top-level name unchanged", () => {
    expect(toShellCommand("cost")).toBe("cost");
  });

  it("turns a colon-joined subcommand path back into spaces", () => {
    expect(toShellCommand("graph:search")).toBe("graph search");
    expect(toShellCommand("mcp:add")).toBe("mcp add");
  });

  it("strips the cli: disambiguation prefix", () => {
    expect(toShellCommand("cli:config")).toBe("config");
  });
});

describe("runInlineCliCommand", () => {
  it("returns a friendly failure for a command with no adapter", async () => {
    const result = await runInlineCliCommand("code:map", "");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not wired for inline execution");
  });

  it("runs /cost with no args (deterministic, no network/FS) and captures the usage message", async () => {
    const result = await runInlineCliCommand("cost", "");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Provide token counts");
  });

  it("runs /cost --rates and captures the rate card", async () => {
    const result = await runInlineCliCommand("cost", "--rates");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Rate card");
  });

  it("surfaces a friendly usage error for a missing required flag (graph:search)", async () => {
    const result = await runInlineCliCommand("graph:search", "");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Missing -q/--query");
  });

  it("surfaces a friendly usage error for a missing positional (models:use)", async () => {
    const result = await runInlineCliCommand("models:use", "");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("usage: /models:use <id>");
  });
});
