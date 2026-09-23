# Desktop uninstall recovery review

Issue #3301 covers two review passes. The first pass, dated 2026-09-20, fixed
failure paths in the shared host writers and service managers that Desktop
uses. The second pass, dated 2026-09-23, added the Windows round trip to the
install rig and fixed four defects that the first pass named as remaining
work. Neither pass certifies a native installation on macOS, Linux, or
Windows. Fakes stand in for `launchctl`, `systemctl`, and `schtasks`.

## Fixed findings, first pass

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

## Fixed findings, second pass (2026-09-23)

| Finding | Consequence | Change |
|---|---|---|
| P1: the Windows service manager trusted any live process that held the pid in `tachod.pid` | A daemon that died without cleanup left its pid file behind. Windows reuses pids, so `taskkill /PID <n> /T /F` at uninstall or re-enroll could end another program and its whole process tree | `livePid` in `service.ts` accepts the pid only when `tasklist` reports one of the daemon's images: `tacho.exe`, `tachod.exe`, `node.exe`, or the program that the launcher on disk starts (`tasklistImage`, `daemonImages`). Any other image reads as a stale pid file |
| P2: `tasklist` output was matched by substring | A pid that appeared in another column, such as a memory figure, read as the daemon | `tasklistImage` compares the pid column of each CSV row |
| P2: an atomic write that failed at `write` or `fsync` left its temp file | A `.settings.json.<pid>.<ms>.tmp` stayed in `~/.claude`, `~/.codex`, or another harness directory, so the uninstall could not return a byte-identical tree. Four copies of the write helper each cleaned up a different subset of failures | One helper, `writeFileAtomic` in `fs.ts`, removes the temp file on every failure. `writeSensitiveFileAtomic`, `HarnessFiles`, `model-base-url.ts`, and `model-credential.ts` all call it |
| P2: an empty container the user already had was not given back | The strips drop a `hooks`, `env`, or `mcpServers` object they emptied, so an original `"env": {}` read as an edit made while enrolled. The file came back re-serialized without it | `sameDocument` in `harness-file.ts` ignores empty objects and arrays when it compares, so the original bytes go back. A container that held something and was emptied while enrolled still counts as an edit |
| Gap: the install rig had no Windows round trip | The Task Scheduler manager was tested only one call at a time, and no test proved uninstall on Windows | `install-rig.ts` seeds a Windows home and fakes `schtasks`, `tasklist`, and `taskkill`. The fake daemon writes its pid file the way `runDaemonProcess` does. The service state belongs to the seed, so a rig built after a kill sees what the dead install left |
| Gap: the Linux round trip covered three of the four harnesses that have a Linux build | Cursor had no Linux proof | The Linux case enrolls Claude Code, Codex, Cursor, and Stella, re-enrolls with no change, and asserts that Claude Desktop writes nothing |

The first pass named two strip leftovers as unverified: empty containers left
by the `settings-writer.ts`, `codex-writer.ts`, and `mcp-config-writer.ts`
strips, and an empty `stella.toml` left where enroll had created the file.
Neither reproduces on `main`. Each strip deletes a container it emptied, and
`HarnessFiles.settle` deletes a created file that is blank again. The rig
cases "creates nothing it does not remove on a machine with no harness files
at all" (macOS and Windows) prove both. The defect that did reproduce was the
reverse case, listed above.

### Findings not fixed in the second pass

| Finding | Why it is not fixed here |
|---|---|
| P3: `REMOVE_FROM_USER_PATH_PS` in `apps/desktop/src-tauri/src/cli_install.rs` sets the user `Path` to an empty string when Oxagen's directory was its only entry, instead of removing the variable. A trailing `;` in the original value is also not restored | The change is to a PowerShell string in Rust. It needs a Windows machine to verify, and this session had none |
| P3: `claudeManagedSettingsPath()` is called with `process.platform` in `model-base-url.ts` instead of the deps platform | It only reads a managed settings file. On a real host the two platforms agree |

## Round-trip coverage

`packages/tacho/src/cli/install-rig.test.ts` snapshots every path, mode,
content hash, and link target under a scratch home before install, and diffs
the tree after uninstall. `unenroll --purge` must leave an empty diff.

| Platform | Service manager | Harnesses | Killed-midway cases |
|---|---|---|---|
| macOS | launchd (fake `launchctl`) | Claude Code, Codex, Cursor, Stella, Claude Desktop | `fetch`, `launchctl bootstrap`, `readCodexHooks`, `readStellaHooks`, `writeClaudeDesktopConfig`, `daemonGet` |
| Linux | systemd (fake `systemctl`) | Claude Code, Codex, Cursor, Stella | `systemctl --user`, `readCodexHooks` |
| Windows | Task Scheduler (fake `schtasks`, `tasklist`, `taskkill`) | Claude Code, Codex, Cursor, Stella, Claude Desktop | `schtasks /Create`, `schtasks /Run`, `readStellaHooks`, `writeClaudeDesktopConfig`, `daemonGet` |

Every killed-midway case uninstalls to an empty diff, then enrolls again
without a duplicate. On macOS and Windows, a test asserts that the model base
URLs are gone from the harness settings before the daemon stops (`launchctl
bootout`, `taskkill`), so no harness points at a dead loopback port.

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

Second pass:

| Path | Scope inspected |
|---|---|
| packages/tacho/src/cli/install-rig.ts | Complete |
| packages/tacho/src/cli/install-rig.test.ts | Complete |
| packages/tacho/src/host/service.ts | Complete |
| packages/tacho/src/host/fs.ts | Complete |
| packages/tacho/src/host/harness-file.ts | Receipts, `settle`, `sameDocument`, and the atomic write |
| packages/tacho/src/host/settings-writer.ts | `stripTachoSettings` and the env ownership test |
| packages/tacho/src/host/codex-writer.ts | `stripHookGroups` |
| packages/tacho/src/host/mcp-config-writer.ts | `stripOxagenMcpServer` |
| packages/tacho/src/host/stella-writer.ts | `mergeStellaHooks`, `stripStellaHooks`, and `stellaHookPresence` |
| packages/tacho/src/host/claude-desktop-writer.ts | `claudeDesktopConfigPath` |
| packages/tacho/src/host/cursor-writer.ts | `cursorConfigDir` and `cursorHooksPaths` |
| packages/tacho/src/host/paths.ts | `tachoPaths` |
| packages/tacho/src/host/model-base-url.ts | The atomic write and the managed settings paths |
| packages/tacho/src/host/model-credential.ts | The atomic write |
| packages/tacho/src/collector/run.ts | Pid file handling |
| packages/tacho/src/cli/deps.ts | `defaultCliDeps` |
| packages/tacho/src/cli/enroll.ts | Service install and the gateway step |
| packages/tacho/src/cli/unenroll.ts | Service removal, revoke, and credential removal |
| packages/tacho/src/host/service.test.ts | Complete |
| packages/tacho/src/host/install-hardening.test.ts | `HarnessFiles` cases |
| packages/tacho/src/host/uninstall-recovery.test.ts | Windows service cases |
| apps/desktop/src-tauri/src/cli_install.rs | Windows shims and the user `Path` edit, lines 750 to 850 |

## Evidence and remaining work

Second pass: `install-rig.test.ts` (48 tests), `install-hardening.test.ts` (27),
`service.test.ts` (14), and `atomic-write.test.ts` (6) passed, each run alone.

The rest of this section is the first pass's record.

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

The second pass closed three items the first pass left open. The rig now
proves byte-identical restoration on all three platforms, including a process
killed midway. Temporary files are removed after a failed write or fsync. Uninstall no
longer kills a program that reused a stale Windows pid.

What remains open: native evidence of service install and removal on each
platform (`needs:rig`), the Linux `is-active` status 4 answer on each supported
systemd version, and a line-by-line pass over the `apps/desktop` sections not
listed above. The largest of those sections are `src/app.tsx` outside the
install handlers, `src-tauri/src/cli_install.rs` outside the listed lines,
`src/agents.ts`, `src/downloads.ts`, and `scripts/publish-downloads.mjs`. Full
gateway behavior depends on the separate #3299 work.
