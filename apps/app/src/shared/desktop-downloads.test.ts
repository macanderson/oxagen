import { describe, expect, it } from "vitest";
import { DESKTOP_DOWNLOADS, DESKTOP_DOWNLOADS_PAGE } from "./desktop-downloads";

// The stable names apps/desktop/scripts/publish-downloads.mjs writes under
// latest/ (the `latest` field of apps/desktop/src/downloads.ts). A rename on
// either side has to fail here rather than ship a dead link.
const EXPECTED = {
  macos: [
    "https://downloads.oxagen.sh/latest/Oxagen_aarch64.dmg",
    "https://downloads.oxagen.sh/latest/Oxagen_x64.dmg",
  ],
  windows: [
    "https://downloads.oxagen.sh/latest/Oxagen_x64-setup.exe",
    "https://downloads.oxagen.sh/latest/Oxagen_x64_en-US.msi",
  ],
  linux: [
    "https://downloads.oxagen.sh/latest/Oxagen_amd64.deb",
    "https://downloads.oxagen.sh/latest/Oxagen.x86_64.rpm",
    "https://downloads.oxagen.sh/latest/Oxagen_amd64.AppImage",
  ],
};

describe("DESKTOP_DOWNLOADS", () => {
  it("lists macOS, then Windows, then Linux, as the downloads page does", () => {
    expect(DESKTOP_DOWNLOADS.map((group) => group.platform)).toEqual([
      "macos",
      "windows",
      "linux",
    ]);
  });

  it("links every installer at its version-free name", () => {
    expect(
      Object.fromEntries(
        DESKTOP_DOWNLOADS.map((group) => [
          group.platform,
          group.installers.map((installer) => installer.url),
        ]),
      ),
    ).toEqual(EXPECTED);
  });

  it("gives every installer its own catalog key", () => {
    const keys = DESKTOP_DOWNLOADS.flatMap((group) =>
      group.installers.map((installer) => installer.key),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("links the page that lists every version and its checksums", () => {
    expect(DESKTOP_DOWNLOADS_PAGE).toBe("https://downloads.oxagen.sh/");
  });
});
