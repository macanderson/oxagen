/**
 * The version a production deploy's desktop build carries (ADR-158).
 *
 * A release is `X.Y.Z`, committed by the release pull request and tagged
 * `desktop-vX.Y.Z`. Every commit main deploys after it is published as a
 * build of the next patch, `X.Y.(Z+1)-N`, where N counts the commits since
 * the release commit. Semver sorts that after `X.Y.Z` and before the release
 * it leads to, so the downloads host's `latest/` links and the in-app updater
 * agree on what is newer, and a build's installers name the commit distance
 * a person can read off `git log`.
 *
 * N is also the fourth field of the Windows MSI version (tauri-bundler turns
 * a numeric pre-release into `X.Y.Z.N`), which Windows caps at 65535.
 */

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/** The MSI product version's fourth field is a 16-bit number. */
export const MAX_BUILD_NUMBER = 65535;

/**
 * The build version for a commit `commitsSinceRelease` commits after the
 * release commit of `release`, or null for the release commit itself, whose
 * installers the `desktop-v*` tag publishes.
 */
export function buildVersion(
  release: string,
  commitsSinceRelease: number,
): string | null {
  const match = RELEASE.exec(release);
  if (match === null)
    throw new Error(`"${release}" is not a release version (X.Y.Z)`);
  if (!Number.isInteger(commitsSinceRelease) || commitsSinceRelease < 0)
    throw new Error(
      `commits since the release must be a whole number, got ${commitsSinceRelease}`,
    );
  if (commitsSinceRelease === 0) return null;
  if (commitsSinceRelease > MAX_BUILD_NUMBER)
    throw new Error(
      `${commitsSinceRelease} commits since ${release} is past the ${MAX_BUILD_NUMBER} a Windows installer version can carry; cut a release`,
    );
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-${commitsSinceRelease}`;
}

/**
 * `git log` arguments that find the commit which set the root package.json
 * to `release`: the one that added the version line, found with the pickaxe
 * so a later edit elsewhere in the file does not count.
 */
export function releaseCommitArgs(release: string): string[] {
  return [
    "log",
    "-1",
    "--format=%H",
    `-S"version": "${release}"`,
    "--",
    "package.json",
  ];
}
