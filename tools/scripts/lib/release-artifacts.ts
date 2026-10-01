/**
 * What one release of the distributables is made of, by name, before any of
 * it exists. `.github/workflows/desktop.yml` builds one job per target and
 * the tauri bundler names every file from the version, so the full asset
 * list is known at bump time. That is what lets the release notes carry a
 * link to every installer while they are still being written, and what lets
 * `release-publish.ts` refuse to call a release published while a file the
 * notes link to is missing.
 *
 * The table mirrors `tools/packaging/README.md`. When the matrix gains a
 * target, add it here too, or the publish stops with the new asset unnamed.
 */

export const GITHUB_REPO = "macanderson/oxagen";
export const DOWNLOADS_HOST = "downloads.oxagen.sh";
export const NPM_CLI_PACKAGE = "@oxagen/cli";

export interface ReleaseTarget {
  triple: string;
  os: "macOS" | "Windows" | "Linux";
  /** How a person picks it: "Apple silicon", "x86_64". */
  variant: string;
  /** Installer file names for the version, in the order the page shows them. */
  installers: (version: string) => string[];
  /** The bare `tacho` and `oxagen` executables, named by the triple. */
  binaries: string[];
}

const exe = (triple: string, name: string) =>
  `${name}-${triple}${triple.includes("windows") ? ".exe" : ""}`;

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    triple: "aarch64-apple-darwin",
    os: "macOS",
    variant: "Apple silicon",
    installers: (v) => [`Oxagen_${v}_aarch64.dmg`],
    binaries: ["tacho", "oxagen"].map((n) => exe("aarch64-apple-darwin", n)),
  },
  {
    triple: "x86_64-apple-darwin",
    os: "macOS",
    variant: "Intel",
    installers: (v) => [`Oxagen_${v}_x64.dmg`],
    binaries: ["tacho", "oxagen"].map((n) => exe("x86_64-apple-darwin", n)),
  },
  {
    triple: "x86_64-pc-windows-msvc",
    os: "Windows",
    variant: "x86_64",
    installers: (v) => [
      `Oxagen_${v}_x64-setup.exe`,
      `Oxagen_${v}_x64_en-US.msi`,
    ],
    binaries: ["tacho", "oxagen"].map((n) => exe("x86_64-pc-windows-msvc", n)),
  },
  {
    triple: "x86_64-unknown-linux-gnu",
    os: "Linux",
    variant: "x86_64",
    installers: (v) => [
      `Oxagen_${v}_amd64.deb`,
      `Oxagen-${v}-1.x86_64.rpm`,
      `Oxagen_${v}_amd64.AppImage`,
    ],
    binaries: ["tacho", "oxagen"].map((n) =>
      exe("x86_64-unknown-linux-gnu", n),
    ),
  },
];

export interface ExpectedAssets {
  /** Installers, served from downloads.oxagen.sh and attached to the release. */
  installers: string[];
  /** Bare executables, attached to the GitHub release only. */
  binaries: string[];
  /** `<asset>.sha256` files the release must carry for the binaries. */
  checksums: string[];
}

/** Every file a complete release of `version` carries. */
export function expectedAssets(version: string): ExpectedAssets {
  const installers = RELEASE_TARGETS.flatMap((t) => t.installers(version));
  const binaries = RELEASE_TARGETS.flatMap((t) => t.binaries);
  return {
    installers,
    binaries,
    checksums: binaries.map((b) => `${b}.sha256`),
  };
}

export function releaseTag(version: string): string {
  return `desktop-v${version}`;
}

export function releaseUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/tag/${releaseTag(version)}`;
}

export function releaseAssetUrl(version: string, file: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/${releaseTag(version)}/${encodeURIComponent(file)}`;
}

export function downloadUrl(version: string, file: string): string {
  return `https://${DOWNLOADS_HOST}/desktop/${version}/${encodeURIComponent(file)}`;
}

/**
 * The install section of the release notes: one link per artifact, grouped
 * the way a reader picks (the app by OS, then the bare CLIs, then npm).
 */
export function installSection(version: string): string {
  const lines: string[] = ["## Install", ""];

  lines.push(
    `The desktop app installs \`oxagen\` and \`tacho\` and links them onto PATH. Every file below is also on the [GitHub release](${releaseUrl(version)}).`,
    "",
  );
  for (const t of RELEASE_TARGETS) {
    const links = t
      .installers(version)
      .map((f) => `[${f}](${downloadUrl(version, f)})`)
      .join(", ");
    lines.push(`- ${t.os}, ${t.variant}: ${links}`);
  }
  lines.push(
    `- Checksums: [SHA256SUMS.txt](${downloadUrl(version, "SHA256SUMS.txt")})`,
    "",
    "Command line only, no app:",
    "",
  );
  for (const t of RELEASE_TARGETS) {
    const links = t.binaries
      .map((b) => `[${b}](${releaseAssetUrl(version, b)})`)
      .join(", ");
    lines.push(`- ${t.os}, ${t.variant}: ${links}`);
  }
  lines.push(
    `- npm: \`npm install -g ${NPM_CLI_PACKAGE}@${version}\` ([package page](https://www.npmjs.com/package/${NPM_CLI_PACKAGE}/v/${version}))`,
    "- Each executable has a `.sha256` beside it on the release.",
    "",
  );
  return lines.join("\n");
}
