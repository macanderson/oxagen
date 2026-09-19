/**
 * The downloads block on a release page (`content/docs/releases/v*.mdx`):
 * the desktop app for every platform, the bare `tacho` and `oxagen`
 * executables, and the CLI on npm, all for one version.
 *
 * Every URL is a function of the version. The desktop workflow names its
 * bundles by the tauri bundler's convention and the sidecars by Rust triple
 * (`.github/workflows/desktop.yml`, `tools/packaging/README.md`), and
 * `apps/desktop/scripts/publish-downloads.mjs` lays the installers out under
 * `desktop/<version>/` on downloads.oxagen.sh. So a release page written
 * before the installers finish building points at where they will be, and
 * nothing has to come back to edit it.
 */

const DOWNLOADS = "https://downloads.oxagen.sh";
const REPO = "https://github.com/macanderson/oxagen";

interface Installer {
  label: string;
  file: string;
}

interface Platform {
  name: string;
  note: string;
  installers: Installer[];
}

export function desktopInstallers(version: string): Platform[] {
  return [
    {
      name: "macOS",
      note: "macOS 12 or newer. Open the .dmg and drag Oxagen to Applications.",
      installers: [
        { label: "Apple silicon", file: `Oxagen_${version}_aarch64.dmg` },
        { label: "Intel", file: `Oxagen_${version}_x64.dmg` },
      ],
    },
    {
      name: "Windows",
      note: "Windows 10 or newer, x64.",
      installers: [
        {
          label: "Installer (.exe, current user)",
          file: `Oxagen_${version}_x64-setup.exe`,
        },
        { label: "Installer (.msi)", file: `Oxagen_${version}_x64_en-US.msi` },
      ],
    },
    {
      name: "Linux",
      note: "x86_64. Install the package for your distribution.",
      installers: [
        { label: ".deb (Debian, Ubuntu)", file: `Oxagen_${version}_amd64.deb` },
        {
          label: ".rpm (Fedora, RHEL)",
          file: `Oxagen-${version}-1.x86_64.rpm`,
        },
        {
          label: "AppImage (any distribution)",
          file: `Oxagen_${version}_amd64.AppImage`,
        },
      ],
    },
  ];
}

/** The sidecar binaries attached to the `desktop-v*` release, by triple. */
export const CLI_TARGETS = [
  { name: "macOS, Apple silicon", triple: "aarch64-apple-darwin", ext: "" },
  { name: "macOS, Intel", triple: "x86_64-apple-darwin", ext: "" },
  { name: "Linux, x86_64", triple: "x86_64-unknown-linux-gnu", ext: "" },
  { name: "Windows, x64", triple: "x86_64-pc-windows-msvc", ext: ".exe" },
] as const;

export function installerUrl(version: string, file: string): string {
  return `${DOWNLOADS}/desktop/${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

export function checksumsUrl(version: string): string {
  return `${DOWNLOADS}/desktop/${encodeURIComponent(version)}/SHA256SUMS.txt`;
}

export function cliBinaryUrl(
  version: string,
  name: "tacho" | "oxagen",
  triple: string,
  ext: string,
): string {
  return `${REPO}/releases/download/desktop-v${encodeURIComponent(version)}/${name}-${triple}${ext}`;
}

export function releaseUrls(version: string): {
  platform: string;
  desktop: string;
  npm: string;
} {
  const v = encodeURIComponent(version);
  return {
    platform: `${REPO}/releases/tag/v${v}`,
    desktop: `${REPO}/releases/tag/desktop-v${v}`,
    npm: `https://www.npmjs.com/package/@oxagen/cli/v/${v}`,
  };
}

const card =
  "rounded-xl border border-fd-border bg-fd-card p-4 min-w-0 flex flex-col gap-2";
const label =
  "text-[11px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground";
const link =
  "font-medium text-fd-foreground underline decoration-fd-border underline-offset-4 hover:decoration-fd-foreground";
const mono = "font-mono text-xs text-fd-muted-foreground break-all";

/**
 * `cli={false}` is for a version whose bare executables and npm package were
 * never published (2.1.1 shipped before release.yml existed); the page then
 * shows the app alone and says why.
 */
export function ReleaseDownloads({
  version,
  cli = true,
}: {
  version: string;
  cli?: boolean;
}) {
  const urls = releaseUrls(version);
  return (
    <section
      aria-label={`Downloads for ${version}`}
      className="not-prose my-6 flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-lg font-semibold text-fd-foreground">
          Get {version}
        </h2>
        <p className="text-sm text-fd-muted-foreground">
          Every file has a SHA-256 in{" "}
          <a className={link} href={checksumsUrl(version)}>
            SHA256SUMS.txt
          </a>
          .
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {desktopInstallers(version).map((platform) => (
          <div key={platform.name} className={card}>
            <div className={label}>Oxagen app for {platform.name}</div>
            <p className="text-sm text-fd-muted-foreground">{platform.note}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {platform.installers.map((installer) => (
                <li key={installer.file} className="flex flex-col">
                  <a
                    className={`${link} text-sm`}
                    href={installerUrl(version, installer.file)}
                  >
                    {installer.label}
                  </a>
                  <span className={mono}>{installer.file}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {cli ? (
        <>
          <div className={card}>
            <div className={label}>Command line, without the app</div>
            <p className="text-sm text-fd-muted-foreground">
              The same <code className="font-mono">tacho</code> and{" "}
              <code className="font-mono">oxagen</code> executables the app
              links onto your PATH, one file each, attached to the{" "}
              <a className={link} href={urls.desktop}>
                desktop-v{version} release
              </a>
              . Each has a <code className="font-mono">.sha256</code> beside it.
              Rename the file to <code className="font-mono">tacho</code> or{" "}
              <code className="font-mono">oxagen</code>, make it executable, and
              put it on your PATH.
            </p>
            <div className="overflow-x-auto rounded-lg border border-fd-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-fd-muted/40">
                    <th className={`px-3 py-2 text-left ${label}`}>Platform</th>
                    <th className={`px-3 py-2 text-left ${label}`}>tacho</th>
                    <th className={`px-3 py-2 text-left ${label}`}>oxagen</th>
                  </tr>
                </thead>
                <tbody>
                  {CLI_TARGETS.map((t) => (
                    <tr key={t.triple} className="border-t border-fd-border">
                      <td className="px-3 py-2">
                        <div className="whitespace-nowrap">{t.name}</div>
                        <div className={mono}>{t.triple}</div>
                      </td>
                      {(["tacho", "oxagen"] as const).map((name) => (
                        <td key={name} className="px-3 py-2 align-top">
                          <a
                            className={`${link} font-mono text-xs whitespace-nowrap`}
                            href={cliBinaryUrl(version, name, t.triple, t.ext)}
                            title={`${name}-${t.triple}${t.ext}`}
                          >
                            {name}
                            {t.ext}
                          </a>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={card}>
            <div className={label}>Also in this release</div>
            <ul className="m-0 grid list-none gap-3 p-0 text-sm sm:grid-cols-3">
              <li className="flex flex-col">
                <a className={link} href={urls.npm}>
                  @oxagen/cli {version} on npm
                </a>
                <span className={mono}>
                  npm install -g @oxagen/cli@{version}
                </span>
              </li>
              <li className="flex flex-col">
                <a className={link} href={urls.platform}>
                  Platform release v{version}
                </a>
                <span className={mono}>tag v{version}</span>
              </li>
              <li className="flex flex-col">
                <a className={link} href={`${DOWNLOADS}/`}>
                  downloads.oxagen.sh
                </a>
                <span className={mono}>
                  the current version, every platform
                </span>
              </li>
            </ul>
          </div>
        </>
      ) : (
        <p className="text-sm text-fd-muted-foreground">
          The bare <code className="font-mono">tacho</code> and{" "}
          <code className="font-mono">oxagen</code> executables and the npm
          package were not published for {version}. The app links both onto your
          PATH on first launch.
        </p>
      )}
    </section>
  );
}
