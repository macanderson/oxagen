// The agent definition's TOML subset: what a definition file carries parses to
// the values it names, and every refusal names its code and its one-based
// line, so the editor can point at it.
import { describe, expect, it } from "vitest";
import { parseTomlSubset, tomlGet } from "./toml-subset";

const DEFINITION = `# .oxagen/agents/release-bot.toml
schema = "agent-definition/v0.1"
slug = "release-bot"
name = 'Release bot'
description = "Cuts releases.\\nOpens a \\"pull request\\"."
model_tier = "complex"
tools = ["github__*", "linear__get_issue"]
deny_tools = [ "github__delete_*@*", ]
side_effects = ["read", "write"]  # a comment after a value
budget = { per_run_micros = 2_500_000, hard = true }
ratio = -1.5e2

[instructions]
body = """
You prepare releases.
Open a pull request; a person merges it.
"""

[harness.claude-code]
color = "blue"
"quoted.key" = 1
`;

describe("parseTomlSubset", () => {
  it("reads every form a definition file uses", () => {
    expect(parseTomlSubset(DEFINITION)).toEqual({
      ok: true,
      doc: {
        schema: "agent-definition/v0.1",
        slug: "release-bot",
        name: "Release bot",
        description: 'Cuts releases.\nOpens a "pull request".',
        model_tier: "complex",
        tools: ["github__*", "linear__get_issue"],
        deny_tools: ["github__delete_*@*"],
        side_effects: ["read", "write"],
        budget: { per_run_micros: 2500000, hard: true },
        ratio: -150,
        instructions: {
          body: "You prepare releases.\nOpen a pull request; a person merges it.\n",
        },
        harness: { "claude-code": { color: "blue", quoted: { key: 1 } } },
      },
    });
  });

  it("reads a one-line multi-line string, dotted keys, nested arrays and CRLF line ends", () => {
    expect(
      parseTomlSubset(
        'a.b = """one line"""\r\nlist = [[1, 2], []]\r\n[t]\r\nx = false\r\n',
      ),
    ).toEqual({
      ok: true,
      doc: { a: { b: "one line" }, list: [[1, 2], []], t: { x: false } },
    });
  });

  it("an empty file and a file of comments are an empty table", () => {
    expect(parseTomlSubset("")).toEqual({ ok: true, doc: {} });
    expect(parseTomlSubset("# only\n\n   # comments\n")).toEqual({
      ok: true,
      doc: {},
    });
  });

  it("keeps __proto__ and constructor as plain keys of the file (negative)", () => {
    const parsed = parseTomlSubset('__proto__ = "x"\n[constructor]\ny = 1\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(tomlGet(parsed.doc, "__proto__")).toBe("x");
    expect(tomlGet(parsed.doc, "constructor")).toEqual({ y: 1 });
    expect(Object.getPrototypeOf(parsed.doc)).toBe(Object.prototype);
    expect(tomlGet(parsed.doc, "toString")).toBeUndefined();
  });

  it.each([
    ['name = "open', "unterminated_string", 1],
    ["name = 'open", "unterminated_string", 1],
    ['a = 1\nbody = """\nnever closed', "unterminated_string", 2],
    ["tools = [1, 2", "unterminated_array", 1],
    ["tools = [1 2]", "array_separator", 1],
    ["t = { = 1 }", "inline_table_key", 1],
    ["t = { a = 1 b = 2 }", "inline_table_separator", 1],
    ["a = 1\nname =", "missing_value", 2],
    ["name = bare", "unreadable_value", 1],
    ['x = ["""a"""]', "unreadable_value", 1],
    ["\n\njust words", "expected_key_value", 3],
    ["a = 1 2", "text_after_value", 1],
  ] as const)(
    "refuses %j with %s at line %i (negative)",
    (text, code, line) => {
      expect(parseTomlSubset(text)).toEqual({ ok: false, code, line });
    },
  );
});
