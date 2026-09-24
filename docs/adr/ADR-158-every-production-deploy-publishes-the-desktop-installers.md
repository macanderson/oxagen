# ADR-158: Every production deploy publishes the desktop installers

Status: Accepted
Date: 2026-09-24
Related: ADR-046, ADR-101, ADR-114

## Context

A person enrolls a machine by running `tacho enroll` with a single-use token from the web app. The Oxagen desktop app carries `tacho` and `oxagen` and links them onto the PATH on first launch, so installing the app is the first step of every enrollment. Until now the enrollment screens and the docs linked no installer.

The installers were built only when a release was cut. `release.yml` pushes a `desktop-vX.Y.Z` tag when a release PR merges, and `desktop.yml` builds the four targets and publishes them to https://downloads.oxagen.sh/. Production deploys on every merge to main. On 2026-09-24 main was 861 commits past 2.1.1, the only version on the downloads host, so a person who installed the app from the host got a `tacho` 861 commits older than the platform it enrolled into.

The downloads host serves `desktop/<version>/` immutably for a year, and `publish-downloads.mjs` refuses to publish a version twice. Rebuilding the same version on every deploy would break both rules. A patch release per deploy would put a bump commit, a notes run on a paid model, and a release PR on main for every merge.

## Decision

1. **A production deploy publishes a build of the deployed commit.** `publish-installers` in `pipeline.yml` runs after every `deploy-node` leg has shipped and dispatches `desktop.yml` with `publish: true` and the commit. It carries the same forward-only rule as the deploy jobs (ADR-164): `desktop` is a service of its own, the job holds the `production-desktop` lock, it records the commit it dispatched, and a run whose commit is behind what is already recorded skips rather than replacing newer installers with older ones. `check-deploy-tip --guard` holds it to that shape.

2. **A build is numbered `X.Y.(Z+1)-N`.** N is the number of commits between the commit that set the root version to `X.Y.Z` and the deployed commit (`tools/scripts/desktop-build-version.ts plan`). Semver orders `2.1.1 < 2.1.2-4 < 2.1.2-9 < 2.1.2`, so every build sorts after the release it follows and before the release it leads to. The build legs stamp the version into every manifest of the CI checkout (`setAllVersions(..., { build: true })`) and never commit it, so the app bundle, the Rust crate, and both sidecars name the same build. A numeric pre-release is the one shape every bundle accepts: tauri-bundler turns it into the MSI's fourth version field, which Windows caps at 65535, and `buildVersion` refuses a larger N. The release commit itself (N = 0) is skipped because its tag publishes it.

3. **Builds reach the downloads host, not GitHub releases or the updater feed.** A build gets no tag, no GitHub release, and no `latest.json` on `desktop-latest`. Installed apps still update on releases only. A person who installs `2.1.2-37` is offered `2.1.2` when it ships, because a release outranks every build of its own number.

4. **Version-free links follow the newest version.** `publish-downloads.mjs` copies each installer server side to `latest/<name>` (`Oxagen_aarch64.dmg`, `Oxagen_x64.dmg`, `Oxagen_x64-setup.exe`, `Oxagen_x64_en-US.msi`, `Oxagen_amd64.deb`, `Oxagen.x86_64.rpm`, `Oxagen_amd64.AppImage`), writes `latest.json`, and redraws the page. It does all three only when the version is at least as new as the one `latest.json` names. The copies cache for five minutes and download under their versioned file name. `/desktop/*` stays immutable. The web app's enrollment screens and the docs link `latest/`, and `apps/desktop/src/downloads.ts` owns the names.

5. **Deploy builds share one concurrency group without cancelling.** One build runs, the newest deploy waits, and a newer deploy replaces a waiting one. A burst of merges ends with the tip built. Release tags each keep their own group, so a deploy can never evict a release build (ADR-046).

## Consequences

- `latest/` trails a deploy by the length of one desktop build, or two when a build is already running when the deploy lands.
- Every deploy runs four desktop builds, two of them on macOS runners. Merges that arrive while a build runs collapse into one waiting build, so the count is bounded by the build time, not by the merge rate.
- A failed desktop build leaves `latest/` on the previous build and fails the Desktop run. The platform deploy is unaffected.
- A release and a deploy build can finish in either order. The older one publishes its immutable prefix and moves nothing, and the publish job's check passes when `latest.json` names that version or a newer one.
- A version published before this change has no `latest/` copies. `node apps/desktop/scripts/publish-downloads.mjs --page-only --version 2.1.1`, run with the deploy role, writes them. Otherwise the first deploy build after this change writes them.
- A build's page links the release index instead of a notes page, and it offers no bare-binary release, because a build has neither.
- The build number runs out at 65535 commits after a release. At the current rate that is years away, and `buildVersion` fails the plan with "cut a release" before an installer could carry a wrong number.
