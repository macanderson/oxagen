# ADR-253: Every production deploy publishes the CLI to npm

- **Status:** Accepted. Mac decided on 2026-10-02. Amended 2026-10-03
  (#5203): `npm.yml` publishes under the `candidate` tag, and `latest` moves
  to a version only after npx runs its tarball.
- **Date:** 2026-10-02
- **Owners:** cli, release
- **Related:** issue #4489 (npm publishing failed), ADR-158 (every
  production deploy publishes the desktop installers), ADR-247 (release files
  on downloads.oxagen.sh), ADR-240 (where secrets live).

## Context

On 2026-10-02 npm held `@oxagen/cli` 1.0.1, published on 2026-07-05, while
the platform was at 2.1.3. `npm install -g @oxagen/cli` installed a CLI three
months and a major version behind the API it calls.

Only a release published the CLI, from the `tag` job in `release.yml`. That
job's last step failed for v2.1.2 and v2.1.3 with `E404` on the `PUT`, which
is how npm answers a token that cannot write the package. Nothing else
watched the job, so the failure surfaced only as issue #4489. Releases are
cut by hand, so even a working token left npm behind main between releases.

The desktop app already solved the same problem for installers (ADR-158):
every deploy that changes the installer sources publishes a build of main,
numbered `X.Y.(Z+1)-N`, and the `latest/` links on downloads.oxagen.sh only
move forward.

## Decision

1. **Every production deploy publishes the CLI it shipped.** `publish-cli`
   in `pipeline.yml` runs after every `deploy-node` leg succeeds and
   dispatches `npm.yml` with the deployed commit. The CLI on npm never runs
   ahead of the API it talks to.
2. **Versions follow ADR-158.** A commit N commits after release `X.Y.Z`
   publishes as `X.Y.(Z+1)-N`, the number its desktop build carries. The
   release commit publishes as `X.Y.Z`. `npm.yml` gets the number from
   `desktop-build-version.ts plan` and stamps it into the manifests before
   the bundle, so `oxagen --version` reports it.
3. **`latest` follows production and only moves forward.** Builds and
   releases both publish under `latest`, because the install docs tell
   people to run `npm install -g @oxagen/cli`, which installs `latest`, and
   the downloads host's `latest/` links already serve builds of main. A
   `next` tag for builds would leave `npm install -g` behind main until
   someone cut a release, which is the failure in #4489.
   `tools/scripts/lib/npm-cli.ts` skips a version older than the newest one
   on npm. Every run, including one that publishes nothing, then points
   `latest` at the newest version npm holds, because two runs can publish
   at once. It reads `latest` again right before that write and only moves
   it forward, because a read can trail a publish by a few seconds.
4. **Releases publish from their tag as well.** The `vX.Y.Z` tag starts
   `npm.yml`, so a release reaches npm even when a newer merge superseded
   its deploy. A release tag and the schedule each run in a concurrency
   group of their own, so a deploy dispatch can never evict them.
5. **A daily run catches up.** It publishes the commit the production API
   runs when npm is behind it. That covers a dispatch a newer one replaced,
   a failed run, and the first day after the token is replaced.
6. **A stored token, rotated every 90 days.** `npm.yml` publishes with the
   `NPM_TOKEN` repository secret, a granular token with read and write on
   `@oxagen/cli`. npm caps such a token at 90 days, and Mac rotates it on a
   scheduled routine. Trusted publishing through OIDC needs no stored
   token, but on 2026-10-02 npm supported it only on GitHub-hosted
   runners, and this repository's CI runs on its own (ADR-246). From a
   private repository it would also publish without provenance. Mac chose
   the token. Revisit this when npm supports self-hosted runners.
7. **A failed publish leaves main green.** The publish runs in its own
   workflow, the way `desktop.yml` builds installers. When it ran inside
   `pipeline.yml`, an expired token would fail a `main` job, file a P0
   `DEPLOYMENT-FAILURE` issue, and send agents to repair `main` for a
   credential only Mac can replace.

## Consequences

- `npm install -g @oxagen/cli` installs the version production runs, within
  one deploy, or within a day when deploys stop.
- npm gains one version per deploy that runs to the end. Main took 29 to 75
  merges a day in the week of 2026-09-28, and fewer deploys than that, so
  expect dozens of versions a day. A burst of merges publishes only its tip,
  because the pipeline's `preflight` skips a superseded push and `npm.yml`
  keeps one waiting dispatch. Skipped commits ship inside the next version.
- Each publish costs one dependency install and one bundle on a small runner.
  A path filter on the CLI's sources could cut that later. The daily run
  would still catch any change the filter missed.
- A build of main is a prerelease in semver terms. A range such as
  `^2.1.3` does not match `2.1.4-12`. Only a global install or an exact
  version reads it, which is how the CLI is installed.
- npm's reads trail its writes. After the first publish on 2026-10-02, the
  package list and the `latest` tag took about four minutes to show
  `2.1.4-363`, while the version's own tarball was served at once. So
  `npm.yml` checks the published CLI from its tarball URL, and it treats
  npm's refusal to publish a version twice as proof that another run
  published it. While reads lag, two overlapping runs can still leave
  `latest` on the older version. The next run, or the daily one, moves it
  forward.
- An expired or revoked token fails `npm.yml` on every deploy and every day
  until it is replaced. Nothing else alerts. Mac's rotation routine is the
  control, and checking the next `npm.yml` run is its last step.
- The `release.yml` tag job no longer needs `NPM_TOKEN`. Its fallback, used
  when `RELEASE_TOKEN` is missing, now dispatches `npm.yml` on the tag
  alongside `desktop.yml`, and the job holds `actions: write` so the
  dispatch API accepts it.

## Amendment, 2026-10-03 (#5203)

The tarball was not served at once after all. On 2026-10-02 the run on
`c7226a6` published `2.1.4-378` at 18:07:18Z, and its tarball URL answered 404
until 18:12:46Z, about 5½ minutes later. The check gave up after about 100
seconds, so the run failed although the publish worked. Every deploy dispatch
on 2026-10-03 failed at the same check. The publish had also moved `latest`
already, so for those minutes `npm install -g @oxagen/cli` fetched a tarball
that answered 404.

- **A checked publish goes out under `candidate`.** `publish-cli-npm.ts
  --verify`, which `npm.yml` runs, publishes under the `candidate` dist-tag.
  `latest` moves to the version only after `npx <tarball URL> --version`
  prints it. Decision 3 still holds: every build and release reaches
  `latest`, a few minutes later than before. `candidate` is a staging tag,
  not the `next` channel decision 3 turned down. Nothing tells people to
  install it.
- **The check waits at least 10 minutes.** It pauses 20 seconds after the
  first try, 10 seconds longer after each try after that, and at most a
  minute. Each try's log line says how long the check has waited.
- **A failed check leaves `latest` alone.** The run fails with a message that
  names the version, where `latest` stayed, and how to move it by hand once
  the tarball works.
- **Every move of `latest` is checked.** A run that publishes nothing still
  moves `latest` to the newest version npm holds, as decision 3 says. In
  `npm.yml` that version must pass the same check first. So a version whose
  check failed stays off `latest` until a later run's check passes. Then the
  next run, or the daily one, moves `latest` to it.
- **`release.ts` and `release-publish.ts` are unchanged.** They run from a
  laptop, pass no check, and still publish under `latest`.
- **`npm.yml`'s job may run 30 minutes,** up from 20, to fit the longer wait.
