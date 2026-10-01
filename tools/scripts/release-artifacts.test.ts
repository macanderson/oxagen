import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_TARGETS,
  downloadUrl,
  expectedAssets,
  installSection,
  releaseTag,
} from "./lib/release-artifacts";

describe("expectedAssets", () => {
  it("names every file of a complete release from the version alone", () => {
    const assets = expectedAssets("2.2.0");
    expect(assets.installers).toEqual([
      "Oxagen_2.2.0_aarch64.dmg",
      "Oxagen_2.2.0_x64.dmg",
      "Oxagen_2.2.0_x64-setup.exe",
      "Oxagen_2.2.0_x64_en-US.msi",
      "Oxagen_2.2.0_amd64.deb",
      "Oxagen-2.2.0-1.x86_64.rpm",
      "Oxagen_2.2.0_amd64.AppImage",
    ]);
    expect(assets.binaries).toEqual([
      "tacho-aarch64-apple-darwin",
      "oxagen-aarch64-apple-darwin",
      "tacho-x86_64-apple-darwin",
      "oxagen-x86_64-apple-darwin",
      "tacho-x86_64-pc-windows-msvc.exe",
      "oxagen-x86_64-pc-windows-msvc.exe",
      "tacho-x86_64-unknown-linux-gnu",
      "oxagen-x86_64-unknown-linux-gnu",
    ]);
    expect(assets.checksums).toEqual(assets.binaries.map((b) => `${b}.sha256`));
  });

  it("covers exactly the targets desktop.yml builds", () => {
    // Read the workflow rather than a second copy of the list, so a target
    // added to the matrix fails here instead of going unnamed in the notes
    // and unchecked by release-publish.ts's completeness check.
    const workflow = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/desktop.yml"),
      "utf8",
    );
    const matrix = [...workflow.matchAll(/^\s*triple:\s*(\S+)\s*$/gm)].map(
      (m) => m[1],
    );
    expect(matrix.length).toBeGreaterThan(0);
    expect([...RELEASE_TARGETS.map((t) => t.triple)].sort()).toEqual(
      [...new Set(matrix)].sort(),
    );
  });
});

describe("the macOS updater archive", () => {
  it("is named in desktop.yml the way publish-downloads.mjs reads it", () => {
    // classifyUpdaterArchive (apps/desktop/src/downloads.ts) accepts exactly
    // Oxagen_<version>_aarch64.app.tar.gz and Oxagen_<version>_x64.app.tar.gz.
    // If the rename drifts, the feed loses its macOS keys and every Mac stops
    // being offered updates, so the name is pinned here.
    const workflow = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/desktop.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      'mv "$dir/Oxagen.app.tar.gz" "$dir/Oxagen_${VERSION}_${arch}.app.tar.gz"',
    );
    expect(workflow).toContain(
      'mv "$dir/Oxagen.app.tar.gz.sig" "$dir/Oxagen_${VERSION}_${arch}.app.tar.gz.sig"',
    );
    expect(workflow).toMatch(/aarch64-\*\) arch=aarch64 ;;/);
    expect(workflow).toMatch(/\*\) arch=x64 ;;/);
    expect(workflow).toContain("release/bundle/macos/*.app.tar.gz");
  });
});

describe("urls", () => {
  it("point every file at its versioned path on the downloads host", () => {
    expect(releaseTag("2.2.0")).toBe("desktop-v2.2.0");
    expect(downloadUrl("2.2.0", "Oxagen_2.2.0_aarch64.dmg")).toBe(
      "https://downloads.oxagen.sh/desktop/2.2.0/Oxagen_2.2.0_aarch64.dmg",
    );
    expect(downloadUrl("2.2.0", "tacho-x86_64-pc-windows-msvc.exe")).toBe(
      "https://downloads.oxagen.sh/desktop/2.2.0/tacho-x86_64-pc-windows-msvc.exe",
    );
  });
});

describe("installSection", () => {
  it("links every installer and executable once, plus npm and the checksums", () => {
    const section = installSection("2.2.0");
    const assets = expectedAssets("2.2.0");
    for (const file of [...assets.installers, ...assets.binaries]) {
      const links = section.split(`[${file}](`).length - 1;
      expect(links, file).toBe(1);
    }
    expect(section).toContain("npm install -g @oxagen/cli@2.2.0");
    expect(section).toContain("desktop/2.2.0/SHA256SUMS.txt");
    // The repository is private, so the notes link no GitHub release (ADR-245).
    expect(section).not.toContain("github.com");
    expect(section).toContain(
      "[oxagen-aarch64-apple-darwin](https://downloads.oxagen.sh/desktop/2.2.0/oxagen-aarch64-apple-darwin)",
    );
    expect(section.startsWith("## Install\n")).toBe(true);
    // The prose rules the repository holds: no em dashes, no exclamation marks.
    expect(section).not.toMatch(/[—!]/);
  });
});
