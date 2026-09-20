// The scanner behind the source editor's colours: every character lands in
// one token in order (so the paint can sit under the textarea), each syntax
// kind is found where the TOML subset puts it, and text the subset does not
// allow is still carried, as `text`, rather than dropped or thrown on.
import { describe, expect, it } from "vitest";
import { type TomlToken, tokenizeToml } from "./toml-highlight";

const kinds = (tokens: TomlToken[]) =>
  tokens.filter((t) => t.kind !== "text").map((t) => [t.kind, t.text]);

const SOURCE = `# release-bot
schema = "oxagen.agent/v1"
slug = "release-bot"
name = "Release bot" # the name
tools = ["git", 'gh']
retries = 3
ratio = -1.5e3
live = true

[harness.claude_code]
model = { id = "claude-opus-5", temperature = 0.2 }
instructions = """
Cut the release.
"""
`;

describe("tokenizeToml", () => {
  it("returns every character of the source, in order", () => {
    const samples = [
      SOURCE,
      "",
      "\n\n",
      "key",
      'key = "open',
      "arr = [1,\n 2 # two\n]",
      "t = { a = 1, b = }",
      "= value\n[[bad",
      "x = 1 trailing text",
      "s = '''never\nclosed",
      'e = "a\\"b" # esc',
    ];
    for (const sample of samples) {
      expect(
        tokenizeToml(sample)
          .map((t) => t.text)
          .join(""),
      ).toBe(sample);
    }
  });

  it("finds the comment, key, string, number, boolean, table and punctuation kinds", () => {
    expect(kinds(tokenizeToml(SOURCE))).toEqual([
      ["comment", "# release-bot"],
      ["key", "schema"],
      ["punct", "="],
      ["string", '"oxagen.agent/v1"'],
      ["key", "slug"],
      ["punct", "="],
      ["string", '"release-bot"'],
      ["key", "name"],
      ["punct", "="],
      ["string", '"Release bot"'],
      ["comment", "# the name"],
      ["key", "tools"],
      ["punct", "="],
      ["punct", "["],
      ["string", '"git"'],
      ["punct", ","],
      ["string", "'gh'"],
      ["punct", "]"],
      ["key", "retries"],
      ["punct", "="],
      ["number", "3"],
      ["key", "ratio"],
      ["punct", "="],
      ["number", "-1.5e3"],
      ["key", "live"],
      ["punct", "="],
      ["boolean", "true"],
      ["table", "[harness.claude_code]"],
      ["key", "model"],
      ["punct", "="],
      ["punct", "{"],
      ["key", "id"],
      ["punct", "="],
      ["string", '"claude-opus-5"'],
      ["punct", ","],
      ["key", "temperature"],
      ["punct", "="],
      ["number", "0.2"],
      ["punct", "}"],
      ["key", "instructions"],
      ["punct", "="],
      ["string", '"""\nCut the release.\n"""'],
    ]);
  });

  it("keeps a string with an escaped quote whole and stops an open string at the line end", () => {
    expect(kinds(tokenizeToml('e = "a\\"b" # esc'))).toEqual([
      ["key", "e"],
      ["punct", "="],
      ["string", '"a\\"b"'],
      ["comment", "# esc"],
    ]);
    expect(kinds(tokenizeToml('e = "open\nnext = 1'))).toEqual([
      ["key", "e"],
      ["punct", "="],
      ["string", '"open'],
      ["key", "next"],
      ["punct", "="],
      ["number", "1"],
    ]);
  });

  it("colours an array across lines, with its comments, and a quoted key", () => {
    expect(kinds(tokenizeToml('"a b" = [\n  1, # one\n  "two",\n]'))).toEqual([
      ["key", '"a b"'],
      ["punct", "="],
      ["punct", "["],
      ["number", "1"],
      ["punct", ","],
      ["comment", "# one"],
      ["string", '"two"'],
      ["punct", ","],
      ["punct", "]"],
    ]);
  });

  it("carries text the subset does not allow as plain text (negative)", () => {
    const tokens = tokenizeToml("x = 1 trailing\n= 2\nt = { = }");
    expect(tokens.filter((t) => t.kind === "text").map((t) => t.text)).toEqual([
      " ",
      " ",
      " trailing\n= 2\n",
      " ",
      " ",
      " = ",
    ]);
    expect(kinds(tokens)).toEqual([
      ["key", "x"],
      ["punct", "="],
      ["number", "1"],
      ["key", "t"],
      ["punct", "="],
      ["punct", "{"],
      ["punct", "}"],
    ]);
  });
});
