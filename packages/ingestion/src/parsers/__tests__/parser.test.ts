/**
 * Ingestion parser re-export tests.
 *
 * The parser implementation has moved to @oxagen/code-graph.
 * The comprehensive behaviour tests (WASM mock, TypeScript/Python/markdown
 * extraction, error handling, loader singleton) now live in:
 *   packages/code-graph/src/__tests__/parser.test.ts
 *
 * This file verifies:
 *  1. All expected symbols are re-exported from @oxagen/ingestion/parsers.
 *  2. The markdown parser (pure, no WASM) still works through the re-export
 *     chain, providing a lightweight end-to-end smoke test that the wiring
 *     from ingestion → code-graph is correct.
 *  3. The loader helpers (_resetForTest, _injectLanguagesForTest) are exported
 *     and callable (they are used by the tests in code-graph).
 */

import { describe, it, expect } from "vitest";
import {
  parseSourceFile,
  parseMarkdown,
  _resetForTest,
  _injectLanguagesForTest,
} from "../index";
import type {
  ParseResult,
  ParsedSymbol,
  ParsedLanguage,
  SymbolKind,
  MarkdownParse,
} from "../index";

describe("@oxagen/ingestion parser re-exports", () => {
  // ── Type-level: exported symbols are callable / have the expected shape ─────

  it("parseSourceFile is a function", () => {
    expect(typeof parseSourceFile).toBe("function");
  });

  it("parseMarkdown is a function", () => {
    expect(typeof parseMarkdown).toBe("function");
  });

  it("_resetForTest and _injectLanguagesForTest are exported functions", () => {
    expect(typeof _resetForTest).toBe("function");
    expect(typeof _injectLanguagesForTest).toBe("function");
  });

  // ── Smoke test: markdown parsing (pure — no WASM, no network) ──────────────

  it("parseSourceFile returns markdown symbols for .md files (no WASM required)", async () => {
    const md = "# Getting Started\nIntro.\n\n## Install\nRun npm i.";
    const result: ParseResult = await parseSourceFile("docs/README.md", md);

    expect(result.language).toBe("markdown");
    expect(result.title).toBe("Getting Started");
    expect(result.symbols).toHaveLength(2);
    expect(result.symbols.every((s: ParsedSymbol) => s.kind === "heading")).toBe(true);
    expect(result.symbols.map((s: ParsedSymbol) => s.name)).toEqual([
      "Getting Started",
      "Install",
    ]);
    // Markdown symbols carry code slices
    expect(result.symbols[0]!.code).toContain("Getting Started");
  });

  it("parseSourceFile returns { language: 'unknown', symbols: [] } for unrecognized extensions", async () => {
    const result: ParseResult = await parseSourceFile("data.bin", "binary-ish");
    expect(result.language).toBe("unknown");
    expect(result.symbols).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("parseMarkdown returns heading-section symbols directly", () => {
    const result: MarkdownParse = parseMarkdown("# Title\nBody.\n\n## Sub\ncontent");
    expect(result.title).toBe("Title");
    expect(result.symbols).toHaveLength(2);
    const kinds: SymbolKind[] = result.symbols.map((s) => s.kind);
    expect(kinds.every((k) => k === "heading")).toBe(true);
  });

  // ── Verify ParsedLanguage values remain correct through re-export ───────────

  it("TypeScript and Python return language-typed 'unknown' for unsupported extensions", async () => {
    // We cannot call the TypeScript/Python tree-sitter path without WASM, but we
    // CAN verify the language detector returns the right ParsedLanguage string for
    // markdown and unknown — no WASM needed for these paths.
    const mdResult: ParseResult = await parseSourceFile("README.md", "## Section");
    const binResult: ParseResult = await parseSourceFile("config.yaml", "key: value");

    const mdLang: ParsedLanguage = mdResult.language;
    const binLang: ParsedLanguage = binResult.language;

    expect(mdLang).toBe("markdown");
    expect(binLang).toBe("unknown");
  });
});
