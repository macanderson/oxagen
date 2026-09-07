/**
 * The guard has to be able to fail, and it has to fail on the byte that
 * actually caused #1416 rather than on every control character it can see.
 * Both directions are asserted here: a raw NUL is caught, an ESC in an ANSI
 * fixture is not, and the extension allowlist keeps binary assets out of the
 * scan entirely.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_CONTROL_BYTES,
  findControlBytes,
  hasTextExtension,
  TEXT_EXTENSIONS,
} from "./check-control-bytes.mjs";

const encode = (text: string) => Buffer.from(text, "utf8");

describe("findControlBytes", () => {
  it("catches a raw NUL — the byte that makes git call a file binary", () => {
    const hits = findControlBytes(encode('const SEP = "\u0000";\n')) as Array<{
      line: number;
      byte: number;
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 1, byte: 0x00 });
  });

  it("reports the line the byte is on, not the byte offset", () => {
    const hits = findControlBytes(
      encode('const a = 1;\nconst b = 2;\nconst SEP = "\u0000";\n'),
    ) as Array<{ line: number }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(3);
  });

  it("passes the escape spelling, which is the whole remedy", () => {
    // The source text `"\0"` is a backslash and a zero — two ordinary
    // characters — and produces the same byte at runtime.
    expect(findControlBytes(encode('const SEP = "\\0";\n'))).toEqual([]);
  });

  it("allows tab, newline and carriage return", () => {
    expect(findControlBytes(encode("a\tb\r\nc\n"))).toEqual([]);
  });

  it("allows ESC, so an ANSI fixture is not a violation", () => {
    expect(ALLOWED_CONTROL_BYTES.has(0x1b)).toBe(true);
    expect(
      findControlBytes(encode('execOk("\u001b[1mnot json\u001b[0m");')),
    ).toEqual([]);
  });

  it("catches the other C0 controls a source file has no use for", () => {
    for (const byte of [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x1f, 0x7f]) {
      const hits = findControlBytes(
        Buffer.from([0x61, byte, 0x62]),
      ) as unknown[];
      expect(hits, `byte 0x${byte.toString(16)}`).toHaveLength(1);
    }
  });

  it("finds every occurrence, not just the first", () => {
    const hits = findControlBytes(
      encode("`${a}\u0000${b}\u0000${c}`"),
    ) as unknown[];
    expect(hits).toHaveLength(2);
  });

  it("is clean on ordinary source", () => {
    expect(
      findControlBytes(encode('export const x = { a: 1, b: "two" };\n')),
    ).toEqual([]);
  });
});

describe("hasTextExtension", () => {
  it("scans the source extensions a reviewer reads", () => {
    for (const path of [
      "packages/ai/src/generate-object.ts",
      "apps/app/src/page.tsx",
      "tools/scripts/guard.mjs",
      "docs/spec.md",
      ".github/workflows/pipeline.yml",
    ]) {
      expect(hasTextExtension(path), path).toBe(true);
    }
  });

  it("leaves binary assets alone — they are control bytes by construction", () => {
    for (const path of [
      "apps/app/public/favicon/favicon.ico",
      "apps/app/public/pwa/icon-128.png",
      "assets/font.woff2",
      "LICENSE",
    ]) {
      expect(hasTextExtension(path), path).toBe(false);
    }
  });

  it("matches the extension case-insensitively", () => {
    expect(hasTextExtension("docs/README.MD")).toBe(true);
  });

  it("does not treat a dotfile's name as an extension", () => {
    expect(TEXT_EXTENSIONS.has("gitignore")).toBe(false);
    expect(hasTextExtension(".gitignore")).toBe(false);
  });
});
