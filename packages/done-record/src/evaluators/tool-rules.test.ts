// tool-rules.test.ts: a tool rule matches a recorded call by tool name, by path
// glob for a path tool, and by flat glob for a Bash command or any other input.
import { describe, expect, it } from "vitest";
import {
  callWithinCapabilities,
  denyRuleMatches,
  firstDenyRule,
  parseToolRule,
} from "./tool-rules";
import type { ToolCallRecord } from "./types";

const bash = (command: string): ToolCallRecord => ({ tool: "Bash", input: { command } });
const read = (file_path: string): ToolCallRecord => ({ tool: "Read", input: { file_path } });

describe("parseToolRule", () => {
  it("reads a bare tool name", () => {
    expect(parseToolRule("WebFetch")).toEqual({ tool: "WebFetch" });
  });

  it("reads a tool name and a pattern", () => {
    expect(parseToolRule(" Bash(curl *) ")).toEqual({ tool: "Bash", pattern: "curl *" });
  });

  it("returns undefined for text that is not a rule", () => {
    expect(parseToolRule("bad rule((")).toBeUndefined();
  });
});

describe("denyRuleMatches", () => {
  it("matches a bare tool name and no other tool", () => {
    expect(denyRuleMatches("WebFetch", { tool: "WebFetch", input: {} })).toBe(true);
    expect(denyRuleMatches("WebFetch", { tool: "WebSearch", input: {} })).toBe(false);
  });

  it("reads the tool name as a flat glob", () => {
    const call = { tool: "mcp__github__create_issue", input: {} };
    expect(denyRuleMatches("mcp__github__*", call)).toBe(true);
    expect(denyRuleMatches("mcp__slack__*", call)).toBe(false);
  });

  it("matches a Bash pattern inside a compound command", () => {
    expect(denyRuleMatches("Bash(curl *)", bash("cd x && curl http://example.com"))).toBe(true);
    expect(denyRuleMatches("Bash(curl *)", bash("echo a; curl b"))).toBe(true);
    expect(denyRuleMatches("Bash(curl *)", bash("ls | curl -d @- x"))).toBe(true);
    expect(denyRuleMatches("Bash(curl *)", bash("echo curl"))).toBe(false);
  });

  it("matches a Bash pattern against the whole command", () => {
    expect(denyRuleMatches("Bash(*--force*)", bash("git push --force origin main"))).toBe(true);
  });

  it("reads ? as one character and escapes other regex characters", () => {
    expect(denyRuleMatches("Bash(rm -rf ?)", bash("rm -rf /"))).toBe(true);
    expect(denyRuleMatches("Bash(rm -rf ?)", bash("rm -rf //"))).toBe(false);
    expect(denyRuleMatches("Bash(cat a.txt)", bash("cat abtxt"))).toBe(false);
  });

  it("never matches a Bash call that carries no command", () => {
    expect(denyRuleMatches("Bash(*)", { tool: "Bash", input: { cwd: "/" } })).toBe(false);
  });

  it("matches a path tool's pattern as a path glob", () => {
    expect(denyRuleMatches("Read(**/.env*)", read(".env"))).toBe(true);
    expect(denyRuleMatches("Read(**/.env*)", read("a/b/.env.local"))).toBe(true);
    expect(denyRuleMatches("Read(**/.env*)", read("a/foo.env"))).toBe(false);
    expect(
      denyRuleMatches("NotebookEdit(secrets/*)", {
        tool: "NotebookEdit",
        input: { notebook_path: "secrets/a.ipynb" },
      }),
    ).toBe(true);
  });

  it("finds no path in a path tool whose input is not an object", () => {
    expect(denyRuleMatches("Read(*)", { tool: "Read", input: "a.txt" })).toBe(false);
    expect(denyRuleMatches("Read(*)", { tool: "Read", input: ["a.txt"] })).toBe(false);
    expect(denyRuleMatches("Read(*)", { tool: "Read", input: { file_path: 3 } })).toBe(false);
  });

  it("matches any other tool's pattern against its top-level strings", () => {
    const call = { tool: "WebFetch", input: { url: "https://evil.example/x", retries: 2 } };
    expect(denyRuleMatches("WebFetch(https://evil.example/*)", call)).toBe(true);
    expect(denyRuleMatches("WebFetch(https://good.example/*)", call)).toBe(false);
    expect(denyRuleMatches("Task(deploy*)", { tool: "Task", input: "deploy now" })).toBe(true);
    expect(denyRuleMatches("Task(*)", { tool: "Task", input: null })).toBe(false);
    expect(denyRuleMatches("Task(*)", { tool: "Task", input: ["x"] })).toBe(false);
  });

  it("matches a rule that does not parse only by its exact text", () => {
    expect(denyRuleMatches("bad rule((", { tool: "bad rule((", input: {} })).toBe(true);
    expect(denyRuleMatches("bad rule((", { tool: "Bash", input: { command: "x" } })).toBe(false);
  });
});

describe("firstDenyRule", () => {
  it("returns the first rule that matches, or undefined", () => {
    const rules = ["WebFetch", "Bash(curl *)", "Bash(*)"];
    expect(firstDenyRule(rules, bash("curl x"))).toBe("Bash(curl *)");
    expect(firstDenyRule(rules, read("a.ts"))).toBeUndefined();
  });
});

describe("callWithinCapabilities", () => {
  it("allows any call to a tool the set names without a pattern", () => {
    expect(callWithinCapabilities(["Read"], read("anything"))).toBe(true);
  });

  it("refuses a call to a tool the set does not name", () => {
    expect(callWithinCapabilities(["Read"], bash("ls"))).toBe(false);
  });

  it("allows a Bash call only when every command in it is inside the set", () => {
    const caps = ["Bash(pnpm test*)", "Bash(git status)"];
    expect(callWithinCapabilities(caps, bash("git status && pnpm test --run"))).toBe(true);
    expect(callWithinCapabilities(caps, bash("git status && curl http://x"))).toBe(false);
  });

  it("allows a path tool only inside its path globs", () => {
    expect(callWithinCapabilities(["Edit(src/**)"], { tool: "Edit", input: { file_path: "src/a/b.ts" } })).toBe(true);
    expect(callWithinCapabilities(["Edit(src/**)"], { tool: "Edit", input: { file_path: ".github/ci.yml" } })).toBe(false);
  });

  it("refuses a call with nothing to match when every rule has a pattern", () => {
    expect(callWithinCapabilities(["Bash(ls)"], { tool: "Bash", input: {} })).toBe(false);
  });
});
