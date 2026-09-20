// The Configuration form's writer: one key patched in place with every other
// byte kept, a missing key or section appended where it belongs, and a
// multi-line value the subset parser reads back to the same text.
import { describe, expect, it } from "vitest";
import {
  tomlLiteral,
  tomlMultiline,
  tomlSet,
  tomlTableForm,
} from "./toml-patch";
import { parseTomlSubset } from "./toml-subset";

const FILE = `# release-bot
schema = "agent-definition/v0.1"
slug = "release-bot"
name = "Release bot" # shown on the list
tools = ["github__*"]

[instructions]
body = """
Cut the release.
"""

[harness.claude-code]
color = "blue"
`;

describe("tomlLiteral", () => {
  it("writes strings, numbers, booleans, arrays and inline tables", () => {
    expect(tomlLiteral('a "b"\nc\\d')).toBe('"a \\"b\\"\\nc\\\\d"');
    expect(tomlLiteral(["x", 2, true])).toBe('["x", 2, true]');
    expect(tomlLiteral({ per_run_micros: 2500000 })).toBe(
      "{ per_run_micros = 2500000 }",
    );
  });
});

describe("tomlSet", () => {
  it("replaces a root key in place and keeps its trailing comment", () => {
    const next = tomlSet(FILE, null, "name", tomlLiteral("Releases"));
    expect(next).toBe(
      FILE.replace(
        'name = "Release bot" # shown on the list',
        'name = "Releases" # shown on the list',
      ),
    );
  });

  it("appends a missing root key before the first table, after the last key", () => {
    const next = tomlSet(
      FILE,
      null,
      "description",
      tomlLiteral("Cuts releases."),
    );
    expect(next.split("\n").slice(4, 7)).toEqual([
      'tools = ["github__*"]',
      'description = "Cuts releases."',
      "",
    ]);
  });

  it("patches a key inside a section and appends a key a section lacks", () => {
    expect(
      tomlSet(FILE, "harness.claude-code", "color", tomlLiteral("gold")),
    ).toContain('[harness.claude-code]\ncolor = "gold"\n');
    expect(
      tomlSet(FILE, "harness.claude-code", "label", tomlLiteral("bot")),
    ).toContain('[harness.claude-code]\ncolor = "blue"\nlabel = "bot"\n');
  });

  it("appends a section the file lacks at the end", () => {
    expect(tomlSet(FILE, "budget", "per_run_micros", "5")).toBe(
      `${FILE.trimEnd()}\n\n[budget]\nper_run_micros = 5\n`,
    );
  });

  it("finds a trailing comment by scanning the value, so a # inside a string stays in the value", () => {
    const src = [
      'description = "Posts to #release" # where',
      "tools = [\"a#b\", 'c#d'] # tags",
      'budget = { note = "x # y" }   ',
      "",
    ].join("\n");
    const next = tomlSet(src, null, "description", tomlLiteral("New"));
    expect(next.split("\n")[0]).toBe('description = "New" # where');
    const tools = tomlSet(src, null, "tools", tomlLiteral(["z"]));
    expect(tools.split("\n")[1]).toBe('tools = ["z"] # tags');
    // Trailing whitespace with no comment is kept, byte for byte.
    const budget = tomlSet(src, null, "budget", tomlLiteral({ note: "q" }));
    expect(budget.split("\n")[2]).toBe('budget = { note = "q" }   ');
    for (const [text, key, value] of [
      [next, "description", "New"],
      [tools, "tools", ["z"]],
      [budget, "budget", { note: "q" }],
    ] as const) {
      const parsed = parseTomlSubset(text);
      expect(parsed.ok && parsed.doc[key]).toEqual(value);
    }
  });

  it("ends a multi-line value at the same fence the parser does, not at an escaped one", () => {
    const body = 'Say """done""" when finished.';
    const once = tomlSet(FILE, "instructions", "body", tomlMultiline(body));
    const parsed = parseTomlSubset(once);
    expect(parsed.ok && parsed.doc.instructions).toEqual({ body });
    // The escaped fence inside the body is not where the value ends: a
    // second edit replaces the whole string, and leaves nothing of the old one.
    const twice = tomlSet(
      once,
      "instructions",
      "body",
      tomlMultiline("Short."),
    );
    expect(twice).toBe(
      FILE.replace(
        'body = """\nCut the release.\n"""',
        'body = """\nShort.\\\n"""',
      ),
    );
    // A fence closed on its own line keeps the comment after it.
    const inline = 'body = """one \\""" two""" # note\nnext = 1\n';
    expect(tomlSet(inline, null, "body", tomlMultiline("x"))).toBe(
      'body = """\nx\\\n""" # note\nnext = 1\n',
    );
  });

  it("patches a dotted assignment in place rather than appending a table that redefines it", () => {
    const src = [
      'name = "Release bot"',
      'harness.claude-code.color = "blue" # hue',
      "",
      "[instructions]",
      'body = "Go."',
      "",
    ].join("\n");
    const next = tomlSet(
      src,
      "harness.claude-code",
      "color",
      tomlLiteral("gold"),
    );
    expect(next).toBe(
      src.replace('color = "blue" # hue', 'color = "gold" # hue'),
    );
    const parsed = parseTomlSubset(next);
    expect(parsed.ok && parsed.doc.harness).toEqual({
      "claude-code": { color: "gold" },
    });
    // A key the dotted table lacks is written the same way, after the last
    // dotted key, since a `[harness.claude-code]` header would redefine it.
    expect(
      tomlSet(src, "harness.claude-code", "label", tomlLiteral("bot")).split(
        "\n",
      )[2],
    ).toBe('harness.claude-code.label = "bot"');
    // A dotted key under a header resolves against that header.
    const nested = '[harness]\nclaude-code.color = "blue"\n';
    expect(
      tomlSet(nested, "harness.claude-code", "color", tomlLiteral("red")),
    ).toBe('[harness]\nclaude-code.color = "red"\n');
    expect(
      tomlSet(nested, "harness.claude-code", "label", tomlLiteral("bot")),
    ).toBe(
      '[harness]\nclaude-code.color = "blue"\nclaude-code.label = "bot"\n',
    );
    // The form spells the budget key dotted at the root; both spellings meet the same line.
    const budget = "budget.per_run_micros = 1\nbudget.hard = true\n";
    expect(tomlSet(budget, null, "budget.per_run_micros", "5")).toBe(
      "budget.per_run_micros = 5\nbudget.hard = true\n",
    );
    expect(tomlSet(budget, "budget", "per_run_micros", "5")).toBe(
      "budget.per_run_micros = 5\nbudget.hard = true\n",
    );
  });

  it("matches a quoted key and keeps its spelling", () => {
    const src = '"name" = "Release bot"\n  "slug"   =   "release-bot"  # id\n';
    expect(tomlSet(src, null, "name", tomlLiteral("Releases"))).toBe(
      '"name" = "Releases"\n  "slug"   =   "release-bot"  # id\n',
    );
    expect(tomlSet(src, null, "slug", tomlLiteral("bot"))).toBe(
      '"name" = "Release bot"\n  "slug"   =   "bot"  # id\n',
    );
  });

  it("patches the line the parser's value comes from when a key is named twice, and ignores a key inside a multi-line body", () => {
    const src =
      'name = "one"\nname = "two"\nbody = """\nname = "not a key"\n[not-a-table]\n"""\n';
    const next = tomlSet(src, null, "name", tomlLiteral("three"));
    expect(next).toBe(
      'name = "one"\nname = "three"\nbody = """\nname = "not a key"\n[not-a-table]\n"""\n',
    );
    const parsed = parseTomlSubset(next);
    expect(parsed.ok && parsed.doc.name).toBe("three");
    // A missing root key goes after the body, not after the fake header inside it.
    expect(tomlSet(src, null, "slug", '"x"')).toBe(`${src}slug = "x"\n`);
  });

  it("replaces a multi-line string across its lines, and the subset reads the new value back", () => {
    const body = 'Open a PR.\nPath:\\deploy says "go".';
    const next = tomlSet(FILE, "instructions", "body", tomlMultiline(body));
    expect(next).toContain(
      'body = """\nOpen a PR.\nPath:\\\\deploy says "go".\\\n"""\n\n[harness.claude-code]',
    );
    const parsed = parseTomlSubset(next);
    expect(parsed.ok && parsed.doc.instructions).toEqual({ body });
    // A second save of the same value changes nothing.
    expect(tomlSet(next, "instructions", "body", tomlMultiline(body))).toBe(
      next,
    );
  });
});

describe("tomlTableForm", () => {
  it("names the spelling of a table, and does not read a header inside a multi-line body", () => {
    expect(tomlTableForm("[budget]\nper_run_micros = 1\n", "budget")).toBe(
      "header",
    );
    expect(tomlTableForm('budget.mode = "hard"\n', "budget")).toBe("dotted");
    expect(tomlTableForm("budget = { per_run_micros = 1 }\n", "budget")).toBe(
      "none",
    );
    expect(tomlTableForm('name = "x"\n', "budget")).toBe("none");
    expect(
      tomlTableForm(
        'budget = { per_run_micros = 1 }\nbody = """\n[budget]\nprose\n"""\n',
        "budget",
      ),
    ).toBe("none");
    // A key under a [budget] header is the header form, not the dotted one.
    expect(tomlTableForm("[budget]\nlimits.per_day = 2\n", "budget")).toBe(
      "header",
    );
  });
});
