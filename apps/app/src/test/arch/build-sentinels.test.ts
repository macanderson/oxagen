// INV-22 (ARCHITECTURE.md §4, §5): the post-build sentinel scan. CI runs
// scripts/scan-build-sentinels.mjs over .next/server and .next/static after
// `next build`; this proves the walk finds a sentinel wherever it lands in a
// build, and reports nothing on a clean one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCANNED_DIRS,
  SENTINELS,
  scanBuild,
} from "../../../scripts/scan-build-sentinels.mjs";

const builds: string[] = [];

/** A fake .next with the given files (path → content). */
function build(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wl46-build-"));
  builds.push(dir);
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(dir, file);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of builds.splice(0)) rmSync(dir, { recursive: true });
});

describe("scan-build-sentinels", () => {
  it("scans .next/server and .next/static for the seeded domain and the demo-seed name", () => {
    expect([...SCANNED_DIRS]).toEqual(["server", "static"]);
    expect([...SENTINELS]).toEqual(["e2e.oxagen.test", "demo-seed"]);
  });

  it("a clean build has no hits", () => {
    const dir = build({
      "server/app/page.js": "export default function Page() {}",
      "static/chunks/main.js": "console.log('hello')",
      "cache/webpack/x.pack": "e2e.oxagen.test is not scanned in the cache",
    });
    expect(scanBuild(dir)).toEqual([]);
  });

  it("a sentinel in a server chunk fails, named with its file", () => {
    const dir = build({
      "server/app/[org]/[ws]/page.js": 'const owner = "owner@e2e.oxagen.test";',
      "static/chunks/main.js": "clean",
    });
    expect(scanBuild(dir)).toEqual([
      { file: "server/app/[org]/[ws]/page.js", sentinel: "e2e.oxagen.test" },
    ]);
  });

  it("a sentinel in a nested static asset fails", () => {
    const dir = build({
      "server/app/page.js": "clean",
      "static/chunks/app/deep/nested/client.js": 'import "./demo-seed";',
    });
    expect(scanBuild(dir)).toEqual([
      {
        file: "static/chunks/app/deep/nested/client.js",
        sentinel: "demo-seed",
      },
    ]);
  });

  it("an absent build directory scans as empty", () => {
    expect(scanBuild(path.join(tmpdir(), "wl46-no-such-build"))).toEqual([]);
  });
});
