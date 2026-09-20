import { describe, expect, it } from "vitest";
import {
  RELEASE_TARGETS,
  downloadUrl,
  expectedAssets,
  installSection,
  releaseAssetUrl,
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

  it("covers the four targets desktop.yml builds", () => {
    expect(RELEASE_TARGETS.map((t) => t.triple)).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
    ]);
  });
});

describe("urls", () => {
  it("point at the versioned download path and the desktop-v release", () => {
    expect(releaseTag("2.2.0")).toBe("desktop-v2.2.0");
    expect(downloadUrl("2.2.0", "Oxagen_2.2.0_aarch64.dmg")).toBe(
      "https://downloads.oxagen.sh/desktop/2.2.0/Oxagen_2.2.0_aarch64.dmg",
    );
    expect(releaseAssetUrl("2.2.0", "tacho-x86_64-pc-windows-msvc.exe")).toBe(
      "https://github.com/macanderson/oxagen/releases/download/desktop-v2.2.0/tacho-x86_64-pc-windows-msvc.exe",
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
    expect(section.startsWith("## Install\n")).toBe(true);
    // The prose rules the repository holds: no em dashes, no exclamation marks.
    expect(section).not.toMatch(/[—!]/);
  });
});
