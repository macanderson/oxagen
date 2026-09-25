// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { DesktopDownloads } from "./desktop-downloads";

afterEach(() => {
  cleanup();
});

function renderDownloads() {
  return render(
    <IntlProvider>
      <DesktopDownloads />
    </IntlProvider>,
  );
}

const INSTALLERS = [
  [
    "macOS",
    "macAppleSilicon",
    "Apple silicon (.dmg)",
    "https://downloads.oxagen.sh/latest/Oxagen_aarch64.dmg",
  ],
  [
    "macOS",
    "macIntel",
    "Intel (.dmg)",
    "https://downloads.oxagen.sh/latest/Oxagen_x64.dmg",
  ],
  [
    "Windows",
    "windowsExe",
    "Installer (.exe)",
    "https://downloads.oxagen.sh/latest/Oxagen_x64-setup.exe",
  ],
  [
    "Windows",
    "windowsMsi",
    "Installer (.msi)",
    "https://downloads.oxagen.sh/latest/Oxagen_x64_en-US.msi",
  ],
  [
    "Linux",
    "linuxDeb",
    ".deb (Debian, Ubuntu)",
    "https://downloads.oxagen.sh/latest/Oxagen_amd64.deb",
  ],
  [
    "Linux",
    "linuxRpm",
    ".rpm (Fedora, RHEL)",
    "https://downloads.oxagen.sh/latest/Oxagen.x86_64.rpm",
  ],
  [
    "Linux",
    "linuxAppImage",
    "AppImage",
    "https://downloads.oxagen.sh/latest/Oxagen_amd64.AppImage",
  ],
] as const;

describe("DesktopDownloads", () => {
  it("names itself by its heading and says why the app comes first", async () => {
    renderDownloads();
    const section = screen.getByRole("region", {
      name: "Install the Oxagen app",
    });
    expect(section).toHaveTextContent(
      "Install it first, on the machine the agent runs on. The app puts the oxagen and tacho commands on PATH, and enrollment runs through them.",
    );
    await expectNoAxe(document.body);
  });

  it("tells a macOS reader how to open an un-notarized build the first time", () => {
    renderDownloads();
    const note = screen.getByTestId("desktop-downloads-macos-first-launch");
    expect(note).toHaveTextContent(
      "macOS refuses the first launch until builds are notarized. Choose Done, then click Open Anyway in System Settings > Privacy & Security.",
    );
    // macOS 15 removed the Control-click Open override.
    expect(note.textContent.toLowerCase()).not.toContain("right-click");
  });

  it("groups the installers under macOS, Windows and Linux, in that order", () => {
    renderDownloads();
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["macOS", "Windows", "Linux"]);
  });

  it.each(INSTALLERS)(
    "links %s %s at its latest name",
    (platform, key, label, href) => {
      renderDownloads();
      const link = screen.getByTestId(`desktop-download-${key}`);
      expect(link).toHaveTextContent(label);
      expect(link).toHaveAttribute("href", href);
      // An installer downloads in place: no new tab, so no opener to guard.
      expect(link).not.toHaveAttribute("target");
      const term = screen
        .getAllByRole("term")
        .find((node) => node.textContent === platform);
      const definition = term?.nextElementSibling;
      if (!(definition instanceof HTMLElement))
        throw new Error(`no installers listed under ${platform}`);
      expect(within(definition).getByTestId(`desktop-download-${key}`)).toBe(
        link,
      );
    },
  );

  it("links exactly the seven installers, and nothing else downloads", () => {
    renderDownloads();
    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      ...INSTALLERS.map(([, , , href]) => href),
      "https://downloads.oxagen.sh/",
    ]);
  });

  it("links every version and its checksums in a new tab without an opener", () => {
    renderDownloads();
    const all = screen.getByRole("link", {
      name: "Every version, with SHA-256 checksums",
    });
    expect(all).toHaveAttribute("href", "https://downloads.oxagen.sh/");
    expect(all).toHaveAttribute("target", "_blank");
    expect(all).toHaveAttribute("rel", "noopener noreferrer");
  });
});
