import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_BODY_WORDS_WARN,
  countTokens,
  DEFAULT_ALWAYS_ON_TOKENS,
  DEFAULT_SERVER_DEFINITION_BUDGET,
  DEFAULT_WORKSPACE_DEFINITION_BUDGET,
  DESCRIPTION_MAX,
  FOLDER_FILES_MAX,
  FOLDER_FILES_WARN,
  MEMORY_RECALL_MAX,
  MEMORY_RECALL_TOKENS_MAX,
  OPENAPI_BYTES_MAX,
  RECORD_BYTES_MAX,
  SKILL_ASSET_BYTES_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_LINES_WARN,
} from "./tokens";

describe("countTokens", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["abcd", 1],
    ["abcde", 2],
    ["abcdefgh", 2],
    ["abcdefghi", 3],
  ])("counts %j as %i tokens", (text, tokens) => {
    expect(countTokens(text)).toBe(tokens);
  });

  it("counts a two-byte character as two bytes", () => {
    expect(countTokens("é")).toBe(1);
    expect(countTokens("éé")).toBe(1);
    expect(countTokens("ééa")).toBe(2);
  });

  it("counts a three-byte character as three bytes", () => {
    expect(countTokens("€")).toBe(1);
    expect(countTokens("€a")).toBe(1);
    expect(countTokens("€ab")).toBe(2);
  });

  it("counts a character outside the basic plane as four bytes", () => {
    expect(countTokens("😀")).toBe(1);
    expect(countTokens("😀a")).toBe(2);
  });

  it("counts a lone surrogate as the three bytes of a replacement character", () => {
    expect(countTokens("\uD800")).toBe(1);
    expect(countTokens("\uD800a")).toBe(1);
    expect(countTokens("\uD800ab")).toBe(2);
    expect(countTokens("\uDC00\uD800")).toBe(2);
  });

  it.each([
    "plain ASCII text for a steering record",
    "Refunds over 100 € need a second approver.",
    "naïve café résumé",
    "日本語のテキスト",
    "emoji 😀🎉 and text",
    "broken \uD83D surrogate",
    "line one\nline two\n",
  ])("agrees with a UTF-8 encoder on %j", (text) => {
    const bytes = new TextEncoder().encode(text).length;
    expect(countTokens(text)).toBe(Math.ceil(bytes / 4));
  });
});

describe("budgets and limits", () => {
  it("holds the budgets the spec sets", () => {
    expect(DEFAULT_ALWAYS_ON_TOKENS).toBe(4000);
    expect(DEFAULT_WORKSPACE_DEFINITION_BUDGET).toBe(20000);
    expect(DEFAULT_SERVER_DEFINITION_BUDGET).toBe(8000);
  });

  it("holds the limits the checks warn about", () => {
    expect(ALWAYS_ON_BODY_WORDS_WARN).toBe(120);
    expect(SKILL_LINES_WARN).toBe(500);
    expect(FOLDER_FILES_WARN).toBe(800);
    expect(FOLDER_FILES_MAX).toBe(1000);
    expect(FOLDER_FILES_WARN).toBeLessThan(FOLDER_FILES_MAX);
  });

  it("holds the size limits in bytes", () => {
    expect(RECORD_BYTES_MAX).toBe(262144);
    expect(SKILL_ASSET_BYTES_MAX).toBe(1048576);
    expect(OPENAPI_BYTES_MAX).toBe(26214400);
  });

  it("holds the record field and memory limits", () => {
    expect(DESCRIPTION_MAX).toBe(200);
    expect(SKILL_DESCRIPTION_MAX).toBe(1024);
    expect(MEMORY_RECALL_MAX).toBe(5);
    expect(MEMORY_RECALL_TOKENS_MAX).toBe(800);
  });
});
