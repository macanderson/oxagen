import { describe, expect, it } from "vitest";
import {
  classifyInstaller,
  formatSize,
  type PageEntry,
  renderIndexHtml,
  sha256SumsText,
  sortInstallers,
} from "./downloads";

const V = "2.1.1";
const FILES = [
  "Oxagen_2.1.1_aarch64.dmg",
  "Oxagen_2.1.1_x64.dmg",
  "Oxagen_2.1.1_x64-setup.exe",
  "Oxagen_2.1.1_x64_en-US.msi",
  "Oxagen_2.1.1_amd64.deb",
  "Oxagen-2.1.1-1.x86_64.rpm",
  "Oxagen_2.1.1_amd64.AppImage",
];

describe("classifyInstaller", () => {
  it("recognises every installer the desktop workflow builds", () => {
    const got = FILES.map((f) => classifyInstaller(f, V));
    expect(got.map((i) => [i?.os, i?.variant])).toEqual([
      ["macOS", "Apple silicon"],
      ["macOS", "Intel"],
      ["Windows", "Installer (.exe, current user)"],
      ["Windows", "Installer (.msi)"],
      ["Linux", ".deb (Debian, Ubuntu)"],
      ["Linux", ".rpm (Fedora, RHEL)"],
      ["Linux", "AppImage (any distribution)"],
    ]);
    expect(classifyInstaller("Oxagen_2.1.1_aarch64.dmg", V)?.contentType).toBe(
      "application/x-apple-diskimage",
    );
  });

  it("ignores everything else an artifact carries, and other versions", () => {
    for (const other of [
      "Oxagen_2.1.1_aarch64.dmg.sha256",
      "bundle_dmg.sh",
      "tacho-aarch64-apple-darwin",
      "oxagen-x86_64-pc-windows-msvc.exe",
      "Oxagen.app.tar.gz.sig",
      "icon.icns",
    ]) {
      expect(classifyInstaller(other, V)).toBeNull();
    }
    // A stale bundle from an older build must not ship under a new path.
    expect(classifyInstaller("Oxagen_2.1.0_aarch64.dmg", V)).toBeNull();
    expect(classifyInstaller("Oxagen-2.1.0-1.x86_64.rpm", V)).toBeNull();
  });
});

describe("page helpers", () => {
  it("orders macOS, Windows, Linux and drops duplicate file names", () => {
    const shuffled = [...FILES].reverse().map((f) => classifyInstaller(f, V)!);
    const sorted = sortInstallers([...shuffled, shuffled[0]!]);
    expect(sorted.map((i) => i.file)).toEqual(FILES);
  });

  it("writes SHA256SUMS in the format shasum -c reads", () => {
    expect(
      sha256SumsText([
        { file: "a.dmg", sha256: "ab" },
        { file: "b.msi", sha256: "cd" },
      ]),
    ).toBe("ab  a.dmg\ncd  b.msi\n");
  });

  it("formats sizes", () => {
    expect(formatSize(81_875_708)).toBe("78.1 MB");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(10)).toBe("1 KB");
    expect(formatSize(-1)).toBe("?");
    expect(formatSize(Number.NaN)).toBe("?");
  });

  it("renders one linked row per installer under its OS, with size and checksum", () => {
    const entries: PageEntry[] = FILES.map((f, i) => ({
      ...classifyInstaller(f, V)!,
      bytes: 50_000_000 + i,
      sha256: `${i}`.padStart(64, "0"),
    }));
    const html = renderIndexHtml({
      version: V,
      entries,
      publishedAt: "2026-09-15",
    });
    expect(html).toContain("<title>Download Oxagen</title>");
    for (const f of FILES) {
      expect(html).toContain(`href="desktop/2.1.1/${encodeURIComponent(f)}"`);
    }
    const mac = html.indexOf("<h2>macOS</h2>");
    const win = html.indexOf("<h2>Windows</h2>");
    const linux = html.indexOf("<h2>Linux</h2>");
    expect(mac).toBeGreaterThan(0);
    expect(win).toBeGreaterThan(mac);
    expect(linux).toBeGreaterThan(win);
    expect(html).toContain('href="desktop/2.1.1/SHA256SUMS.txt"');
    expect(html).toContain("47.7 MB");
    // An OS with nothing published gets no empty table.
    const macOnly = renderIndexHtml({
      version: V,
      entries: entries.slice(0, 2),
      publishedAt: "x",
    });
    expect(macOnly).not.toContain("<h2>Windows</h2>");
    // Nothing a file name carries can inject markup.
    const hostile = renderIndexHtml({
      version: '2"<b>',
      entries: [],
      publishedAt: "<script>",
    });
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("2&quot;&lt;b&gt;");
  });
});
