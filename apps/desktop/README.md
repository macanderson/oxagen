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

## Build

```
pnpm --filter @oxagen/desktop sidecars     # compile tacho + oxagen (Node SEA), stage with the host triple
pnpm --filter @oxagen/desktop bundle:dmg   # macOS .dmg (tauri build --bundles dmg)
pnpm --filter @oxagen/desktop bundle       # every bundle the current OS supports
pnpm --filter @oxagen/desktop dev          # tauri dev against Vite on :1420
```

Needs Rust (stable) and, on Linux, `libwebkit2gtk-4.1-dev libappindicator3-dev
librsvg2-dev patchelf`. The sidecars embed the host `node`, so there is no
cross-compile; `.github/workflows/desktop.yml` builds each OS on its own runner
and signs when the Apple / Azure secrets are present.

Icons are generated from the brand tile with `pnpm --filter @oxagen/desktop
icons` (needs `rsvg-convert`) and committed.

## Layout

```
src/            React UI (app.tsx), the sidecar bridge (bridge.ts), the argv
                mapping the panels hand to the CLIs (commands.ts, tested)
src-tauri/      Rust shell: state reads, the two user-scoped API calls, PATH
                install, tray; capabilities/default.json scopes the sidecars
scripts/        sidecars.mjs (stage binaries), icons.mjs
```
