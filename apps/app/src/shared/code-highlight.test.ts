import { describe, expect, it } from "vitest";
import {
  type CodeToken,
  languageForPath,
  tokenizeCode,
} from "./code-highlight";

// Not part of the module's production surface (only `tokenizeCode` itself
// calls either), so they hang off `tokenizeCode.testing`; see the comment on
// that assignment in `code-highlight.ts`.
const { tokenizeJson, tokenizeShell } = tokenizeCode.testing;

/** The tokens, rejoined. Every scanner must rebuild its source exactly. */
function rebuild(tokens: readonly CodeToken[]): string {
  return tokens.map((token) => token.text).join("");
}

/** The kinds a given piece of text was painted, for asserting on one word. */
function kindOf(tokens: readonly CodeToken[], text: string): string | null {
  return tokens.find((token) => token.text === text)?.kind ?? null;
}

describe("tokenizeShell", () => {
  it("paints the command word and leaves its arguments alone", () => {
    const tokens = tokenizeShell("git status");
    expect(kindOf(tokens, "git")).toBe("table");
    expect(kindOf(tokens, "status")).toBe("text");
  });

  it("finds the command again after a pipe, an && and a newline", () => {
    for (const source of ["ls | wc", "ls && wc", "ls\nwc"]) {
      expect(kindOf(tokenizeShell(source), "wc")).toBe("table");
    }
  });

  it("looks past a prefix that stands before the real command", () => {
    const tokens = tokenizeShell("sudo systemctl restart nginx");
    expect(kindOf(tokens, "sudo")).toBe("table");
    expect(kindOf(tokens, "systemctl")).toBe("table");
    expect(kindOf(tokens, "restart")).toBe("text");
  });

  it("paints quotes, flags, variables, numbers and comments", () => {
    const tokens = tokenizeShell(`echo --count 3 "$HOME" 'raw' # why`);
    expect(kindOf(tokens, "--count")).toBe("key");
    expect(kindOf(tokens, "3")).toBe("number");
    expect(kindOf(tokens, `"$HOME"`)).toBe("string");
    expect(kindOf(tokens, "'raw'")).toBe("string");
    expect(kindOf(tokens, "# why")).toBe("comment");
  });

  it("keeps a bare variable as its own token", () => {
    expect(kindOf(tokenizeShell("cat $FILE"), "$FILE")).toBe("key");
    expect(kindOf(tokenizeShell("cat ${FILE}"), "${FILE}")).toBe("key");
  });

  it("rebuilds the source exactly, including unterminated quotes", () => {
    const sources = [
      "",
      " ",
      "\n\n",
      "git commit -m 'unterminated",
      'echo "also unterminated',
      "echo $",
      "«not shell at all»",
      "a\t b  \n  c",
    ];
    for (const source of sources) {
      expect(rebuild(tokenizeShell(source))).toBe(source);
    }
  });

  it("never emits an empty token", () => {
    for (const token of tokenizeShell("git log --oneline | head -5")) {
      expect(token.text).not.toBe("");
    }
  });
});

describe("tokenizeJson", () => {
  it("separates a key from a string value", () => {
    const tokens = tokenizeJson('{"skill": "file-inbox"}');
    expect(kindOf(tokens, '"skill"')).toBe("key");
    expect(kindOf(tokens, '"file-inbox"')).toBe("string");
  });

  it("reads a key across the whitespace before its colon", () => {
    expect(kindOf(tokenizeJson('{"a"  : 1}'), '"a"')).toBe("key");
  });

  it("paints numbers and literals the same", () => {
    const tokens = tokenizeJson('{"a": -1.5e3, "b": true, "c": null}');
    expect(kindOf(tokens, "-1.5e3")).toBe("number");
    expect(kindOf(tokens, "true")).toBe("number");
    expect(kindOf(tokens, "null")).toBe("number");
  });

  it("rebuilds the source exactly, including malformed JSON", () => {
    for (const source of ["", "{", '{"a": ', '{"unterminated', "@@@"]) {
      expect(rebuild(tokenizeJson(source))).toBe(source);
    }
  });
});

describe("tokenizeCode", () => {
  it("paints text as one token and an empty source as none", () => {
    expect(tokenizeCode("anything at all", "text")).toEqual([
      { kind: "text", text: "anything at all" },
    ]);
    expect(tokenizeCode("", "text")).toEqual([]);
  });

  it("dispatches to the scanner the language names", () => {
    expect(kindOf(tokenizeCode("git status", "shell"), "git")).toBe("table");
    expect(kindOf(tokenizeCode('{"a":1}', "json"), '"a"')).toBe("key");
  });
});

describe("languageForPath", () => {
  it("reads JSON and shell from the extension, whatever its case", () => {
    expect(languageForPath("apps/app/package.json")).toBe("json");
    expect(languageForPath("tsconfig.JSON")).toBe("json");
    expect(languageForPath("scripts/deploy.sh")).toBe("shell");
    expect(languageForPath("scripts/deploy.zsh")).toBe("shell");
  });

  it("reads the shell files that carry no extension", () => {
    expect(languageForPath("infra/Dockerfile")).toBe("shell");
    expect(languageForPath("Makefile")).toBe("shell");
    expect(languageForPath(".env.local")).toBe("shell");
  });

  it("is honest plain text about everything else", () => {
    expect(languageForPath("src/kernel.ts")).toBe("text");
    expect(languageForPath("README.md")).toBe("text");
    expect(languageForPath("")).toBe("text");
    // A directory that looks like a JSON file must not fool the extension
    // test into painting the file inside it.
    expect(languageForPath("fixtures.json/notes.md")).toBe("text");
  });
});
