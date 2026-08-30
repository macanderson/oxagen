import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepFallback } from "../grep-fallback.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "oxagen-grep-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("grepFallback", () => {
  it("ranks files by match count and skips vendor dirs", async () => {
    write(
      "src/telemetry.ts",
      "export function drainTelemetry() {} // telemetry telemetry",
    );
    write("src/other.ts", "export const x = 1;");
    write("node_modules/pkg/index.ts", "telemetry telemetry telemetry");

    const hits = await grepFallback(repo, "telemetry drain");
    expect(hits[0]?.path).toBe("src/telemetry.ts");
    expect(hits.some((h) => h.path.includes("node_modules"))).toBe(false);
    expect(hits.some((h) => h.path === "src/other.ts")).toBe(false);
  });

  it("returns [] when the query has no usable terms", async () => {
    write("src/a.ts", "content");
    expect(await grepFallback(repo, "a b c")).toEqual([]); // all tokens < 3 chars
  });

  it("returns [] when nothing matches", async () => {
    write("src/a.ts", "nothing relevant here");
    expect(await grepFallback(repo, "quuux zzznope")).toEqual([]);
  });
});
