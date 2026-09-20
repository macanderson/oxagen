# Desktop uninstall recovery review

Issue #3301 remains open. This pass fixes failure paths in the shared host
writers and service managers used by Desktop. It does not certify native
installation on macOS, Linux, or Windows.

## Fixed findings

| Finding | Consequence | Change |
|---|---|---|
| P1: edited model config restore deleted its backup before writing | A failed write lost the original base URL needed for retry | Delete the backup after the config write succeeds |
| P1: harness receipt settlement treated every read error as absence | A locked or unreadable file lost its recovery receipt | Treat only ENOENT as absence |
| P1: unenroll continued after a base URL restore failed | Removing the gateway left a harness sending calls to a dead listener | Stop before removing hooks, service, or credentials |
| P1: unenroll revoked credentials after service removal failed | A running collector lost credentials and retry state | Retain enrollment and credentials until service removal succeeds |
| P1: Linux service errors were ignored | Install could claim success without a running service; uninstall could discard a live unit | Check restart, disable, active state, and reload results |
| P1: Windows process and task errors were ignored | Uninstall could remove the launcher while the collector or scheduled task remained | Check process queries, taskkill, the resulting process state, and task deletion |
| P1: systemd Environment values doubled literal dollar signs | Paths containing a dollar sign resolved to the wrong directory | Escape dollar expansion only in ExecStart |

The [systemd Environment documentation](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
specifies that dollar signs have no special meaning in Environment assignments.
Specifier expansion still applies there.

## Inspection record

These paths are relative to the repository root. A partial entry records the
reviewed sections, not a claim that every line was audited.

| Path | Scope inspected |
|---|---|
| packages/tacho/src/host/harness-file.ts | Complete receipt and file implementation |
| packages/tacho/src/host/service.ts | Complete service managers and renderers |
| packages/tacho/src/host/codex-writer.ts | Complete writer |
| packages/tacho/src/host/claude-desktop-writer.ts | Complete writer |
| packages/tacho/src/host/mcp-config-writer.ts | Complete writer |
| packages/tacho/src/host/settings-writer.ts | Merge, strip, and settings-shape handling from line 220 |
| packages/tacho/src/host/stella-writer.ts | Managed TOML block parsing and conflict checks |
| packages/tacho/src/host/model-base-url.ts | Public interfaces, atomic write helper, apply, and restore paths |
| packages/tacho/src/host/service.test.ts | Complete existing service tests |
| packages/tacho/src/host/install-hardening.test.ts | Complete existing hardening tests |
| packages/tacho/src/cli/unenroll.ts | Model URL restoration, receipt settlement, and uninstall orchestration |
| packages/tacho/src/cli/install-rig.ts | Fake service and health boundaries |
| apps/desktop/src/bridge.ts | Complete sidecar bridge |
| apps/desktop/src/machine-state.ts | Complete machine-state model |
| apps/desktop/src/commands.ts | Command construction and install guards |
| apps/desktop/src/tacho-status.ts | Status parsing sections |
| apps/desktop/src/updater.ts | Update handling sections |
| apps/desktop/src/app.tsx | Install and uninstall handlers, including lines 580–688 |
| apps/desktop/src-tauri/src/cli_install.rs | Install/remove filesystem operations around lines 1390–1665 |
| apps/desktop/src-tauri/src/lib.rs | Startup and command registration through line 185 |
| apps/desktop/src-tauri/src/machine.rs | Machine-state tests around lines 250–330 |
| apps/desktop/scripts/sidecars.mjs | Sidecar staging sections |
| apps/desktop/scripts/rig-stubs.mjs | Stub generation |
| apps/desktop/src-tauri/capabilities/default.json | Complete permissions |
| apps/desktop/src-tauri/tauri.conf.json | Complete configuration |
| apps/desktop/src-tauri/build.rs | Complete build script |
| apps/desktop/package.json | Complete scripts and dependencies |

## Evidence and remaining work

The isolated `src/host/uninstall-recovery.test.ts` run passed 17 tests. Scratch
homes and fake service commands cover write failures, retained receipts,
credential retention, retry, process-removal failures, repeated removal, and
systemd rendering. No real harness files, credentials, or services were changed.
Existing service and hardening test expectations were updated for CI. CI owns
lint, typecheck, build, coverage, and the remaining test files.

The complete line-by-line Desktop review requested by #3301 is unfinished.
Remaining source and Rust sections, build assets, and native installer execution
need a separate pass. The download publishing script belongs to PR #3531.

Native service behavior is unverified. In particular, the Linux missing-unit
case models `is-active` returning status 4 with `unknown`; CI fakes do not prove
that response on each supported systemd version. Real Windows process and task
removal also need native evidence.

Byte-identical restoration of preexisting service units and all harness configs,
including termination during a write, has not been demonstrated across all
three platforms. Temporary-file cleanup after write or fsync failure and stale
Windows PID ownership need further inspection. Full gateway behavior depends
on the separate #3299 work and is outside this bug-fix pass. These limitations
prevent closing #3301.
