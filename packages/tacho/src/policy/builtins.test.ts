import { describe, expect, it } from "vitest";
import {
  BUILTIN_NAMES,
  BUILTIN_TOOLS,
  CEDAR_HARNESSES,
  FALLBACK_BUILTIN,
  HARNESSES_NAMING_SKILL,
  HARNESSES_WITHOUT_SKILL,
  HARNESS_BUILTIN_MAP,
  builtinActionFor,
  harnessBuiltinActions,
  harnessNamesSkill,
  isBuiltinAction,
  isCedarHarness,
} from "./builtins";

describe("builtinActionFor", () => {
  it("decides Claude Code's Bash and Codex's shell as the same action", () => {
    expect(builtinActionFor("claude-code", "Bash")).toBe("builtin__shell");
    expect(builtinActionFor("codex", "shell")).toBe("builtin__shell");
    expect(builtinActionFor("codex", "local_shell")).toBe("builtin__shell");
    expect(builtinActionFor("cursor", "Shell")).toBe("builtin__shell");
    expect(builtinActionFor("stella", "bash")).toBe("builtin__shell");
  });

  it("maps each harness's file tools", () => {
    expect(builtinActionFor("claude-code", "Edit")).toBe("builtin__write_file");
    expect(builtinActionFor("codex", "apply_patch")).toBe("builtin__write_file");
    expect(builtinActionFor("cursor", "Delete")).toBe("builtin__write_file");
    expect(builtinActionFor("stella", "read_file")).toBe("builtin__read_file");
    expect(builtinActionFor("claude-agent-sdk", "Glob")).toBe("builtin__search_files");
    expect(builtinActionFor("claude-desktop", "WebFetch")).toBe("builtin__web_fetch");
    expect(builtinActionFor("claude-code", "Task")).toBe("builtin__start_subagent");
    expect(builtinActionFor("stella", "delegate")).toBe("builtin__start_subagent");
  });

  it("decides an unmapped tool as the shell", () => {
    expect(builtinActionFor("claude-code", "SomeNewTool")).toBe(FALLBACK_BUILTIN);
    expect(builtinActionFor("custom", "Read")).toBe("builtin__shell");
    expect(builtinActionFor("unknown-harness", "Read")).toBe("builtin__shell");
  });

  it("does not read a tool name off the map's prototype", () => {
    expect(builtinActionFor("codex", "toString")).toBe("builtin__shell");
    expect(builtinActionFor("codex", "__proto__")).toBe("builtin__shell");
  });
});

describe("harnessBuiltinActions", () => {
  it("grants every action the harness's map reaches, and the shell", () => {
    expect(harnessBuiltinActions("codex")).toEqual([
      "builtin__shell",
      "builtin__web_search",
      "builtin__write_file",
    ]);
    expect(harnessBuiltinActions("claude-code")).toEqual(
      [...BUILTIN_NAMES].map((n) => `builtin__${n}`).sort(),
    );
  });

  it("grants only the shell to a custom or unknown harness", () => {
    expect(harnessBuiltinActions("custom")).toEqual(["builtin__shell"]);
    expect(harnessBuiltinActions("not-a-harness")).toEqual(["builtin__shell"]);
  });
});

describe("the vocabulary", () => {
  it("classifies every built-in action", () => {
    for (const name of BUILTIN_NAMES) {
      expect(isBuiltinAction(`builtin__${name}`)).toBe(true);
      expect(BUILTIN_TOOLS[`builtin__${name}`].version).toBe(1);
    }
    expect(isBuiltinAction("builtin__teleport")).toBe(false);
    expect(isBuiltinAction("billing__create_refund")).toBe(false);
  });

  it("maps every harness to built-in names only", () => {
    for (const harness of CEDAR_HARNESSES) {
      expect(isCedarHarness(harness)).toBe(true);
      for (const name of Object.values(HARNESS_BUILTIN_MAP[harness])) {
        expect(BUILTIN_NAMES).toContain(name);
      }
    }
    expect(isCedarHarness("vim")).toBe(false);
  });

  it("names the harnesses that never name a subagent's skill", () => {
    expect(HARNESSES_NAMING_SKILL).toEqual(["claude-code", "claude-agent-sdk"]);
    expect(HARNESSES_WITHOUT_SKILL).toEqual([
      "claude-desktop",
      "codex",
      "cursor",
      "stella",
      "custom",
    ]);
    expect(harnessNamesSkill("claude-code")).toBe(true);
    expect(harnessNamesSkill("codex")).toBe(false);
  });
});
