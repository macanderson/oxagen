import { describe, expect, it } from "vitest";
import { findReleaseLinks, scansForReleaseLinks } from "./release-hosting";

describe("findReleaseLinks", () => {
  it("finds every shape a GitHub release link has taken here", () => {
    // Each line is one this repository carried before ADR-247.
    const text = [
      '"https://github.com/macanderson/oxagen/releases/download/desktop-latest/latest.json"',
      "githubRelease: `https://github.com/macanderson/oxagen/releases/tag/desktop-v${v}`,",
      '"url": "https://github.com/macanderson/oxagen/releases.atom",',
      "return `${REPO}/releases/download/desktop-v${encodeURIComponent(version)}/${name}`;",
      'url "#{repo}/releases/tag/desktop-v#{version}"',
      "gh release download desktop-v2.1.1 --repo macanderson/oxagen --pattern '*.sha256'",
      "See https://github.com/oxageninc/product/releases for every version.",
    ].join("\n");
    const found = findReleaseLinks(text);
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(found[0]).toEqual({
      line: 1,
      text: "github.com/macanderson/oxagen/releases",
      why: "links a GitHub release",
    });
    expect(found[3]?.why).toBe("builds a GitHub release URL from a variable");
    expect(found[5]?.why).toBe("downloads from a GitHub release");
  });

  it("passes the downloads host, the docs release notes, and other GitHub links", () => {
    const text = [
      "https://downloads.oxagen.sh/updater/latest.json",
      "https://downloads.oxagen.sh/desktop/2.2.0/oxagen-aarch64-apple-darwin",
      "`https://docs.oxagen.sh/docs/releases/v${v}`",
      '"homepage": "https://github.com/macanderson/oxagen#readme"',
      "https://github.com/docker/compose/releases-notes",
      "content/docs/releases/v2.1.3.mdx",
      "`${DOWNLOADS}/desktop/${v}/${file}`",
    ].join("\r\n");
    expect(findReleaseLinks(text)).toEqual([]);
  });

  it("reports two links on one line separately", () => {
    expect(
      findReleaseLinks(
        "a github.com/a/b/releases b github.com/c/d/releases/tag/x",
      ).map((f) => f.text),
    ).toEqual(["github.com/a/b/releases", "github.com/c/d/releases"]);
  });
});

describe("scansForReleaseLinks", () => {
  it("reads app, docs, and packaging sources", () => {
    for (const path of [
      "apps/desktop/src-tauri/tauri.conf.json",
      "apps/desktop/src/downloads.ts",
      "apps/desktop/README.md",
      "apps/docs/src/components/mdx/release-downloads.tsx",
      "apps/docs/content/docs/cli/installation.mdx",
      "apps/desktop/scripts/publish-downloads.mjs",
      "tools/packaging/homebrew/tacho.rb",
      "tools/packaging/scoop/oxagen.json",
      "apps/docs/public/install.sh",
    ]) {
      expect(scansForReleaseLinks(path), path).toBe(true);
    }
  });

  it("skips tests, fixtures, other roots, and binary files", () => {
    for (const path of [
      "apps/app/src/features/run/work.test.tsx",
      "apps/desktop/src/downloads.test.ts",
      "packages/github/src/__tests__/fetch-client-read.test.ts",
      "apps/app/e2e/login.spec.ts",
      "apps/api/src/__fixtures__/release.json",
      "docs/adr/ADR-202-the-macos-desktop-app-installs-updates-without-asking.md",
      "tools/scripts/lib/release-artifacts.ts",
      "apps/desktop/src-tauri/icons/icon.png",
      "apps/web/fonts/geist-latin-wght.woff2",
    ]) {
      expect(scansForReleaseLinks(path), path).toBe(false);
    }
  });
});
