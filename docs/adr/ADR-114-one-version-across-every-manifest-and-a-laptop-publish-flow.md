# ADR-114: One version across every manifest, and a publish flow that runs from a laptop

**Date:** 2026-09-19
**Status:** Accepted
**Amends:** ADR-005 (the Changesets half is retired; the single-version rule stands)

## Context

ADR-005 chose one version for the whole monorepo and named Changesets as the tool. Changesets never ran here: there is no `.changeset/` directory, `release.yml`'s `changeset publish` step is skipped on every tag because its `if` reads a job-level variable that is never set, and `tools/scripts/release.ts` has done the bump, the notes, and the tag since. The rule outlived the tool.

The rule was also narrower than the tree. `release.ts` rewrote every workspace `package.json` and nothing else, while the desktop app's `Cargo.toml` and `Cargo.lock` carried their own copy of the number, and two workspace packages had drifted (`apps/app` to 3.0.0, `packages/rules` to 0.1.0) with nothing to say so. Tacho repeated the version in two source constants.

Publishing was a sequence of hand steps: run `release.ts`, push, push the tags, wait for `desktop.yml`, run `publish-downloads.mjs` with the run id, publish the CLI, write the release body. Nothing tied the notes to the artifacts, and no release since v2.0.0 was published on GitHub.

## Decision

1. **One version, every manifest, whatever the language.** `tools/scripts/lib/versions.ts` discovers every tracked manifest that carries a version (`package.json` for the root and each workspace member, `Cargo.toml` with a `[package]` table and that crate's `Cargo.lock` entry, `pyproject.toml` with a `[project]` table) and writes one number into all of them. `pnpm check:versions` runs in `check:contracts`, so CI fails when any of them drifts. Source code reads the version from its manifest (`packages/tacho/src/version.ts`) rather than repeating it.

2. **The notes diff from the last published version.** The base for the release notes is the newest non-draft GitHub release whose tag is `vX.Y.Z` or `desktop-vX.Y.Z`, not the newest tag. A tag that never shipped is not a release boundary. The notes end with an install section that links every installer and executable of the release by its published name, which `tools/scripts/lib/release-artifacts.ts` knows from the version alone because the bundler names every file from it.

3. **The publish flow runs from the laptop and lets CI do the one thing the laptop cannot.** `pnpm release:<bump>:publish` (`tools/scripts/release-publish.ts`) bumps, writes the notes, commits on `release/vX.Y.Z`, tags `vX.Y.Z` and `desktop-vX.Y.Z`, pushes, opens the PR, waits for `desktop.yml` to build the four targets (the sidecars embed the runner's node, so there is no cross-compile), then uploads to downloads.oxagen.sh, npm, and the GitHub release, checks that every file the notes link to is attached, and publishes the release. Every upload step is idempotent, so a run resumes with `--publish-only` and a CI job that publishes the same version first does no harm.

4. **`pnpm dist:local` is the local build.** It builds the sidecars and the desktop app from the tree for the current OS and copies the installer to the Desktop. It bumps nothing and publishes nothing.

## Consequences

- A hand edit that sets one package to its own version fails CI with the file named. `pnpm check:versions --fix` repairs it.
- A new language in the tree joins the lockstep by adding a kind to `versions.ts`, not a new script.
- The release commit lands on main through a pull request like any other change. The tags point at that commit whether or not the PR has merged, so a squash merge leaves the tag on a commit that is not on main. The release is the tag and its assets; main carries the same tree.
- `release.yml` is left as it is. Its publish step never runs, and #3496 proposes a CI-cut release flow that rewrites it. The laptop flow and a CI-cut flow can coexist: both produce the same tags and the same assets, and the upload steps skip what exists.
- `tools/packaging/` templates and `desktop.yml`'s matrix stay the source of the asset names. When the matrix gains a target, `release-artifacts.ts` must name its files or the publish stops with the release left as a draft.
