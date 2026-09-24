// The Oxagen app's installers, at the version-free names the newest build is
// published under (ARCHITECTURE.md §3.8: an external link target is a brand of
// its own). Installing the app is how a machine gets the `tacho` and `oxagen`
// CLIs an enrollment command runs: the app bundles both and links them onto
// PATH on every launch (apps/desktop/README.md, Command line).
//
// The names are not chosen here. `apps/desktop/scripts/publish-downloads.mjs`
// copies each build to `latest/<name>` on the downloads host, and the names
// are the `latest` field of the rules in `apps/desktop/src/downloads.ts`. A
// rename there breaks these links, so change the two together. The docs site
// carries the same table (apps/docs/src/components/mdx/latest-downloads.tsx).
//
// The table is static on purpose: a page that fetched `latest.json` to learn
// the names would render nothing when the host is slow, and the names do not
// change from one release to the next.

declare const desktopDownloadUrl: unique symbol;
export type DesktopDownloadUrl = string & {
  readonly [desktopDownloadUrl]: true;
};

const HOST = "downloads.oxagen.sh";

/** An https URL on the downloads host, with no credentials, port, query or fragment, as the parser writes it back. */
function isDesktopDownloadUrl(raw: string): raw is DesktopDownloadUrl {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return (
    url.protocol === "https:" &&
    url.hostname === HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === raw
  );
}

/** The one mint: a path in this file that does not make a download URL is a programming error. */
function mint(path: string): DesktopDownloadUrl {
  const raw = `https://${HOST}/${path}`;
  if (isDesktopDownloadUrl(raw)) return raw;
  throw new Error(`unsafe_download_url ${JSON.stringify(raw)}`);
}

type DesktopPlatform = "macos" | "windows" | "linux";

/** A catalog key under `ui.desktopDownloads.installers`: what a person picks the file by. */
type DesktopInstallerKey =
  | "macAppleSilicon"
  | "macIntel"
  | "windowsExe"
  | "windowsMsi"
  | "linuxDeb"
  | "linuxRpm"
  | "linuxAppImage";

type Installer = {
  readonly key: DesktopInstallerKey;
  readonly url: DesktopDownloadUrl;
};

type PlatformGroup = {
  readonly platform: DesktopPlatform;
  readonly installers: readonly Installer[];
};

const latest = (key: DesktopInstallerKey, file: string): Installer => ({
  key,
  url: mint(`latest/${file}`),
});

/** Every installer of the newest build, grouped by platform in the order the downloads page lists them. */
export const DESKTOP_DOWNLOADS: readonly PlatformGroup[] = [
  {
    platform: "macos",
    installers: [
      latest("macAppleSilicon", "Oxagen_aarch64.dmg"),
      latest("macIntel", "Oxagen_x64.dmg"),
    ],
  },
  {
    platform: "windows",
    installers: [
      latest("windowsExe", "Oxagen_x64-setup.exe"),
      latest("windowsMsi", "Oxagen_x64_en-US.msi"),
    ],
  },
  {
    platform: "linux",
    installers: [
      latest("linuxDeb", "Oxagen_amd64.deb"),
      latest("linuxRpm", "Oxagen.x86_64.rpm"),
      latest("linuxAppImage", "Oxagen_amd64.AppImage"),
    ],
  },
];

/** The page that lists every file of every published version with its SHA-256 checksum. */
export const DESKTOP_DOWNLOADS_PAGE: DesktopDownloadUrl = mint("");
