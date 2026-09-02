import { describe, expect, it } from "vitest";
import {
  isValidSecretKeyName,
  parseEnvText,
  type ParsedEnvEntry,
} from "./env-parse";

describe("isValidSecretKeyName", () => {
  it("accepts POSIX-ish identifiers", () => {
    for (const key of [
      "FOO",
      "_PRIVATE",
      "A1_B2",
      "x",
      "_",
      "lowercase",
      "MIX_ed_99",
    ]) {
      expect(isValidSecretKeyName(key)).toBe(true);
    }
  });

  it("rejects names that don't start with a letter or underscore", () => {
    expect(isValidSecretKeyName("1BAD")).toBe(false);
    expect(isValidSecretKeyName("9")).toBe(false);
  });

  it("rejects names with disallowed characters", () => {
    expect(isValidSecretKeyName("has-dash")).toBe(false);
    expect(isValidSecretKeyName("has space")).toBe(false);
    expect(isValidSecretKeyName("FOO.BAR")).toBe(false);
    expect(isValidSecretKeyName("FÖO")).toBe(false); // non-ascii letter
    expect(isValidSecretKeyName("FOO$")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidSecretKeyName("")).toBe(false);
  });
});

describe("parseEnvText", () => {
  it("parses a bare KEY=VALUE", () => {
    expect(parseEnvText("FOO=bar")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("strips a single `export ` prefix", () => {
    expect(parseEnvText("export FOO=bar")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("does not treat an invalid key after `export ` as valid", () => {
    expect(parseEnvText("export 1BAD=x")).toEqual<ParsedEnvEntry[]>([]);
  });

  it("strips surrounding double quotes", () => {
    expect(parseEnvText('FOO="bar"')).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("strips surrounding single quotes", () => {
    expect(parseEnvText("FOO='bar'")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("preserves inner `=` inside double quotes", () => {
    expect(parseEnvText('URL="a=b=c"')).toEqual<ParsedEnvEntry[]>([
      { key: "URL", value: "a=b=c" },
    ]);
  });

  it("preserves inner `=` inside single quotes", () => {
    expect(parseEnvText("URL='a=b=c'")).toEqual<ParsedEnvEntry[]>([
      { key: "URL", value: "a=b=c" },
    ]);
  });

  it("preserves an inner `#` inside double quotes (not a comment)", () => {
    expect(parseEnvText('GREETING="hello # world"')).toEqual<ParsedEnvEntry[]>([
      { key: "GREETING", value: "hello # world" },
    ]);
  });

  it("preserves an inner `#` inside single quotes (not a comment)", () => {
    expect(parseEnvText("GREETING='hello # world'")).toEqual<ParsedEnvEntry[]>([
      { key: "GREETING", value: "hello # world" },
    ]);
  });

  it("returns an empty value for `KEY=`", () => {
    expect(parseEnvText("FOO=")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "" },
    ]);
  });

  it("returns an empty value for `KEY=` followed by only whitespace", () => {
    expect(parseEnvText("FOO=   ")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "" },
    ]);
  });

  it("ignores blank lines and `#`-comment lines (incl. indented comments)", () => {
    const text = [
      "# a comment",
      "",
      "FOO=bar",
      "   # indented comment",
      "   ",
      "BAZ=qux",
    ].join("\n");
    expect(parseEnvText(text)).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("strips a trailing inline comment when the value is unquoted", () => {
    expect(parseEnvText("FOO=bar # trailing comment")).toEqual<
      ParsedEnvEntry[]
    >([{ key: "FOO", value: "bar" }]);
  });

  it("does NOT strip a `#` that lacks a preceding whitespace (part of value)", () => {
    expect(parseEnvText("FOO=value#nospace")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "value#nospace" },
    ]);
  });

  it("does NOT strip a `#` that lives inside a quoted value", () => {
    // The closing quote terminates the value; the trailing comment is dropped.
    expect(parseEnvText('FOO="bar # baz" # real comment')).toEqual<
      ParsedEnvEntry[]
    >([{ key: "FOO", value: "bar # baz" }]);
  });

  it("skips lines whose key is not a valid env-var name", () => {
    const text = ["1BAD=x", "has-dash=y", "has space=z", "GOOD=ok"].join("\n");
    expect(parseEnvText(text)).toEqual<ParsedEnvEntry[]>([
      { key: "GOOD", value: "ok" },
    ]);
  });

  it("skips lines without an `=`", () => {
    expect(parseEnvText("NOEQUALS\nFOO=bar")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("tolerates leading whitespace (spaces and tabs)", () => {
    expect(parseEnvText("   FOO=bar")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
    expect(parseEnvText("\tBAZ=qux")).toEqual<ParsedEnvEntry[]>([
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("trims whitespace around the key and after the `=`", () => {
    expect(parseEnvText("FOO = bar")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseEnvText("FOO=bar\r\nBAZ=qux")).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("leniently takes the rest of an unterminated quoted value", () => {
    expect(parseEnvText('FOO="bar')).toEqual<ParsedEnvEntry[]>([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("parses an exhaustive multi-line block to the exact expected array", () => {
    const text = [
      "# top comment",
      "",
      "export NODE_ENV=production",
      "DATABASE_URL='postgres://u:p@host:5433/db?ssl=true'",
      'TOKEN="secret # not-a-comment"',
      "EMPTY=",
      "INLINE=value # stripped",
      "1INVALID=skip",
      "bad-key=skip",
      "  PADDED  =  spaced  ",
    ].join("\n");
    expect(parseEnvText(text)).toEqual<ParsedEnvEntry[]>([
      { key: "NODE_ENV", value: "production" },
      { key: "DATABASE_URL", value: "postgres://u:p@host:5433/db?ssl=true" },
      { key: "TOKEN", value: "secret # not-a-comment" },
      { key: "EMPTY", value: "" },
      { key: "INLINE", value: "value" },
      { key: "PADDED", value: "spaced" },
    ]);
  });

  it("returns an empty array for empty / whitespace-only / comment-only input", () => {
    expect(parseEnvText("")).toEqual<ParsedEnvEntry[]>([]);
    expect(parseEnvText("   \n\t\n")).toEqual<ParsedEnvEntry[]>([]);
    expect(parseEnvText("# only\n# comments")).toEqual<ParsedEnvEntry[]>([]);
  });
});
