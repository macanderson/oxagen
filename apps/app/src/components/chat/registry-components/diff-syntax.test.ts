// @vitest-environment node
/**
 * diff-syntax.test.ts
 *
 * Covers:
 *   - inferLang: extension → shiki language mapping + plaintext fallback
 *   - highlightLine: plaintext short-circuit, empty-line handling, and real
 *     dual-theme tokenization emitting a `--shiki-dark` variable per token
 *     (the light+dark support the diff card relies on)
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  inferLang,
  highlightLine,
  __resetDiffHighlighter,
} from "./diff-syntax";

afterEach(() => __resetDiffHighlighter());

describe("inferLang", () => {
  it("maps common code extensions to shiki languages", () => {
    expect(inferLang("src/index.ts")).toBe("typescript");
    expect(inferLang("app/page.tsx")).toBe("tsx");
    expect(inferLang("scripts/build.mjs")).toBe("javascript");
    expect(inferLang("ui/App.jsx")).toBe("jsx");
    expect(inferLang("config.json")).toBe("json");
    expect(inferLang("styles/main.css")).toBe("css");
    expect(inferLang("main.py")).toBe("python");
    expect(inferLang("lib.rs")).toBe("rust");
    expect(inferLang("cmd/main.go")).toBe("go");
    expect(inferLang("query.sql")).toBe("sql");
    expect(inferLang("ci.yml")).toBe("yaml");
    expect(inferLang("setup.sh")).toBe("bash");
    expect(inferLang("Cargo.toml")).toBe("toml");
  });

  it("falls back to plaintext for unknown or extensionless paths", () => {
    expect(inferLang("Makefile")).toBe("plaintext");
    expect(inferLang("data.bin")).toBe("plaintext");
    expect(inferLang("noext")).toBe("plaintext");
  });
});

describe("highlightLine", () => {
  it("returns a single empty token for an empty line", async () => {
    expect(await highlightLine("", "typescript")).toEqual([{ content: "" }]);
  });

  it("returns a single uncoloured token for plaintext", async () => {
    expect(await highlightLine("const x = 1;", "plaintext")).toEqual([
      { content: "const x = 1;" },
    ]);
  });

  it("emits dual-theme (light + dark) styles for real code", async () => {
    const tokens = await highlightLine("const answer = 42;", "typescript");
    // Tokenized into more than one fragment (keyword / identifier / number …).
    expect(tokens.length).toBeGreaterThan(1);
    const joined = tokens.map((t) => t.content).join("");
    expect(joined).toBe("const answer = 42;");
    // Every coloured token carries BOTH a light `color` and a `--shiki-dark`
    // variable — the mechanism the diff card uses to re-theme with `.dark`.
    const styled = tokens.filter((t) => t.style);
    expect(styled.length).toBeGreaterThan(0);
    for (const t of styled) {
      expect(t.style).toMatch(/color:/);
      expect(t.style).toMatch(/--shiki-dark:/);
    }
  });
});
