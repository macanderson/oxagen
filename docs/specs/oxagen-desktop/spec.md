# Oxagen Desktop: product specification, rev 1

| | |
|---|---|
| **Status** | Rev 1, built and verified on macOS; Linux and Windows bundles not yet run |
| **Date** | 2026-09-13 |
| **Owner** | Mac Anderson |
| **Source** | `docs/specs/oxagen-desktop` on branch `worktree-oxagen-installer`; Tacho 2.1.1 |
| **Ships as** | macOS **.dmg**; Linux **.deb / .rpm / .AppImage**; Windows **.msi / .exe** |
| **Summary** | The Oxagen app puts a machine under Oxagen control: it installs the `oxagen` CLI and the Tacho wrapper for Claude Code and Codex, signs the machine in to an organization, enrolls it against a workspace, and gives the operator one window to see the connection, move the host to another workspace or org, add or drop a wrapper, sign out, and unenroll. |


## 1. What rev 1 ships

- A signed-capable installer per OS from one Tauri 2 project (`apps/desktop`): `.dmg` on macOS, `.deb`, `.rpm` and `.AppImage` on Linux, `.msi` and NSIS `.exe` on Windows.
- The app is a running management UI, not a wizard: connection status, the org and workspace the host reports to, wrapper state per harness, collector health, the last action's output, the collector log.
- Sign in to an Oxagen org through the browser (the CLI's PKCE loopback flow), sign out, switch org.
- Enroll the machine and pick the workspace; change the workspace or org later with `tacho reassign`, which keeps the device key so the fleet page sees one continuous host.
- Wrap Claude Code and Codex. Codex is a settings writer over the same hook, verified against the upstream hooks documentation (§6).
- Install the CLIs on PATH from the app; remove the links again.
- Uninstall the wrapper: `tacho unenroll` strips the hooks in both harnesses, stops the service, revokes on the control plane and deletes the credentials; `--purge` drops the local event log; the app then removes `~/.config/oxagen` and points at the platform uninstaller.
- Windows support in Tacho itself: a per-user Task Scheduler service, loopback TCP for the hook, `cmd.exe` quoting.
- Not yet: signing by default. Code signing runs only when the Apple / Azure secrets exist in CI (§9); a local build is ad-hoc signed and Gatekeeper warns on first open.
- Not yet: an in-app updater; a new version is a new download (§11).


## 2. The rule the app is built on

The app owns no state. Every panel reads the files the CLIs already write, and every action that changes the machine runs one of the two CLIs bundled inside the app. A user who does things from the terminal and a user who does them from the app end up in identical files, and `tacho status` and the Connection panel can never disagree.

| File | What it holds |
|---|---|
| `~/.config/oxagen/config.json` | the platform session `oxagen login` writes: token, org and workspace slugs, API and app URLs. Read for the Account panel; the token never crosses into the webview (the Rust shell attaches it to the two picker calls). |
| `~/.config/oxagen/tacho/host.json` | the enrollment `tacho enroll` writes: agent key, enrollment id, org and workspace, harnesses, port, service and hook command lines, bundle facts. Read minus its secrets for the This machine panel. |
| `127.0.0.1:<port>/status` | the collector daemon, with the per-install bearer from `host.json`. Polled every 5 s; `tacho status --json` every 20 s for hook presence per event. |
| `~/.config/oxagen/tacho/tachod.log` | the service's stdout and stderr, tailed in the Activity panel. |

<figure>
<svg viewBox="0 0 960 330" role="img" aria-labelledby="fig1t" font-family="Space Grotesk, Helvetica Neue, Arial, sans-serif" font-size="13">
  <title id="fig1t">The app, its two sidecars, the files they share, and the control plane</title>
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="var(--muted)"/>
    </marker>
  </defs>
  <!-- App -->
  <rect x="20" y="20" width="300" height="290" rx="12" fill="var(--panel)" stroke="var(--border)"/>
  <text x="36" y="44" fill="var(--gold-text)" font-size="11" font-weight="500" letter-spacing="1">OXAGEN.APP · TAURI 2</text>
  <rect x="36" y="58" width="268" height="88" rx="8" fill="var(--hl)" stroke="var(--border)"/>
  <text x="48" y="80" fill="var(--text)" font-weight="600">Management UI (React)</text>
  <text x="48" y="100" fill="var(--body)">Account · This machine · Workspace</text>
  <text x="48" y="118" fill="var(--body)">Wrappers · Command line · Activity · Uninstall</text>
  <text x="48" y="136" fill="var(--muted)" font-size="12">gold = the next step, one per screen</text>
  <rect x="36" y="160" width="268" height="56" rx="8" fill="var(--hl)" stroke="var(--border)"/>
  <text x="48" y="182" fill="var(--text)" font-weight="600">Rust shell</text>
  <text x="48" y="200" fill="var(--body)">state reads · /v1/user/* · PATH links · tray</text>
  <rect x="36" y="230" width="128" height="64" rx="8" fill="var(--bg)" stroke="var(--rule)"/>
  <text x="48" y="252" fill="var(--text)" font-weight="600" font-family="ui-monospace, Menlo, monospace" font-size="13">tacho</text>
  <text x="48" y="270" fill="var(--muted)" font-size="12">enroll · reassign</text>
  <text x="48" y="286" fill="var(--muted)" font-size="12">daemon · hook · unenroll</text>
  <rect x="176" y="230" width="128" height="64" rx="8" fill="var(--bg)" stroke="var(--rule)"/>
  <text x="188" y="252" fill="var(--text)" font-weight="600" font-family="ui-monospace, Menlo, monospace" font-size="13">oxagen</text>
  <text x="188" y="270" fill="var(--muted)" font-size="12">login · logout</text>
  <text x="188" y="286" fill="var(--muted)" font-size="12">node SEA, no node needed</text>
  <!-- Files -->
  <rect x="380" y="20" width="240" height="150" rx="12" fill="var(--panel)" stroke="var(--border)"/>
  <text x="396" y="44" fill="var(--gold-text)" font-size="11" font-weight="500" letter-spacing="1">~/.config/oxagen</text>
  <text x="396" y="70" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">config.json</text>
  <text x="396" y="88" fill="var(--muted)" font-size="12">session · org · workspace</text>
  <text x="396" y="114" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">tacho/host.json</text>
  <text x="396" y="132" fill="var(--muted)" font-size="12">enrollment · device key · bundle</text>
  <text x="396" y="156" fill="var(--muted)" font-size="12">wal/ · spool/ · tachod.log</text>
  <!-- Daemon + harnesses -->
  <rect x="380" y="190" width="240" height="120" rx="12" fill="var(--panel)" stroke="var(--border)"/>
  <text x="396" y="214" fill="var(--gold-text)" font-size="11" font-weight="500" letter-spacing="1">ON THE HOST</text>
  <text x="396" y="238" fill="var(--text)" font-weight="600">tachod</text>
  <text x="450" y="238" fill="var(--muted)" font-size="12">launchd · systemd · schtasks</text>
  <text x="396" y="262" fill="var(--text)" font-weight="600">Claude Code</text>
  <text x="486" y="262" fill="var(--muted)" font-size="12">~/.claude/settings.json hooks + OTel</text>
  <text x="396" y="286" fill="var(--text)" font-weight="600">Codex</text>
  <text x="446" y="286" fill="var(--muted)" font-size="12">~/.codex/hooks.json command hooks</text>
  <!-- Control plane -->
  <rect x="680" y="20" width="260" height="290" rx="12" fill="var(--panel)" stroke="var(--border)"/>
  <text x="696" y="44" fill="var(--gold-text)" font-size="11" font-weight="500" letter-spacing="1">CONTROL PLANE · api.oxagen.sh</text>
  <text x="696" y="72" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">POST /v1/user/organizations</text>
  <text x="696" y="90" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">POST /v1/user/workspaces</text>
  <text x="696" y="108" fill="var(--muted)" font-size="12">the pickers</text>
  <text x="696" y="140" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">…/tacho/enrollments</text>
  <text x="696" y="158" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">…/tacho/enrollments/revoke</text>
  <text x="696" y="176" fill="var(--muted)" font-size="12">enroll · reassign · unenroll</text>
  <text x="696" y="208" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">ingest_tacho_events</text>
  <text x="696" y="226" fill="var(--text)" font-family="ui-monospace, Menlo, monospace" font-size="12.5">bundle · commands</text>
  <text x="696" y="244" fill="var(--muted)" font-size="12">the daemon's loop</text>
  <text x="696" y="280" fill="var(--body)" font-size="12.5">Fleet page: hosts, sessions,</text>
  <text x="696" y="298" fill="var(--body)" font-size="12.5">pause · resume · revoke</text>
  <!-- arrows -->
  <line x1="320" y1="95" x2="380" y2="95" stroke="var(--muted)" marker-end="url(#arr)"/>
  <text x="326" y="88" fill="var(--dim)" font-size="11">reads</text>
  <line x1="320" y1="262" x2="380" y2="262" stroke="var(--muted)" marker-end="url(#arr)"/>
  <text x="326" y="255" fill="var(--dim)" font-size="11">writes</text>
  <line x1="620" y1="250" x2="680" y2="250" stroke="var(--muted)" marker-end="url(#arr)"/>
  <line x1="320" y1="188" x2="680" y2="80" stroke="var(--muted)" stroke-dasharray="4 4" marker-end="url(#arr)"/>
</svg>
<figcaption>Everything the UI shows comes from the left-to-middle reads; everything it changes goes through a sidecar, which writes the same files the terminal user's commands would. The dashed line is the only direct network call the app makes: the two user-scoped picker routes, with the session token attached in Rust.</figcaption>
</figure>


## 3. The panels

| Panel | Shows | Controls | Runs |
|---|---|---|---|
| Masthead | wordmark, connection glyph (● connected, ◐ enrolled but collector silent, ○ not enrolled), host status, app version | none | none |
| Account | signed in to *org*, the CLI's default workspace, the API URL; or *Session expired* when the saved token gets a 401 | Sign in · Switch organization… · Sign out | `oxagen login`, `oxagen logout` |
| This machine | agent key, reports-to slugs, enrollment id, status and mode, bundle version and age, collector uptime / spool / last ingest, service state, attestation tier, expiry | org and workspace pickers before enrollment; **Enroll this machine**; Unenroll… (two-step) with *also delete the local event log* | `tacho enroll --org … --workspace … --harness …`, `tacho unenroll [--purge]` |
| Workspace | the org and workspace the host reports to, as pickers listing the operator's orgs and that org's workspaces | pick another; the Apply button appears in Wrappers | `tacho reassign --org … --workspace …` |
| Wrappers | Claude Code and Codex with hook completeness per harness and the detected version | checkboxes (never empty); **Reassign to …** / **Apply wrappers**; Reset | `tacho reassign --harness …` |
| Command line | where `oxagen` and `tacho` resolve on PATH | Link into `~/.local/bin` (or `%LOCALAPPDATA%\Oxagen\bin`) · Remove links | Rust: symlinks, or `.cmd` shims plus the user PATH |
| Activity | streamed output of the last action; the collector log tail | Open the log file | `tacho status --json`, log tail |
| Uninstall | the order: unenroll, remove local data, then the platform uninstaller | Remove local data… (only when unenrolled) · Fleet page | Rust: delete `~/.config/oxagen` |

The gold primary is the next step and moves with it: **Sign in** when there is no session, **Enroll this machine** when there is no enrollment, **Reassign** / **Apply** when a picker differs from the host, and nothing otherwise. Destructive controls (sign out, unenroll, remove data) use the danger treatment and confirm in place; gold never encodes a state.


## 4. Moving a host between workspaces

The host API key is minted for the workspace at enrollment, so a move is a revoke plus a fresh enrollment, not an edit. `tacho reassign` does it as one step and keeps what makes the host recognisable:

1. Revoke the current enrollment with the operator's session (best effort; an offline host stays marked revoked locally and the fleet page can finish it).
2. Strip the old enrollment's hook groups from `~/.claude/settings.json` and `~/.codex/hooks.json`. `enroll` replaces only groups carrying *its* enrollment id, so without this step the old ones would survive as foreign entries.
3. Enroll again with `--force` in the target org and workspace, on the same API URL, keeping the Ed25519 device key, the loopback port and the local bearer. The hook command lines change only their enrollment id; the service unit is re-applied unchanged.

`reassign --harness claude-code,codex` with no `--workspace` re-enrolls in place, which is the one way to *drop* a wrapper: `enroll` may add a harness on a re-apply but never silently removes one. The same target and the same harness list is a no-op.


## 5. Sign in, org, and the CLI default

`oxagen login` opens the browser; the web app is the org and workspace picker, and the loopback callback returns `{token, orgSlug, workspaceSlug}`, which the CLI persists. *Switch organization…* is that same flow run again. The pair in `config.json` is the CLI's default scope for its other commands; the pair in `host.json` is where this machine's sessions land. The app shows both and manages the second.

A saved token is treated as signed in until the control plane answers 401 to the first picker call; then the Account panel says *Session expired* and the primary returns to Sign in. This came out of the first launch on a real machine, where a months-old CLI session produced a raw error under a "Signed in" headline.


## 6. Wrappers: Claude Code and Codex

Tacho's spec (§13) reserved Codex and asked for a spike before committing. The spike (the upstream hooks documentation, read 2026-09-13) found a near clone of Claude Code's surface, so the adapter is a settings writer and a harness tag rather than a new protocol.

<div class="tw">
<table>
<thead><tr><th></th><th>Claude Code</th><th>Codex CLI</th></tr></thead>
<tbody>
<tr><td>Hook file</td><td><code>~/.claude/settings.json</code> (<code>CLAUDE_CONFIG_DIR</code>)</td><td><code>~/.codex/hooks.json</code> (<code>CODEX_HOME</code>); same <code>{hooks: {Event: [{matcher, hooks: [{type, command, timeout}]}]}}</code> shape</td></tr>
<tr><td>Enforcement events</td><td colspan="2">SessionStart · UserPromptSubmit · PreToolUse · PermissionRequest · Stop: command hooks, fail closed, same stdin fields (<code>session_id</code>, <code>hook_event_name</code>, <code>tool_name</code>, <code>tool_input</code>, <code>cwd</code>, <code>transcript_path</code>)</td></tr>
<tr><td>Telemetry events</td><td>28 events as <code>http</code> hooks straight to the daemon; OpenTelemetry export through the env block</td><td>PostToolUse · SubagentStart · SubagentStop · PreCompact · PostCompact · SessionEnd · Interrupt as command hooks (Codex has only <code>command</code>); no env block, no OTel</td></tr>
<tr><td>Decision</td><td colspan="2"><code>hookSpecificOutput.permissionDecision</code> allow / deny with a reason; exit 0 always</td></tr>
<tr><td>Hook command</td><td><code>&lt;bin&gt;/tacho hook --enrollment tch_…</code></td><td><code>&lt;bin&gt;/tacho hook --enrollment tch_… --harness codex</code></td></tr>
<tr><td>Session label</td><td><code>agent.harness = claude-code</code>, <code>runtime = claude-code</code></td><td><code>agent.harness = codex</code>, <code>runtime = custom</code>. The control plane's runtime column is a checked enum without a codex member (§11); the free-text harness carries the honest name. Fixed per session at first sight, persisted across a daemon restart.</td></tr>
<tr><td>Differences absorbed</td><td>none</td><td><code>transcript_path: null</code> (Claude omits it) is accepted; unenroll strips Codex hooks whether or not <code>host.json</code> still lists the harness.</td></tr>
</tbody>
</table>
</div>


## 7. Windows

Tacho previously returned a *none* service manager on `win32`. Rev 1 adds what an installer needs, keeping the same `~/.config/oxagen` root so the CLI and the app read one set of files on every platform:

- **Service:** a per-user Task Scheduler task (`schtasks /Create /SC ONLOGON /RL LIMITED`, started at once with `/Run`) that runs a rendered `tachod.cmd` launcher (Task Scheduler carries no environment, so the launcher sets it and appends to the log).
- **Transport:** the hook posts to `127.0.0.1:<port>` with the local bearer; the daemon skips the Unix socket. Same code path, one option.
- **Discovery and quoting:** `where claude` / `where codex` (first line); hook command lines are double-quoted for `cmd.exe`; paths are handled with `path.win32` so a macOS test can describe a Windows layout.
- **A latent bug fixed on the way:** the atomic writer built its temp name by splitting on `/`, which on a Windows path yielded the whole path and broke the rename.


## 8. The binaries

A `.dmg` cannot assume Node, so both CLIs ship as single executables: an esbuild CommonJS bundle embedded in a copy of the release runner's `node` with Node's single-executable support (`tools/sea/compile.mjs`: blob, copy, strip the Apple signature, [postject](https://github.com/nodejs/postject), ad-hoc re-sign). The host node is the runtime that ships, so each OS builds its own.

`tacho` is one multi-call binary rather than three: `tacho daemon` is the service body and `tacho hook` the command hook. That halves what the app carries (two runtimes instead of four), and `runtimeCommands` writes `<bin>/tacho hook` and `[<bin>/tacho, daemon]` whenever it finds that layout, from inside the app bundle, a Homebrew prefix, or a `TACHO_BIN_DIR` the app points it at. The native entry dispatches `hook` before the CLI's dependency graph is built, because the hook runs on every tool call.

| Measured on an M-series Mac, Node 24.18 | Value |
|---|---|
| `tacho hook` cold start, compiled binary, median of 10 | 111 ms |
| `node tacho-hook.mjs` cold start, the separate minified bundle | 109 ms |
| one compiled binary (`tacho` or `oxagen`) | 120.7 MB |
| `Oxagen.app` unpacked (shell + both sidecars) | 235 MB |
| `Oxagen_2.1.1_aarch64.dmg` | 79.5 MB |

The hook's 50 ms budget is the time allowed to *reach* the daemon, not process start; the two figures above are the same process-start cost the current `.mjs` install already pays. The size is the cost of two embedded runtimes; §11 lists the two ways down.


## 9. Building and releasing

```sh
pnpm --filter @oxagen/desktop sidecars     # compile tacho + oxagen, stage as binaries/<name>-<triple>
pnpm --filter @oxagen/desktop bundle:dmg   # macOS: tauri build --bundles dmg
pnpm --filter @oxagen/desktop bundle       # every bundle the current OS supports
pnpm --filter @oxagen/desktop dev          # tauri dev over Vite on :1420
```

`.github/workflows/desktop.yml` runs on a `desktop-v*` tag or by hand: one job per target (`macos-14` arm64, `macos-13` x64, `ubuntu-22.04`, `windows-latest`), each staging its own sidecars, building with `tauri-action`, uploading the bundles as artifacts and, on a tag, attaching them to a draft GitHub release.

| Platform | Signing | Secrets (skipped when absent) |
|---|---|---|
| macOS | Developer ID + notarization; without it the app is ad-hoc signed and Gatekeeper shows "cannot verify" on first open | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | Azure Trusted Signing; without it SmartScreen warns | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| Linux | unsigned; the `.deb` and `.rpm` carry no repository yet | none |

> **Fleet and MDM.** The same installers push through MDM. A post-install that runs `tacho enroll --token … --org … --workspace … --managed --harness claude-code,codex` enrolls silently, and the managed settings document `enroll --print-managed` renders locks the hooks so a user cannot strip them. The session record still carries `enforcement_tier = client_attested`; the app's This machine panel says so.


## 10. What was verified

- `@oxagen/tacho`: 26 files, 134 tests, typecheck and lint clean. New coverage: the Codex writer (merge, strip, presence, foreign entries kept), `--harness` parsing and re-apply semantics, `reassign` (revoke then create, device key and port kept, both hook files carry only the new id, harness-only re-enroll), the Windows service manager and launcher, the native layout, and the harness label reaching sealed events across a daemon restart. That last one is mutation-tested: with the relabel disabled the test fails.
- `@oxagen/desktop`: typecheck, lint, Vite build; 6 tests over the argv mapping and the primary-action rule.
- Both binaries compiled with Node SEA, run from the mounted `.dmg`: `--version`, `--help`, `tacho status`, `tacho hook` with a Codex-shaped payload (null transcript) against an unenrolled scratch home.
- The `.dmg` built, mounted, the app launched and rendered against this machine's real `config.json` (which is what surfaced the expired-session case in §5).

Not verified here: an end-to-end enroll against a live control plane from inside the app, the Linux and Windows bundles (no runner in this session), and signing (no certificates).


## 11. Not in rev 1

- **A `codex` runtime.** `tacho.sessions.runtime` is checked to five values; Codex ships as `runtime = custom, harness = codex`. Widening the enum is an Atlas migration (`packages/database/atlas`) that needs a diff against a database, so it did not ride this change. It moves reliability: the fleet page should be able to filter by Codex directly.
- **Signing secrets and an updater.** The workflow signs when secrets exist; the org's Actions were billing-locked at the last stella release, so the first real build may have to run on a fork. `tauri-plugin-updater` with a minisign key is the next step once releases are signed.
- **Smaller sidecars.** Two paths: `bun build --compile` (~60 MB per binary, cross-compiles from one runner) or one binary for both CLIs (`oxagen tacho hook` / `oxagen tacho daemon`) once the CLI's start-up is measured on the hook path.
- **Making the reassigned workspace the CLI default too.** The app changes `host.json`; `config.json`'s workspace stays the CLI's default until the user runs `oxagen login` again. A `--workspace` on `oxagen login` that re-uses the saved token would close that.
- **A headless Linux server.** `oxagen login` needs a browser; the CLI's `--token` path covers servers and the app is not meant for them.


## 12. Where it lives

| Path | What |
|---|---|
| `apps/desktop/` | the Tauri app: `src/app.tsx` (panels), `src/bridge.ts` (sidecars and Rust commands), `src/commands.ts` (argv mapping, tested), `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `scripts/sidecars.mjs`, `scripts/icons.mjs` |
| `packages/tacho/src/host/codex-writer.ts` | the Codex hooks writer |
| `packages/tacho/src/cli/reassign.ts` | `tacho reassign` |
| `packages/tacho/src/host/service.ts` | launchd, systemd, and the new Task Scheduler manager |
| `packages/tacho/src/cli/native.ts`, `collector/run.ts`, `claude-code/hook-process.ts` | the multi-call binary's entry and the two process bodies |
| `tools/sea/compile.mjs` | bundle → single executable |
| `.github/workflows/desktop.yml` | the four-target release matrix |
| `apps/cli/src/commands/tacho.ts` | `oxagen tacho reassign`, `--harness` on enroll |
