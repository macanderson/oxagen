# Oxagen Desktop: product specification, rev 1

| | |
|---|---|
| **Status** | Rev 2, built and verified on macOS; Linux and Windows bundles not yet run |
| **Date** | 2026-09-16 (rev 2: the connected tier); 2026-09-13 (rev 1) |
| **Owner** | Mac Anderson |
| **Source** | `docs/specs/oxagen-desktop` on branch `worktree-oxagen-installer`; Tacho 2.1.1 |
| **Ships as** | macOS **.dmg**; Linux **.deb / .rpm / .AppImage**; Windows **.msi / .exe** |
| **Rev 2** | The app stops being a wrapper installer for coding agents and becomes the control plane for the AI apps on a machine, developer or not. ADR-078 settles the two enforcement tiers it now spans: **wrapped** apps run an Oxagen hook and **connected** apps are served their toolbelt through a local MCP gateway, and neither dominates the other (§13). Claude Desktop is the first connected app. PATH linking stops being on by default on a machine with no coding agent on it. |
| **Summary** | The Oxagen app puts a machine under Oxagen control: on first launch it links the `oxagen` CLI and the Tacho wrapper onto the operator's PATH, then signs the machine in to an organization, enrolls it against a workspace, and gives the operator one window to see the connection, move the host to another workspace or org, add or drop a wrapper for Claude Code, Codex, or Stella, sign out, and unenroll. A custom agent wraps too, by calling `tacho hook --agent <name>` around its own steps; the app shows it once it does. |
| **Amended 2026-09-18** | §14: the installer's new job, which is the target of Phase 4 (in build on branches `gateway-model-proxy` and `desktop-install-hardening`, oxagen issues #3299 and #3301, ADR-094 and ADR-095), beside what the app installs today, said plainly. §6 states both senses of failure: the hook process fails closed against its cached bundle, and the tier is fail-open against the person at the keyboard. |
| **Canonical copy** | This file is the canonical copy of the desktop spec. `docs/desktop-spec.md` in https://github.com/macanderson/roadmap is an older copy that stops before §13. §14 says the same thing in both. |


## 1. What rev 1 ships

- A signed-capable installer per OS from one Tauri 2 project (`apps/desktop`): `.dmg` on macOS, `.deb`, `.rpm` and `.AppImage` on Linux, `.msi` and NSIS `.exe` on Windows.
- The app is a running management UI, not a wizard: connection status, the org and workspace the host reports to, wrapper state per harness, collector health, the last action's output, the collector log.
- On first launch, before any wizard step, the app links `oxagen` and `tacho` onto the operator's PATH the same way the Command line panel's **Link** does; it never overwrites an `oxagen` it did not install, and **Remove links** is a standing opt-out — the app does not relink on a later launch.
- Sign in to an Oxagen org through the browser (the CLI's PKCE loopback flow), sign out, switch org.
- Enroll the machine and pick the workspace; change the workspace or org later with `tacho reassign`, which keeps the device key so the fleet page sees one continuous host.
- Wrap Claude Code, Codex, and Stella. Codex is a settings writer over the same hook, verified against the upstream hooks documentation (§6). Stella's hooks go into `~/.stella/stella.toml` (or `~/.stella/settings.json` when only that exists) as a marker-delimited block, since Stella has no dedicated hook-settings file of its own the way the other two do (§6).
- Wrap any other agent by calling `tacho hook --agent <name>` around its own steps, with no settings file involved. The machine's first enrollment covers it. The Wrapped agents panel shows it alongside the three built-in harnesses, with a per-agent health state (§3, §6).
- Install the CLIs on PATH from the app; remove the links again.
- Uninstall the wrapper: **Uninstall Oxagen…** runs `tacho unenroll --all --purge`, which removes every agent enrolled on the machine (ADR-202). It strips the hooks in every wrapped harness, stops the service, revokes each enrollment on the control plane, deletes the credentials, and drops the local event log. When that exits 0, the app removes `~/.config/oxagen` and points at the platform uninstaller. A non-zero exit stops the uninstall before anything else is removed.
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
<svg viewBox="0 0 960 354" role="img" aria-labelledby="fig1t" font-family="Space Grotesk, Helvetica Neue, Arial, sans-serif" font-size="13">
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
  <rect x="380" y="190" width="240" height="144" rx="12" fill="var(--panel)" stroke="var(--border)"/>
  <text x="396" y="214" fill="var(--gold-text)" font-size="11" font-weight="500" letter-spacing="1">ON THE HOST</text>
  <text x="396" y="238" fill="var(--text)" font-weight="600">tachod</text>
  <text x="450" y="238" fill="var(--muted)" font-size="12">launchd · systemd · schtasks</text>
  <text x="396" y="262" fill="var(--text)" font-weight="600">Claude Code</text>
  <text x="486" y="262" fill="var(--muted)" font-size="12">~/.claude/settings.json hooks + OTel</text>
  <text x="396" y="286" fill="var(--text)" font-weight="600">Codex</text>
  <text x="446" y="286" fill="var(--muted)" font-size="12">~/.codex/hooks.json command hooks</text>
  <text x="396" y="310" fill="var(--text)" font-weight="600">Stella + custom</text>
  <text x="500" y="310" fill="var(--muted)" font-size="12">stella.toml block · tacho hook --agent</text>
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
| This machine | agent key, reports-to slugs, enrollment id, status and mode, bundle version and age, collector uptime / spool / last ingest, service state, attestation tier, expiry | org and workspace pickers before enrollment; **Enroll this machine** | `tacho enroll --org … --workspace … --harness …` |
| Workspace | the org and workspace the host reports to, as pickers listing the operator's orgs and that org's workspaces | pick another; the Apply button appears in Wrapped agents | `tacho reassign --org … --workspace …` |
| Wrapped agents | Claude Code, Codex, and Stella with hook completeness per harness and the detected version, plus every custom agent the collector has seen, each with a health state (healthy, pending, degraded, down, idle, not wrapped) | checkboxes for the three built-in harnesses (never empty); **Reassign to …** / **Apply wrappers**; Reset; custom agents are read-only here, added by their own `tacho hook --agent` call; **De-register…** per harness | `tacho reassign --harness …`. De-register runs `tacho reassign --harness <the others>`, or `tacho unenroll --harness <harness>` for the last one, which leaves any other agent on the machine enrolled (ADR-202). The panel reads the first enrollment only |
| Command line | where `oxagen` and `tacho` resolve on PATH; linked automatically on first launch unless an `oxagen` the app did not install was already there | Link into `~/.local/bin` (or `%LOCALAPPDATA%\Oxagen\bin`) · Remove links (also opts out of the automatic relink) | Rust: symlinks, or `.cmd` shims plus the user PATH |
| Activity | streamed output of the last action; the collector log tail | Open the log file | `tacho status --json`, log tail |
| Uninstall | what the uninstall removes, shown whether or not the machine is enrolled | **Uninstall Oxagen…**, confirmed twice | `tacho unenroll --all --purge`, then Rust: delete `~/.config/oxagen` |

The gold primary is the next step and moves with it: **Sign in** when there is no session, **Enroll this machine** when there is no enrollment, **Reassign** / **Apply** when a picker differs from the host, and nothing otherwise. Destructive controls (sign out, unenroll, remove data) use the danger treatment and confirm in place; gold never encodes a state.


## 4. Moving a host between workspaces

The host API key is minted for the workspace at enrollment, so a move is a revoke plus a fresh enrollment, not an edit. `tacho reassign` does it as one step and keeps what makes the host recognisable:

1. Revoke the current enrollment with the operator's session (best effort; an offline host stays marked revoked locally and the fleet page can finish it).
2. Strip the old enrollment's hook groups from `~/.claude/settings.json`, `~/.codex/hooks.json`, and the marker-delimited block in `~/.stella/stella.toml` (or `~/.stella/settings.json`). `enroll` replaces only groups or blocks carrying *its* enrollment id, so without this step the old ones would survive as foreign entries.
3. Enroll again with `--force` in the target org and workspace, on the same API URL, keeping the Ed25519 device key, the loopback port and the local bearer. The hook command lines change only their enrollment id; the service unit is re-applied unchanged.

`reassign --harness claude-code,codex,cursor,stella` with no `--workspace` re-enrolls in place, which is the one way to *drop* a wrapper: `enroll` may add a harness on a re-apply but never silently removes one. The same target and the same harness list is a no-op. A custom agent is not part of this list; it carries no hooks to strip, and it simply stops appearing once it stops calling `tacho hook --agent`.


## 5. Sign in, org, and the CLI default

`oxagen login` opens the browser; the web app is the org and workspace picker, and the loopback callback returns `{token, orgSlug, workspaceSlug}`, which the CLI persists. *Switch organization…* is that same flow run again. The pair in `config.json` is the CLI's default scope for its other commands; the pair in `host.json` is where this machine's sessions land. The app shows both and manages the second.

A saved token is treated as signed in until the control plane answers 401 to the first picker call; then the Account panel says *Session expired* and the primary returns to Sign in. This came out of the first launch on a real machine, where a months-old CLI session produced a raw error under a "Signed in" headline.


## 6. Wrappers: Claude Code, Codex, and Stella; custom agents over the same hook

Tacho's spec (§13) reserved Codex and asked for a spike before committing. The spike (the upstream hooks documentation, read 2026-09-13) found a near clone of Claude Code's surface, so the adapter is a settings writer and a harness tag rather than a new protocol. Stella follows the same pattern: Tacho's spec (§10) notes that Stella carries its own signed-enrollment machinery already and implements the contract natively in the engine, but a workstation Stella session, run through the CLI rather than `stella-serve`, is `client_attested` like the other two and wraps the same way — a settings writer over the same hook.

<div class="tw">
<table>
<thead><tr><th></th><th>Claude Code</th><th>Codex CLI</th><th>Stella</th></tr></thead>
<tbody>
<tr><td>Hook file</td><td><code>~/.claude/settings.json</code> (<code>CLAUDE_CONFIG_DIR</code>)</td><td><code>~/.codex/hooks.json</code> (<code>CODEX_HOME</code>); same <code>{hooks: {Event: [{matcher, hooks: [{type, command, timeout}]}]}}</code> shape</td><td><code>~/.stella/stella.toml</code>, or <code>~/.stella/settings.json</code> when only that exists (<code>STELLA_HOME</code>); a marker-delimited block, <code># &gt;&gt;&gt; tacho enrollment tch_… &gt;&gt;&gt;</code> to <code># &lt;&lt;&lt; … &lt;&lt;&lt;</code>, so the writer edits only what it owns and the operator's own comments and settings survive around it</td></tr>
<tr><td>Enforcement events</td><td colspan="2">SessionStart · UserPromptSubmit · PreToolUse · PermissionRequest · Stop: command hooks. Four of the five can refuse, and <code>Stop</code> is the fifth. The hook process fails closed against its cached bundle: in enforce mode a stale or unverified bundle denies non-read-only tools at <code>PreToolUse</code>. With the daemon down the other command hooks answer <code>{}</code>, which the harness reads as allow. The tier is client-attested, and it is the tier that is fail-open against the person at the keyboard, who can remove the hook entry or disable hooks (§14, ADR-095). Earlier text said only "fail closed", and a first correction on 2026-09-18 said only "fail-open". Both senses are now stated, same stdin fields (<code>session_id</code>, <code>hook_event_name</code>, <code>tool_name</code>, <code>tool_input</code>, <code>cwd</code>, <code>transcript_path</code>)</td><td>SessionStart · UserPromptSubmit · PreToolUse · Stop: same stdin fields, same decision shape; no PermissionRequest event</td></tr>
<tr><td>Telemetry events</td><td>28 events as <code>http</code> hooks straight to the daemon; OpenTelemetry export through the env block</td><td>PostToolUse · SubagentStart · SubagentStop · PreCompact · PostCompact · SessionEnd · Interrupt as command hooks (Codex has only <code>command</code>); no env block, no OTel</td><td>PostToolUse · PreCompact · SubagentStart · SubagentStop as command hooks; no PostCompact, SessionEnd, or Interrupt event, and no OTel</td></tr>
<tr><td>Decision</td><td colspan="3"><code>hookSpecificOutput.permissionDecision</code> allow / deny with a reason; exit 0 always</td></tr>
<tr><td>Hook command</td><td><code>&lt;bin&gt;/tacho hook --enrollment tch_…</code></td><td><code>&lt;bin&gt;/tacho hook --enrollment tch_… --harness codex</code></td><td><code>&lt;bin&gt;/tacho hook --enrollment tch_… --harness stella</code></td></tr>
<tr><td>Session label</td><td><code>agent.harness = claude-code</code>, <code>runtime = claude-code</code></td><td><code>agent.harness = codex</code>, <code>runtime = codex</code> as of the <code>20260914120000_tacho_sessions_runtime_codex</code> migration (§11 no longer applies; <code>tacho.sessions.runtime</code> now checks six values, including <code>codex</code> and <code>stella</code>)</td><td><code>agent.harness = stella</code>, <code>runtime = stella</code>. Stella sends no <code>session_id</code> and no <code>SessionEnd</code>, so the session is keyed on the wrapped process instead and closes when that process exits; an interactive Stella process that opens more than one logical conversation shares one chain until Stella's protocol carries a session id of its own</td></tr>
<tr><td>Differences absorbed</td><td>none</td><td><code>transcript_path: null</code> (Claude omits it) is accepted; unenroll strips Codex hooks whether or not <code>host.json</code> still lists the harness</td><td>same <code>transcript_path: null</code> tolerance; the TOML writer parses and re-emits only its own marker block, leaving the rest of the file byte-for-byte</td></tr>
</tbody>
</table>
</div>

### Custom agents: the same hook, no settings file

Any agent that is not one of the three above wraps by calling `tacho hook --agent <name>` directly around its own steps (`<name>` matches `^[a-z0-9][a-z0-9._-]{0,63}$` and becomes the harness label), instead of through a settings file Tacho writes into. The machine still has to be enrolled first; `tacho hook` reads `~/.config/oxagen/tacho/host.json` itself, so the calling agent never handles a credential. The payload on stdin is the Claude Code hook shape (`session_id`, `hook_event_name`, `cwd`, `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `prompt`, …), and the JSON document on stdout answers the same way: `hookSpecificOutput.permissionDecision` on `PreToolUse`, `{decision: "block"}` on `UserPromptSubmit`, `{continue: false}` or `additionalContext` on `SessionStart`. The session is labelled `agent.harness = <name>`, `runtime = custom`, and is `client_attested` like the three built-in harnesses: a call the agent skips is a step Oxagen never saw, not a step it can flag as skipped. When the collector is down, `tacho hook` decides from the cached signed policy bundle and spools the event for replay, so the answer is never late even when the daemon is. See [Wrap an agent](https://docs.oxagen.sh/docs/cli/wrap-an-agent) for the full field and answer tables and worked examples.


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

> **Fleet and MDM.** The same installers push through MDM. A post-install that runs `tacho enroll --token … --org … --workspace … --managed --harness claude-code,codex,cursor,stella` enrolls silently, and the managed settings document `enroll --print-managed` renders locks the hooks so a user cannot strip them. The session record still carries `enforcement_tier = client_attested`; the app's This machine panel says so.


## 10. What was verified

- `@oxagen/tacho`: 26 files, 134 tests, typecheck and lint clean. New coverage: the Codex writer (merge, strip, presence, foreign entries kept), `--harness` parsing and re-apply semantics, `reassign` (revoke then create, device key and port kept, both hook files carry only the new id, harness-only re-enroll), the Windows service manager and launcher, the native layout, and the harness label reaching sealed events across a daemon restart. That last one is mutation-tested: with the relabel disabled the test fails.
- `@oxagen/desktop`: typecheck, lint, Vite build; 6 tests over the argv mapping and the primary-action rule.
- Both binaries compiled with Node SEA, run from the mounted `.dmg`: `--version`, `--help`, `tacho status`, `tacho hook` with a Codex-shaped payload (null transcript) against an unenrolled scratch home.
- The `.dmg` built, mounted, the app launched and rendered against this machine's real `config.json` (which is what surfaced the expired-session case in §5).

Not verified here: an end-to-end enroll against a live control plane from inside the app, the Linux and Windows bundles (no runner in this session), and signing (no certificates).


## 11. Not in rev 1

- ~~A `codex` runtime.~~ Shipped since this line was written: the `20260914120000_tacho_sessions_runtime_codex` migration widened `tacho.sessions.runtime` from five values to six, and Codex sessions carry `runtime = codex` directly rather than `runtime = custom, harness = codex`. The fleet page filters by Codex without going through the harness column. The `stella` runtime value shipped in the same enum (§6).
- **Signing secrets and an updater.** The workflow signs when secrets exist; the org's Actions were billing-locked at the last stella release, so the first real build may have to run on a fork. `tauri-plugin-updater` with a minisign key is the next step once releases are signed.
- **Smaller sidecars.** Two paths: `bun build --compile` (~60 MB per binary, cross-compiles from one runner) or one binary for both CLIs (`oxagen tacho hook` / `oxagen tacho daemon`) once the CLI's start-up is measured on the hook path.
- **Making the reassigned workspace the CLI default too.** The app changes `host.json`; `config.json`'s workspace stays the CLI's default until the user runs `oxagen login` again. A `--workspace` on `oxagen login` that re-uses the saved token would close that.
- **A headless Linux server.** `oxagen login` needs a browser; the CLI's `--token` path covers servers and the app is not meant for them.


## 12. Where it lives

| Path | What |
|---|---|
| `apps/desktop/` | the Tauri app: `src/app.tsx` (panels), `src/bridge.ts` (sidecars and Rust commands), `src/commands.ts` (argv mapping, tested), `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `scripts/sidecars.mjs`, `scripts/icons.mjs` |
| `packages/tacho/src/host/codex-writer.ts` | the Codex hooks writer |
| `packages/tacho/src/host/stella-writer.ts` | the Stella TOML/JSON marker-block writer |
| `packages/tacho/src/cli/reassign.ts` | `tacho reassign` |
| `apps/docs/content/docs/cli/wrap-an-agent.mdx` | the operator-facing guide: the three-harness comparison and the `tacho hook --agent` contract for custom agents |
| `packages/tacho/src/host/service.ts` | launchd, systemd, and the new Task Scheduler manager |
| `packages/tacho/src/cli/native.ts`, `collector/run.ts`, `claude-code/hook-process.ts` | the multi-call binary's entry and the two process bodies |
| `tools/sea/compile.mjs` | bundle → single executable |
| `.github/workflows/desktop.yml` | the four-target release matrix |
| `apps/cli/src/commands/tacho.ts` | `oxagen tacho reassign`, `--harness` on enroll |


## 13. Rev 2: the connected tier

Rev 1 wrapped coding agents. Every harness it supported had a hook surface, so
Tacho installed a `PreToolUse` command hook and from then on saw every action
the agent took. The AI applications a non-developer actually runs have no hook
surface at all. They have an MCP client config.

ADR-078 settles what Oxagen does about that, and the part of it this spec is
bound by is that **the two tiers do not rank against each other**:

| Product word | `enforcement_tier` | Apps | Mechanism |
|---|---|---|---|
| **Wrapped** | `harness` | Claude Code, Codex, Stella, any agent calling `tacho hook --agent` | a `PreToolUse` command hook |
| **Connected** | `gateway` | Claude Desktop | an Oxagen MCP server in the app's client config |

Wrapped is **broader and weaker**: it sees every action, including the
harness's own Bash and Edit, but the hook runs in a process Oxagen does not
own, so the record is `client_attested`. Connected is **narrower and
stronger**: Oxagen sees only what routes through its gateway, but the kernel
evaluates and refuses those calls on the server. A surface that puts them on
one axis — a coverage meter, "fully" versus "partially" governed — is wrong in
both directions, and is banned in the panel, in `apps/app`, in the CLI and in
the docs.

### 13.1 The local MCP gateway

The collector daemon's loopback listener gains `POST /mcp`. Any MCP client on
the machine connects to `http://127.0.0.1:<port>/mcp` and gets the workspace's
toolbelt without ever holding an Oxagen credential — the gateway holds it, and
the app is the credential. A non-developer will not paste a token into a JSON
file, and asking them to would put it on the least protected surface on the
machine.

The gateway is a **proxy, not a second materialiser**. `@oxagen/tacho` is a
leaf package with no `@oxagen/*` runtime dependency, so it forwards the
JSON-RPC envelope to the workspace MCP endpoint with the host's own API key —
already an Oxagen API key bound to the enrolling org and workspace. One tool
materialiser, one RBAC evaluation, one entitlement gate, one meter, all of them
the ones that already exist on the control plane. ADR-043 holds with no
exception: the gateway serves tools and records evidence, and never runs a
turn, calls a model or spawns a worker.

On top of the forward it adds three things: attribution, which is refused
rather than defaulted when the machine has no usable enrollment; the mandate's
tool ceiling, where an overflowing `tools/list` fails with a message naming the
model, the limit and the count; and evidence, sealed on the daemon's own chain
with `enforcement_tier: "gateway"`. Calls land on the daemon chain rather than
a session chain because a connected app has no agent session — no prompt, no
model, no turn — and inventing one would put a step in the ledger that nobody
took.

**Security.** The listener was previously reached only by things Oxagen
installed; it is now reachable by any MCP client, which makes DNS rebinding
worth doing. So `Host` must name a loopback address and `Origin`, when present,
must be a loopback origin — checked before the bearer and on **every** route,
including `/health`, `/status` and `/sessions`, which were exposed the same way
in rev 1. The Unix socket is exempt: no browser can address one.

### 13.2 Claude Desktop, and what has no config surface

Verified 2026-09-16 against the MCP quickstart and Anthropic's own docs:

| | Claude Desktop |
|---|---|
| Config | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS); `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Linux | **no path** — Anthropic ships no Linux build. The writer returns undefined and enroll says the app is unavailable on this platform rather than writing a file nothing reads |
| Transport | **stdio only.** No `type`/`transport`/`url` member is documented for this file; remote servers are added through Settings → Connectors in the app, which no third party can write to. So `tacho mcp-stdio` ships — a thin stdin/stdout pump to the loopback gateway that duplicates no decision |
| Restart | required, and documented as such. The app says so in plain words rather than writing the file and leaving the user to wonder |

**Cowork and ChatGPT desktop have no writer, because neither has a config
surface to write.** Anthropic's Cowork is a feature inside Claude rather than a
separate app, and as of 2026-09-16 is being merged into the Claude chat
interface; it inherits Claude Desktop's config. ChatGPT's MCP is
remote-HTTPS-only through Developer Mode in the UI, with no local file a third
party can write. (`~/.codex/config.toml` belongs to Codex, a different product,
which this app already wraps through hooks.) Stubbing either would have
enrolled a harness that could never report.

### 13.3 What the connected tier cannot do

A connected app's config is a file the user owns. Nothing stops them adding a
second MCP server beside ours, and a tool served by that server never touches
Oxagen. Every connected surface therefore reports the count and the names of
the other MCP servers in that app — in `tacho enroll`, in `tacho status`, and
in the panel — because the size of the gap is a fact the operator is entitled
to.

**Closing it is not a code change in this repository, and as of 2026-09-16 it
is not fully closable at all.** Anthropic's enterprise controls
(`com.anthropic.claudefordesktop` on macOS, `HKLM:\SOFTWARE\Policies\Claude`
on Windows) carry `isLocalDevMcpEnabled` and its siblings, which are **on/off
switches for local MCP as a whole, not a named-server allowlist**. The one real
allowlist Anthropic ships governs the Desktop Extension (`.mcpb`) registry, not
hand-written entries in `claude_desktop_config.json`. So an administrator can
turn local MCP off entirely or leave it on; they cannot say "only Oxagen's".
The product says that rather than implying a control it does not have.

### 13.4 First run for someone who does not use a terminal

PATH linking, the shell-profile block and the CLI sidecars are no longer on by
default. The launch-time link now follows the machine: on where a coding agent
is already installed (`claude`, `codex` or `stella` in a well-known install
directory), off otherwise. It remains a *default* — an explicit `autoLinkCli`
in `desktop.json` wins in both directions, so "Remove links" stays removed on a
developer's machine and "Link into PATH" stays linked on anyone else's. The
`autoLinkCli` mechanism and `desktop.json` are otherwise untouched.

`tacho detect` reports connected apps alongside wrapped ones, found on disk
rather than on PATH (a GUI bundle answers no `--version` and is on nobody's
PATH), each with its tier and a line on what that tier records.

### 13.5 The panel and the fleet

The Wrapped agents panel becomes **AI apps on this machine**. Every row carries
its tier and two lines — what it records and what it does not — and a connected
row can never render as a wrapped one: it has no hooks, no version, no
sessions, and its refused calls are reported as the mandate being enforced
rather than as ill health. A collector that is down makes a connected row
*down*, harder than for a wrapped agent, because the gateway lives inside the
collector while a wrapped agent's hook still decides from the cached bundle.

`apps/app` gains **Fleet** at `/{orgSlug}/{workspaceSlug}/fleet`, the app
surface for `list_tacho_hosts`, which now returns a `tiers` map alongside
`harnesses` and reaches the API, MCP, CLI (`oxagen tacho hosts`) and the app.


## 14. After rev 2: `tachod` grows into the gateway (2026-09-18)

> **Status of this section (2026-09-18).** Target, in build, and not on `main`. Approved by the maintainer on 2026-09-18 with the steering, graph and gateway review, and decided by ADR-094 "tachod grows into the gateway: a loopback model proxy and an MCP aggregator". It is Phase 4 of the refactor path (the Mission Control spec §17.2, the implementation plan §8.5). It is tracked as oxagen issues #3299 and #3301, and built on branches `gateway-model-proxy` and `desktop-install-hardening`. The contained tier below is Phase 5 (ADR-096, issue #3300). Everything above this section describes what the app installs today.

**What the app installs today, said plainly.** Enrollment is file edits plus a daemon. It writes hook entries into each harness's settings file, installs `tachod`, registers it to start at login, and enrolls the host with a device key. No Oxagen command launches the agent. `tachod` is a recorder plus a kill switch that tells the agent what the workspace requires: the signed bundle it receives carries the workspace's active `must` and `should` records as `context.system` (PR #3289, ADR-091), with empty permissions and `budget.mode = "observed"`, so no rule can fire beyond host status and a paused run. No model proxy exists. No sandbox exists. Install and uninstall are known to be buggy (maintainer, 2026-09-18), and issue #3301 is the fix.

**Two senses of failure, and which is which.** The hook process fails closed against its cached bundle: in enforce mode a stale or unverified bundle denies non-read-only tools at `PreToolUse`, with the daemon up or down. With the daemon down the other command hooks answer `{}`, which the harness reads as allow (`packages/tacho/src/claude-code/hook-client.ts`). The tier is a different matter. It is client-attested, and it is fail-open against the person at the keyboard: remove the hook entry, disable hooks or run another build of the harness, and the action proceeds (ADR-095). "Fail-open" in this spec describes the tier, never the hook process.

**The installer's new job.** This is the target of Phase 4:

1. **It installs `tachod` as the gateway.** The same daemon, on the same loopback listener, with the four parts in the table below.
2. **Enrollment writes the model base URLs into each harness**, Claude Code (`ANTHROPIC_BASE_URL`) and Codex (`OPENAI_BASE_URL`), with displace-and-restore: the value that was there is kept, and unenroll puts it back. Enrollment writes them only after the daemon is confirmed listening on loopback, so a harness is never pointed at a port nothing answers. The host-level base URL is shared by every session on the host. How the proxy binds one request to one run, by the connecting process for every wrapped session and by a run-scoped base URL only where a launcher set it before the process started, is the Mission Control spec §7.1.
3. **Unenroll and uninstall restore every file they touched before they stop the daemon.** The order matters. A stale hook entry is noise, and a harness left pointing at a dead base URL is broken (ADR-094).
4. **Uninstall is proven to leave the home directory byte-identical to its state before install, except for a documented allowlist.** The proof is a temp-HOME snapshot rig: snapshot a scratch home, install, enroll, unenroll, uninstall, snapshot again, and compare byte for byte. The allowlist is written down beside the rig, and a difference that is not on it is a defect. A partial install, killed midway, uninstalls as cleanly.
5. **The app shows the tier word:** `observe`, `harness` or `gateway`. `contained` is not available yet, and the app shows it as a tier not yet available. The word is computed from what a run actually routed (ADR-095), so the app does not show `gateway` because the gateway is installed, and it never shows a stronger word than the run earned.
6. **`apps/desktop` gets a line-by-line bug review in the same effort.** Every finding is fixed on the branch or listed with the reason it could not be.

The proxy covers hosts on a subscription login as well as hosts on an API key. Both OpenAI and Anthropic work through a base URL proxy, subscription logins included, and neither vendor's terms explicitly forbid it: validated by the maintainer on 2026-09-18.

**What `tachod` becomes.** The same daemon, on the same loopback listener, with four parts:

| Part | What the installer and enrollment do for it | Status on `main` |
|---|---|---|
| Hook adapter | Writes the hook entries (§6) | Built |
| Control channel | Enrolls the host and keeps the signed bundle current (§2) | Built |
| MCP aggregator | Re-serves the harness's existing MCP servers through loopback, so their tool calls pass Oxagen. Enrollment displaces the harness's MCP entries and unenroll restores them, extending the merge and strip logic in `packages/tacho/src/host/mcp-config-writer.ts`. Where a vendor offers managed settings, the managed variant pins them | Phase 4. Today the gateway is registered only into Claude Desktop (rev 2, the connected tier) |
| Loopback model proxy | Passes Anthropic Messages and OpenAI Responses requests through to the vendor with streaming. The proxy forwards each prompt body to the vendor, as the harness does today. No prompt body is sent to Oxagen's servers: only digests and usage go up. The vendor credential stays on the machine and Oxagen never holds it | Phase 4, in build on `gateway-model-proxy` |

**What changes in the panels.** This machine shows the tier as one word of the ladder, computed from what was actually routed. Spend shows its basis, `observed` or `self-reported`. Until Phase 4 lands every number for a wrapped agent is self-reported, and Codex and Stella show as absent, never as zero (oxagen issue #3304). A connected host (rev 2, ADR-078) reads on the ladder as ADR-095 sets out: it is on `gateway` for the Oxagen MCP calls that routed, it has no `harness` rung under it, and it is invisible otherwise. ADR-078 §2 is kept, so no panel renders a tier word as a score, a percentage or "fully governed", and every panel still says what the tier records and what it does not.

**The contained tier is not this app's job on a laptop.** `oxagen run -- <agent>` (Phase 5) launches an agent under an OS sandbox whose only egress is the gateway. It is aimed at CI, headless runs, cloud runners and managed devices first, and it is never mandatory on a developer's own laptop. The app may show that a run was contained. It does not force containment.
