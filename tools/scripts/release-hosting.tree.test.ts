// This test reads every tracked text file under apps/ and tools/packaging/,
// so it is a `*.tree.test.ts` file. `pnpm check:tree-guards` runs it uncached
// in the checks job, outside turbo's cached `test:unit` task (#4664 item 2).
//
// Every file a desktop release ships is served from downloads.oxagen.sh
// (ADR-245). The repository is private and has changed owner more than once,
// so a GitHub release link in an app, the docs, or a packaging template is a
// 404 for the reader and, in the updater endpoint, for every installed app.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findReleaseLinks,
  scansForReleaseLinks,
} from "./lib/release-hosting";

const ROOT = resolve(import.meta.dirname, "../..");

function trackedFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--", "apps", "tools/packaging"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter((path) => path !== "");
}

describe("release hosting", () => {
  const files = trackedFiles().filter(scansForReleaseLinks);

  it("reads the files that once linked GitHub releases", () => {
    for (const path of [
      "apps/desktop/src-tauri/tauri.conf.json",
      "apps/desktop/src/downloads.ts",
      "apps/desktop/README.md",
      "apps/docs/src/components/mdx/release-downloads.tsx",
      "apps/docs/content/docs/cli/installation.mdx",
      "tools/packaging/homebrew/oxagen.rb",
      "tools/packaging/homebrew/tacho.rb",
      "tools/packaging/scoop/oxagen.json",
    ]) {
      expect(files, path).toContain(path);
    }
  });

  it("links no download to a GitHub release", () => {
    const found = files.flatMap((path) =>
      findReleaseLinks(readFileSync(join(ROOT, path), "utf8")).map(
        (link) => `${path}:${link.line} ${link.why}: ${link.text}`,
      ),
    );
    expect(
      found,
      "Serve the file from https://downloads.oxagen.sh/ instead (ADR-245).",
    ).toEqual([]);
  });

  it("points the in-app updater at the downloads host", () => {
    const conf = JSON.parse(
      readFileSync(
        join(ROOT, "apps/desktop/src-tauri/tauri.conf.json"),
        "utf8",
      ),
    ) as { plugins: { updater: { endpoints: string[] } } };
    expect(conf.plugins.updater.endpoints).toEqual([
      "https://downloads.oxagen.sh/updater/latest.json",
    ]);
  });
});
