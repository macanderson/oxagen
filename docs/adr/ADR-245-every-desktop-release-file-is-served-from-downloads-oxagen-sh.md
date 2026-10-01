# ADR-245: Every desktop release file is served from downloads.oxagen.sh

- **Status:** Accepted. Mac decided on 2026-10-01.
- **Date:** 2026-10-01
- **Owners:** desktop, release
- **Amends:** ADR-158 decision 3 (where the update feed lives) and ADR-202
  (the feed URL it names).
- **Related:** issue #4959 (this change), issue #4960 (the CLI install
  command's host), issue #4489 (the npm publish), ADR-158, ADR-202.

## Context

On 2026-10-01 the installers were already on downloads.oxagen.sh (ADR-158).
Three other kinds of release file were only on the `desktop-v<version>`
GitHub release:

1. The update feed. Installed apps polled
   `releases/download/desktop-latest/latest.json` on the repository.
2. The updater files it names: the macOS `.app.tar.gz` archives and the
   `.sig` signature of every file the updater installs.
3. The bare `oxagen` and `tacho` executables and their `.sha256` files,
   which the docs, the release notes, and the Homebrew and Scoop templates
   linked.

The repository moved from `macanderson/oxagen` to `oxageninc/product` and
went private, and its owner and visibility changed three times that week. A
private release asset needs a GitHub login. So the feed answered 404, no
installed app could see a new version, and nobody outside the organization
could download an executable.

## Decision

1. **Every file a desktop release ships is served from downloads.oxagen.sh.**
   `apps/desktop/scripts/publish-downloads.mjs` uploads, under the immutable
   `desktop/<version>/` prefix, the installers, the bare executables with a
   `<file>.sha256` beside each, the macOS updater archives, and the `.sig` of
   every file the updater installs. `SHA256SUMS.txt` lists the installers,
   the executables, and the archives. The executables and their `.sha256`
   files also move to `latest/` with the installers.

2. **The update feed is `https://downloads.oxagen.sh/updater/latest.json`.**
   It sits outside `desktop/`, because everything under `desktop/` is
   published once and cached for a year. It is cached for five minutes and
   invalidated on every write. The publish script builds it from the `.sig`
   files of the build, with the eleven platform keys tauri-action wrote into
   the GitHub feed, so an app finds the key it asks for whichever version it
   runs. Each URL in it is the versioned one, so a feed names exactly the
   files it was written for.

3. **The feed carries releases only, and only moves forward.** A release
   (`X.Y.Z`) built with the updater key rewrites it when it is at least as
   new as the version the feed names. A deploy build (`X.Y.Z-N`) never
   touches it, as ADR-158 decision 3 already required of the old feed. A
   build without signatures leaves it as it is.

4. **The app names the host and nothing else.** `plugins.updater.endpoints`
   in `tauri.conf.json` lists the one URL. A GitHub fallback would put the
   repository's visibility back in the path.

5. **The build names the macOS archive by version and architecture.** The
   bundler writes `Oxagen.app.tar.gz` on both Mac legs. The build job renames
   it `Oxagen_<version>_aarch64.app.tar.gz` or `Oxagen_<version>_x64.app.tar.gz`
   before the upload, so the two legs cannot collide and a stale archive
   cannot ship under a new version.

6. **No release URL names a repository owner.** The download page, the docs
   release block, the release notes, and the packaging templates link the
   host. `publish-downloads.mjs --run` reads the repository from `--repo`,
   then `GITHUB_REPOSITORY`, then the checkout's remote.
   `tools/scripts/release-hosting.tree.test.ts` fails when an app, docs, or
   packaging file links a GitHub release again.

7. **The GitHub release stays as a mirror.** tauri-action still opens it,
   the build legs still attach the executables, and the `desktop-latest`
   feed still moves. People with repository access can use it, and nothing a
   person or an installed app needs depends on it.

## Consequences

- An app installed before this change polls the GitHub feed and cannot learn
  the new address, because it cannot read the feed that would tell it. Each
  one needs one manual reinstall from downloads.oxagen.sh. If the repository
  is ever public again, the mirrored GitHub feed serves those apps the next
  release, which moves them to the host by itself.
- Until the first release after this change, the host's feed answers 404. An
  app built from main in that window reports a failed check from the
  masthead button and stays quiet in the background watch.
- The signature scheme is unchanged: the same minisign key signs the same
  files, and the app checks each download against the same public key.
- The host needs no infrastructure change. `infra/stacks-new/oxagen/downloads.tf`
  already serves the bucket through CloudFront, and
  `infra/stacks-new/ci-deploy/roles.tf` already lets the deploy role write any
  key in it and invalidate the distribution.
- 2.1.2 and 2.1.3 attached their executables only to the GitHub release, and
  their npm publish failed (#4489). Their release pages now say the
  executables and the npm package are not available, and the app links both
  commands onto your PATH.
- The CLI install script's host, `cli.oxagen.sh`, does not resolve. The
  installation guide now leads with the app and the executable on the host,
  and #4960 asks Mac which host the install command should use.
