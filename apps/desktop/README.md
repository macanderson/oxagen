# @oxagen/desktop

The Oxagen app: a Tauri 2 shell over the two compiled CLIs. It installs
`oxagen` and `tacho`, signs the machine in to an organization, enrolls the
host under Tacho for Claude Code and Codex, and lets the operator see the
connection, pick or change the workspace the host reports to, add or drop a
wrapper, and unenroll. Spec: `docs/specs/oxagen-desktop/spec.html`.

The app owns no state. Every panel reads the files the CLIs write
(`~/.config/oxagen/config.json`, `~/.config/oxagen/tacho/host.json`, the
collector's `/status` on loopback) and every action runs a sidecar:

| Panel | Reads | Action |
|---|---|---|
| Account | `config.json` | `oxagen login` (browser PKCE), `oxagen logout` |
| This machine | `host.json`, daemon `/status`, `tacho status --json` | `tacho enroll --harness …`, `tacho unenroll [--purge]` |
| Workspace | `POST /v1/user/organizations`, `POST /v1/user/workspaces` | `tacho reassign --org … --workspace …`; `oxagen tacho reassign … --default` when the CLI default should follow |
| Wrappers | `host.harnesses`, hook presence per harness | `tacho reassign --harness …` |
| Command line | PATH | symlinks (macOS/Linux) or `.cmd` shims + user PATH (Windows) |
| Uninstall | — | `remove_local_data` after unenroll; then the platform uninstaller |
| Masthead | the release feed, on demand | `tauri-plugin-updater`: check, download + verify, install, relaunch |

## Build

```
pnpm --filter @oxagen/desktop sidecars     # compile tacho + oxagen (Node SEA), stage with the host triple
pnpm --filter @oxagen/desktop bundle:dmg   # macOS .dmg (tauri build --bundles dmg)
pnpm --filter @oxagen/desktop bundle       # every bundle the current OS supports
pnpm --filter @oxagen/desktop dev          # tauri dev against Vite on :1420
pnpm --filter @oxagen/desktop test:unit    # vitest over src/**/*.test.ts
pnpm --filter @oxagen/desktop test:coverage  # the same with the 90% ratchet
```

Needs Rust (stable) and, on Linux, `libwebkit2gtk-4.1-dev libappindicator3-dev
librsvg2-dev patchelf`. The sidecars embed the host `node`, so there is no
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
`TAURI_SIGNING_PRIVATE_KEY` secret (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can
stay unset for this key). With the secret, `desktop.yml` signs every bundle
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

Locally, `bundle` / `bundle:dmg` need either
`TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/oxagen-desktop.key` or the same
`--config src-tauri/tauri.unsigned.conf.json` after `tauri build`, because
`createUpdaterArtifacts` is on in `tauri.conf.json`.

## Layout

```
src/            React UI (app.tsx), the sidecar bridge (bridge.ts, tested with
                the Tauri modules faked), the tacho status parser
                (tacho-status.ts, pure), the argv mapping the panels hand to
                the CLIs (commands.ts, tested), the updater flow (updater.ts,
                tested)
src-tauri/      Rust shell: state reads, the two user-scoped API calls, PATH
                install, tray; capabilities/default.json scopes the sidecars
                and the updater; tauri.unsigned.conf.json is the no-key overlay
scripts/        sidecars.mjs (stage binaries), icons.mjs
```
