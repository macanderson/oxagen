import { describe, it, expect } from "vitest";
import { tokenizeLexicalQuery, MAX_LEXICAL_TOKENS } from "./lexical-tokenize";

describe("tokenizeLexicalQuery", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenizeLexicalQuery("Hello World")).toEqual(
      expect.arrayContaining(["hello", "world"]),
    );
  });

  it("keeps file paths and stack-frame tokens intact", () => {
    const tokens = tokenizeLexicalQuery("NullPointerException at auth.ts:42");
    expect(tokens).toContain("auth.ts:42");
    expect(tokens).toContain("nullpointerexception");
  });

  it("filters out single-character tokens", () => {
    const tokens = tokenizeLexicalQuery("a b cd");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("b");
    expect(tokens).toContain("cd");
  });

  it("dedupes repeated tokens", () => {
    const tokens = tokenizeLexicalQuery("error error error retry");
    expect(tokens.filter((t) => t === "error")).toHaveLength(1);
  });

  it("caps the number of tokens at MAX_LEXICAL_TOKENS", () => {
    const words = Array.from(
      { length: MAX_LEXICAL_TOKENS + 10 },
      (_, i) => `token${i}`,
    );
    const tokens = tokenizeLexicalQuery(words.join(" "));
    expect(tokens.length).toBeLessThanOrEqual(MAX_LEXICAL_TOKENS);
  });

  it("returns an empty array for a query with no usable tokens", () => {
    expect(tokenizeLexicalQuery("a . : -")).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(tokenizeLexicalQuery("")).toEqual([]);
  });

  it("strips leading and trailing punctuation from a token", () => {
    const tokens = tokenizeLexicalQuery("(auth.ts:42)");
    expect(tokens).toContain("auth.ts:42");
  });

  it("sorts longer, more specific tokens first", () => {
    const tokens = tokenizeLexicalQuery("go run retry nullpointerexception");
    expect(tokens[0]).toBe("nullpointerexception");
  });
});
