/**
 * The newest Oxagen app for every platform, at the version-free names on
 * downloads.oxagen.sh. Pages that tell you to enroll a machine or wrap an
 * agent show this block, because the app is what puts the `oxagen` and
 * `tacho` commands on PATH (apps/desktop/README.md). The block carries no
 * heading of its own: the page puts it under one, so it shows in the table
 * of contents. A release page
 * (`content/docs/releases/v*.mdx`) pins one version with `ReleaseDownloads`
 * instead.
 *
 * The names are not chosen here. `apps/desktop/scripts/publish-downloads.mjs`
 * copies each build to `latest/<name>`, and the names are the `latest` field
 * of the rules in `apps/desktop/src/downloads.ts`; a rename there breaks
 * these links, so change them together. The web app carries the same table
 * in `apps/app/src/shared/desktop-downloads.ts`. The links are static on
 * purpose: nothing on the page fetches `latest.json`, so a slow host cannot
 * leave the block empty.
 */

const DOWNLOADS = "https://downloads.oxagen.sh";

interface Installer {
  label: string;
  file: string;
}

interface Platform {
  name: string;
  note: string;
  installers: Installer[];
}

export const LATEST_INSTALLERS: Platform[] = [
  {
    name: "macOS",
    note: "macOS 12 or newer. Open the .dmg and drag Oxagen to Applications. Builds are not yet notarized, so macOS refuses the first launch. Choose Done, then click Open Anyway in System Settings > Privacy & Security.",
    installers: [
      { label: "Apple silicon (.dmg)", file: "Oxagen_aarch64.dmg" },
      { label: "Intel (.dmg)", file: "Oxagen_x64.dmg" },
    ],
  },
  {
    name: "Windows",
    note: "Windows 10 or newer, x64.",
    installers: [
      { label: "Installer (.exe)", file: "Oxagen_x64-setup.exe" },
      { label: "Installer (.msi)", file: "Oxagen_x64_en-US.msi" },
    ],
  },
  {
    name: "Linux",
    note: "x86_64. Install the package for your distribution.",
    installers: [
      { label: ".deb (Debian, Ubuntu)", file: "Oxagen_amd64.deb" },
      { label: ".rpm (Fedora, RHEL)", file: "Oxagen.x86_64.rpm" },
      { label: "AppImage (any distribution)", file: "Oxagen_amd64.AppImage" },
    ],
  },
];

export function latestInstallerUrl(file: string): string {
  return `${DOWNLOADS}/latest/${encodeURIComponent(file)}`;
}

const card =
  "rounded-xl border border-fd-border bg-fd-card p-4 min-w-0 flex flex-col gap-2";
const label =
  "text-[11px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground";
const link =
  "font-medium text-fd-foreground underline decoration-fd-border underline-offset-4 hover:decoration-fd-foreground";
const mono = "font-mono text-xs text-fd-muted-foreground break-all";

export function LatestDownloads() {
  return (
    <section
      aria-label="Install the Oxagen app"
      className="not-prose my-6 flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="text-sm font-medium text-fd-foreground">
          The newest Oxagen app for each platform
        </p>
        <a className={`${link} text-sm`} href={`${DOWNLOADS}/`}>
          Every version, with SHA-256 checksums
        </a>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {LATEST_INSTALLERS.map((platform) => (
          <div key={platform.name} className={card}>
            <div className={label}>Oxagen app for {platform.name}</div>
            <p className="text-sm text-fd-muted-foreground">{platform.note}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {platform.installers.map((installer) => (
                <li key={installer.file} className="flex flex-col">
                  <a
                    className={`${link} text-sm`}
                    href={latestInstallerUrl(installer.file)}
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

      <p className="text-sm text-fd-muted-foreground">
        On first launch the app links the{" "}
        <code className="font-mono">oxagen</code> and{" "}
        <code className="font-mono">tacho</code> commands onto your PATH, so a
        new terminal can run them.
      </p>
    </section>
  );
}
