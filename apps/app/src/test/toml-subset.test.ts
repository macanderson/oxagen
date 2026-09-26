// The test TOML subset: what a file carries parses to the values it names, and
// every refusal names its code and its one-based line. The fixture is a former
// agent definition file, kept because it exercises every construct.
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

  it("applies escapes and the line-ending backslash inside a multi-line string, as TOML does", () => {
    expect(
      parseTomlSubset(
        'body = """\nPath:\\\\deploy says \\"go\\".\nA fence \\""" inside.\\\n"""\nnext = 1\n',
      ),
    ).toEqual({
      ok: true,
      doc: {
        body: 'Path:\\deploy says "go".\nA fence """ inside.',
        next: 1,
      },
    });
    expect(parseTomlSubset('one = """a\\"""b"""')).toEqual({
      ok: true,
      doc: { one: 'a"""b' },
    });
  });

  it("closes a fence after an even run of backslashes, and keeps it open after an odd one", () => {
    // `\\"""`: the pair is one escaped backslash, so the fence closes.
    expect(parseTomlSubset('one = """a\\\\"""')).toEqual({
      ok: true,
      doc: { one: "a\\" },
    });
    // `\\\"""`: the third backslash escapes the first quote, so the fence stays open.
    expect(parseTomlSubset('one = """a\\\\\\"""b"""')).toEqual({
      ok: true,
      doc: { one: 'a\\"""b' },
    });
    expect(
      parseTomlSubset('body = """\nends with a backslash \\\\"""\nnext = 1\n'),
    ).toEqual({
      ok: true,
      doc: { body: "ends with a backslash \\", next: 1 },
    });
  });

  it("decodes every basic-string escape the tacho writer emits, in one-line and multi-line strings", () => {
    // `tomlBasicString` in packages/tacho/src/host/stella-writer.ts is
    // JSON.stringify, so its escapes are JSON's: this is the set it can send.
    const value =
      'tab\tnl\ncr\rbs\bff\fq"sl\\acute\u00e9smile\u{1F600}del\u007f';
    const written = JSON.stringify(value).split("\u007f").join("\\u007F");
    expect(parseTomlSubset(`s = ${written}`)).toEqual({
      ok: true,
      doc: { s: value },
    });
    expect(
      parseTomlSubset(
        's = "\\u00E9 \\U0001F600 \\b\\f"\nm = """\n\\u00e9\\f\\b\\\n"""\n',
      ),
    ).toEqual({
      ok: true,
      doc: { s: "\u00e9 \u{1F600} \b\f", m: "\u00e9\f\b" },
    });
  });

  it.each([
    ['s = "\\q"', 1],
    ['s = "\\x41"', 1],
    ['s = "\\u12"', 1],
    ['s = "\\u12G4"', 1],
    ['s = "\\U0001F60"', 1],
    ['s = "\\uD800"', 1],
    ['s = "\\U00110000"', 1],
    ['a = 1\nm = """\nfine\n\\q\n"""', 2],
    ['a = 1\nm = """x\\ey"""', 2],
  ] as const)(
    "refuses the escape in %j at line %i instead of dropping the backslash (negative)",
    (text, line) => {
      expect(parseTomlSubset(text)).toEqual({
        ok: false,
        code: "unreadable_value",
        line,
      });
    },
  );

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

  it("trims the CRLF after an opening fence, so a CRLF file's instructions do not start with a blank line", () => {
    expect(parseTomlSubset('body = """\r\nfirst\r\nsecond\r\n"""\r\n')).toEqual(
      { ok: true, doc: { body: "first\r\nsecond\r\n" } },
    );
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
