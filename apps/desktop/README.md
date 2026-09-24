# @oxagen/desktop

The Oxagen app: a Tauri 2 shell over the two compiled CLIs. It installs
`oxagen` and `tacho`, signs the machine in to an organization, enrolls the
host under Tacho for Claude Code, Codex, Cursor, and Stella, and lets the
operator see the connection, pick or change the workspace the host reports
to, add or drop a wrapper, and unenroll. Spec: `docs/specs/oxagen-desktop/spec.html`.

## Boundary

- **Owns:** the Tauri shell and its React UI, the argv each panel hands to a
  sidecar (`src/commands.ts`), the sidecar bridge (`src/bridge.ts`), putting
  the two CLIs on PATH (`src-tauri/src/cli_install.rs`), the two user-scoped
  API reads, the tray, and the in-app updater.
- **Does not own:** enrollment, hook writing, or the collector
  ([`@oxagen/tacho`](../../packages/tacho/README.md), run as the `tacho`
  sidecar); sign-in and workspace defaults ([`apps/cli`](../cli/README.md),
  run as the `oxagen` sidecar); the organization and workspace lists
  ([`apps/api`](../api/README.md)); the house tokens and fonts
  ([`@oxagen/ui`](../../packages/ui/README.md)).
- **Depends on:** `@oxagen/ui`, for `styles/house-tokens.css` and
  `styles/fonts/space-grotesk.css` (`src/styles.css`). The `tacho` and
  `oxagen` binaries are staged into the bundle by `scripts/sidecars.mjs`, not
  imported.
- **Used by:** no workspace package imports it. It ships as a signed desktop
  installer.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| Sidecar bridge (`Command.sidecar`) | boundary | `apps/desktop/src/bridge.ts` | Every panel action. `externalBin` in `src-tauri/tauri.conf.json` lists `binaries/tacho` and `binaries/oxagen` |
| Panel-to-argv mapping and the `Harness` union | boundary | `apps/desktop/src/commands.ts` | `apps/desktop/src/app.tsx`. The union must track `WRAPPED_HARNESSES` in `packages/tacho/src/wire.ts` plus `claude-desktop` (ADR-101) |
| Sidecar and updater permissions | boundary | `apps/desktop/src-tauri/capabilities/default.json` | Tauri, at runtime |
| User-scoped API calls (`USER_ROUTES`) | boundary | `apps/desktop/src-tauri/src/lib.rs` | The Workspace panel. Served by `apps/api/src/app.ts` |
| Release feed (`latest.json`) | boundary | `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.endpoints`) | `apps/desktop/src/updater.ts` |

The desktop app bootstraps no kernel gate and invokes no capability directly.

## Entry points

- `src/main.tsx`: the React entry, rendering `src/app.tsx`.
- `src-tauri/src/lib.rs`: the Rust shell.
- `src-tauri/tauri.conf.json`: bundle, sidecars, and updater config.
- `pnpm --filter @oxagen/desktop dev`: `tauri dev` with the Vite UI.

## Rules

- The app owns no state. It reads the files the CLIs write and runs a sidecar
  for every action.
- It never overwrites a PATH entry it did not write.
- A harness list in the UI names all four wrapped harnesses (ADR-101).

## Tests

```bash
pnpm --filter @oxagen/desktop test:unit src/commands.test.ts
```

Never put `--` before the filename. TypeScript tests sit beside their
sources in `src/`. `pnpm --filter @oxagen/desktop test:rust` runs the Rust
unit tests in `src-tauri/`.

## Panels

The app owns no state. Every panel reads the files the CLIs write
(`~/.config/oxagen/config.json`, `~/.config/oxagen/tacho/host.json`, the
collector's `/status` on loopback) and every action runs a sidecar:

| Panel | Reads | Action |
|---|---|---|
| Account | `config.json` | `oxagen login` (browser PKCE), `oxagen logout` |
| This machine | `host.json`, daemon `/status`, `tacho status --json` | `tacho enroll --harness …`, `tacho unenroll [--purge]` |
| Workspace | `POST /v1/user/organizations`, `POST /v1/user/workspaces` | `tacho reassign --org … --workspace …`; `oxagen tacho reassign … --default` when the CLI default should follow |
| Wrappers | `host.harnesses`, hook presence per harness | `tacho reassign --harness …` |
| Command line | PATH, `cli_install` state | linked automatically on every launch; "Link into PATH" / "Remove links" for manual control |
| Uninstall | — | `remove_local_data` after unenroll; then the platform uninstaller |
| Masthead | the release feed, on demand | `tauri-plugin-updater`: check, download + verify, install, relaunch |

### What installing does

The two CLIs ship inside the app bundle (`externalBin`). On every launch the
app links them onto PATH itself — there is nothing to click for a fresh
install to work from a terminal. `cli_install::ensure_cli_installed`
(`src-tauri/src/cli_install.rs`) runs once per launch, off the main thread:

- **Never clobbers what it didn't write.** A missing link is created; a
  symlink (or, on Windows, a `.cmd` shim) that already points at an Oxagen
  location — an older app path, an AppImage/App Translocation copy, or the
  durable `<data-local>/oxagen/bin` copy — is replaced; anything else (a
  Homebrew `oxagen`, a hand-written shim, a plain file) is left alone and
  reported back, never overwritten.
- **Puts the directory on PATH for new terminals too**, not just this
  process: on macOS/Linux it adds a marker-delimited block (`# >>> oxagen
  >>> … # <<< oxagen <<<`) to the one profile file your login shell reads —
  `~/.zprofile` for zsh, `~/.bash_profile` (macOS) / `~/.bashrc` (Linux) for
  bash, `~/.config/fish/conf.d/oxagen.fish` (fish, whole-file, since that
  file is ours alone) — skipped with a manual note for any other shell. A
  Linux `.deb`/`.rpm` install that already put `externalBin` on PATH (e.g.
  `/usr/bin`) is detected and left as-is. Windows keeps the existing
  `.cmd` shim + user-PATH step.
- **Can be turned off.** "Remove links" removes what it made, strips the
  profile block(s), and writes `autoLinkCli: false` to
  `~/.config/oxagen/desktop.json` so the next launch leaves PATH alone;
  "Link into PATH" turns it back on. `desktop_state`'s `cli_install` field
  reports the outcome (`state`: `linked` / `already` / `skipped` /
  `opted_out` / `failed` / `pending`, plus `dir`, `files`, `skipped`,
  `profile`, `note`) so the UI never has to guess what happened.

## Build

```
pnpm dist:local                            # from the repo root: sidecars + app for this OS, installer copied to ~/Desktop
pnpm --filter @oxagen/desktop sidecars     # compile tacho + oxagen (Node SEA), stage with the host triple
pnpm --filter @oxagen/desktop bundle:dmg   # macOS .dmg (tauri build --bundles dmg)
pnpm --filter @oxagen/desktop bundle       # every bundle the current OS supports
pnpm --filter @oxagen/desktop dev          # tauri dev against Vite on :1420
pnpm --filter @oxagen/desktop test:unit    # vitest over src/**/*.test.ts
pnpm --filter @oxagen/desktop test:coverage  # the same with the 90% ratchet
```

## Release

A release is one button: Actions, Release, Run workflow, pick `patch`,
`minor` or `major` (CONTRIBUTING.md, Release Process). The merge of the
release PR pushes `desktop-v<version>`, and `.github/workflows/desktop.yml`
does the rest: four builds, then the `publish` job copies the installers and
`SHA256SUMS.txt` to https://downloads.oxagen.sh/desktop/<version>/, rewrites
the listing page, opens the GitHub release with the bare `tacho` and `oxagen`
binaries attached, and moves the updater feed. Nothing below is needed for
that path.

For a build made some other way:

```
pnpm release:<patch|minor|major>:publish                     # bump, tag, CI builds all four targets, upload (tools/scripts/release-publish.ts)
gh workflow run desktop.yml --ref main                       # build all four targets in CI without a release
pnpm --filter @oxagen/desktop publish:downloads --run <id>   # CI artifacts → https://downloads.oxagen.sh/
pnpm --filter @oxagen/desktop smoke:e2e -- --login --enroll --org <org> --workspace <ws> --cleanup
```

`publish:downloads` streams the run's artifacts to disk (never `gh run
download`, which holds each zip in memory), keeps only the installers for the
package version, writes `SHA256SUMS.txt` to `desktop/<version>/`, uploads the
installers beside it, rewrites the listing page, and invalidates it. `--dir
<folder>` publishes installers already on disk; `--dry-run` prints the uploads.

Those versioned URLs are served `immutable`, a promise to every cache that
fetches them and not only to CloudFront, so publishing a version that is
already there is refused: a corrected build ships as a new version. Pass
`--allow-overwrite` only when the previous publish failed before anyone was
given the URLs, since nothing can pull a stale copy back out of a browser or a
proxy that already has one.

Two things hold that promise up. Before anything is downloaded, the version's
prefix is listed with `aws s3api list-objects-v2`, which exits 0 only when the
listing actually succeeded — so an expired session, a transient S3 error or a
principal with `PutObject` but no `ListBucket` stops the publish instead of
reading as "nothing is there yet" (`aws s3 ls` cannot be used for this: it
exits 1 both for an empty prefix and for a failed command). Then the version is
*reserved*: `SHA256SUMS.txt` is written first with `--if-none-match "*"`, an S3
conditional write, so when two invocations publish the same new version
concurrently one gets a 412 and stops before uploading a single installer
rather than interleaving its uploads with the other's. `--allow-overwrite`
drops that condition. The conditional write needs `aws-cli` 2.17 or newer.

Neither applies to `--dry-run`, which writes nothing: there is no republish to
stop, so the probe never refuses a preview. It still runs, and a dry run of a
version that is already published — or one where the listing could not be made
at all, for want of credentials or of `aws` itself — says so and then prints
the planned uploads anyway. `--dir <folder> --dry-run` therefore needs nothing
but the installers on disk.

`smoke:e2e` (`scripts/e2e-smoke.mjs`, no repo needed — copy it to the test
machine) drives the installed app's sidecars with the wizard's own argv against
the live control plane: sidecar versions, session, the org and workspace
pickers, `tacho detect`, and with `--enroll` the enroll, `tacho status` and a
recorded first run per agent. It writes `oxagen-e2e-smoke-<host>.json`.
Without `--enroll` it changes nothing on the machine.

Needs Rust (stable), a Node built with single-executable support, and, on
Linux, `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`. The
sidecars are Node SEAs, so `sidecars` fails before `tauri build` ever runs on a
Node compiled `--disable-single-executable-application` — which Homebrew's
`node` is. Put an official / nvm build first on PATH for the bundle
(`nvm use 24`, or `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`);
`node -p "process.config.variables.single_executable_application"` says whether
the one you have will do. The sidecars embed the host `node`, so there is no
cross-compile; `.github/workflows/desktop.yml` builds each OS on its own runner
and signs when the Apple / Azure secrets are present.

Icons are generated from the brand tile with `pnpm --filter @oxagen/desktop
icons` (needs `rsvg-convert`) and committed.

## Updates

`src/updater.ts` wraps `@tauri-apps/plugin-updater`: **Check for updates** in
the masthead fetches
`https://github.com/macanderson/oxagen/releases/download/desktop-latest/latest.json`,
and **Install** downloads the bundle for this platform, verifies it against
the minisign public key in `tauri.conf.json` (`plugins.updater.pubkey`),
installs it and relaunches; download milestones stream into the Activity
panel. The pure half (caption, byte formatting, the milestone gate) is
covered by `src/updater.test.ts`.

The key pair came from `tauri signer generate` with no password. The private
half is **not** in the repository: it lives at `~/.tauri/oxagen-desktop.key`
on the machine that generated it, and CI needs it as the
`TAURI_SIGNING_PRIVATE_KEY` secret. The `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
secret can stay unset — but `desktop.yml` must keep passing it to the build
step regardless, because Actions then defines the variable as the empty string
and tauri only prompts for a password when the variable is *absent*. Dropping
that line as an unused secret would hang, then fail, every signed build. With the secret, `desktop.yml` signs every bundle
(the macOS jobs build `app` alongside `dmg`, since only the `app` target
yields the `Oxagen.app.tar.gz` + `.sig` the updater installs) and attaches
`latest.json` to the release; without it, the workflow passes
`--config src-tauri/tauri.unsigned.conf.json` (`createUpdaterArtifacts:
false`) so the build still succeeds, and publishes no feed. The feed is the
rolling `desktop-latest` release, not the repository's `/releases/latest`
(which any platform `v*` release published from a newer commit would take
over): when a `desktop-v*` release is published, the workflow's `feed` job
copies its `latest.json` onto `desktop-latest`, so a draft feeds nothing
until it is published.

Locally, `bundle` / `bundle:dmg` need either the key or the unsigned overlay,
because `createUpdaterArtifacts` is on in `tauri.conf.json`:

```
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/oxagen-desktop.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD= \
  pnpm --filter @oxagen/desktop bundle:dmg
```

The variable is `TAURI_SIGNING_PRIVATE_KEY` (Tauri 2 takes either the key's
contents or a path to it) — there is no `_PATH` form, and a build that sets one
gets through every bundle and then fails on the signature at the very end.
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be set *to the empty string*, not left
unset: this key has no password, but an absent variable makes tauri prompt for
one, which fails with `Device not configured (os error 6)` anywhere without a
TTY. Without the key, pass `--config src-tauri/tauri.unsigned.conf.json` after
`tauri build` instead.

## Layout

```
src/            React UI (app.tsx), the sidecar bridge (bridge.ts, tested with
                the Tauri modules faked), the tacho status parser
                (tacho-status.ts, pure), the argv mapping the panels hand to
                the CLIs (commands.ts, tested), the updater flow (updater.ts,
                tested)
src-tauri/      Rust shell: state reads, the two user-scoped API calls, tray;
                cli_install.rs (PATH install: automatic on launch, and the
                "Link into PATH" / "Remove links" commands, with unit-tested
                decision functions); capabilities/default.json scopes the
                sidecars and the updater; tauri.unsigned.conf.json is the
                no-key overlay
scripts/        sidecars.mjs (stage binaries), icons.mjs
```
