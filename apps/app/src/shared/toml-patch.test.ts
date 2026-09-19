// The Configuration form's writer: one key patched in place with every other
// byte kept, a missing key or section appended where it belongs, and a
// multi-line value the subset parser reads back to the same text.
import { describe, expect, it } from "vitest";
import { tomlLiteral, tomlMultiline, tomlSet, tomlString } from "./toml-patch";
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
    expect(tomlString('a "b"\nc\\d')).toBe('"a \\"b\\"\\nc\\\\d"');
    expect(tomlLiteral(["x", 2, true])).toBe('["x", 2, true]');
    expect(tomlLiteral({ per_run_micros: 2500000 })).toBe(
      "{ per_run_micros = 2500000 }",
    );
  });
});

describe("tomlSet", () => {
  it("replaces a root key in place and keeps its trailing comment", () => {
    const next = tomlSet(FILE, null, "name", tomlString("Releases"));
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
      tomlString("Cuts releases."),
    );
    expect(next.split("\n").slice(4, 7)).toEqual([
      'tools = ["github__*"]',
      'description = "Cuts releases."',
      "",
    ]);
  });

  it("patches a key inside a section and appends a key a section lacks", () => {
    expect(
      tomlSet(FILE, "harness.claude-code", "color", tomlString("gold")),
    ).toContain('[harness.claude-code]\ncolor = "gold"\n');
    expect(
      tomlSet(FILE, "harness.claude-code", "label", tomlString("bot")),
    ).toContain('[harness.claude-code]\ncolor = "blue"\nlabel = "bot"\n');
  });

  it("appends a section the file lacks at the end", () => {
    expect(tomlSet(FILE, "budget", "per_run_micros", "5")).toBe(
      `${FILE.trimEnd()}\n\n[budget]\nper_run_micros = 5\n`,
    );
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
