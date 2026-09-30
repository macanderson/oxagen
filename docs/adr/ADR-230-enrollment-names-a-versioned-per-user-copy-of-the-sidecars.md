# ADR-230: Enrollment names a versioned per-user copy of the sidecars

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** desktop, tacho
- **Related:** issue #4298, audit findings D-02 and D-03 (#3944),
  `apps/desktop/src-tauri/src/cli_install.rs`,
  `packages/tacho/src/cli/deps.ts`, `packages/tacho/src/host/hook-guard.ts`.

## Context

`tacho enroll` writes the path of the `tacho` it runs from into five places:
every hook command, the Claude Code credential helper, the Claude Desktop MCP
entry, the collector's service unit, and `host.json`. The desktop app runs its
bundled sidecar, so each of those named a path inside the app bundle
(`/Applications/Oxagen.app/Contents/MacOS/tacho`, `/usr/bin/tacho`, or
`C:\Program Files\Oxagen\tacho.exe`). The app copied the sidecars into a
per-user directory only when it ran from a disk image, an AppImage mount, or
App Translocation.

When someone moved the app to the Trash, or removed the package, without
running Uninstall:

- every Claude Code, Codex, and Stella tool call ran a hook that could not
  spawn;
- launchd and systemd kept restarting a daemon that no longer existed;
- Cursor's veto hooks, which carry `failClosed: true`, blocked every action.
  Stella reads a non-zero exit as a deny, so it blocked every tool call too.

macOS runs nothing when a bundle goes to the Trash, so no uninstaller can
clean up after it.

On Windows the installer could not replace a `tacho.exe` the running daemon
held open, so an update failed or waited for a reboot (D-03).

## Decision

1. **Every command enrollment writes names a versioned per-user copy.** On
   every launch, whatever the PATH link setting says, the app copies both
   sidecars into `<data-local>/oxagen/bin/<version>`:
   `~/Library/Application Support/oxagen/bin/<version>` on macOS,
   `~/.local/share/oxagen/bin/<version>` on Linux, and
   `%LOCALAPPDATA%\oxagen\bin\<version>` on Windows. The version is the app's,
   which the build stamps into the crate. A copy already there with the
   bundle's length and a time no older than the bundle's is left alone.
   Every sidecar the app runs gets `TACHO_BIN_DIR` set to that directory, and
   the PATH links and Windows shims point into it. No command that outlives a
   launch names a path inside the bundle.
2. **`tacho` refuses rather than name itself.** When `TACHO_BIN_DIR` names a
   directory that holds no `tacho`, `runtimeCommands` reports an
   `executableProblem` and `enroll` refuses. It no longer falls back to the
   running process, which for the app is the bundle's sidecar. The fallback
   stays for an install that sets no `TACHO_BIN_DIR`, such as Scoop.
3. **An update installs beside the running version.** A new version copies
   itself into its own directory, so no file the daemon or a hook holds is
   replaced, on any platform. The hooks and the daemon keep naming one
   version together until `tacho enroll` runs from the new copy (the app's
   **Re-apply**, which it offers when the versions differ). `enroll` then
   rewrites every hook, the service, and `host.json` onto the new copy.
4. **An old version goes once nothing names it.** Each launch removes the
   sidecars in every other version directory, and in the flat copy earlier
   releases made in `<data-local>/oxagen/bin` itself, when no agent's
   `host.json` string and no PATH link or shim names that directory. When any
   `host.json` cannot be read, no copy is removed. A file Windows will not
   delete because a process holds it stays until a later launch.
5. **A hook that blocks on a failure answers for a collector that is gone.**
   On macOS and Linux, the Cursor and Stella hook commands test for the
   collector's executable first:

   ```sh
   test ! -e '<dir>/tacho' && printf '%s\n' '{"permission":"allow"}' && exit 0; exec '<dir>/tacho' hook --enrollment <id> --harness cursor
   ```

   Cursor gets the collector's own allow for each event, and Stella gets no
   output. A collector that is there runs as before, so its deny, a crash, or
   a timeout still blocks under `failClosed`. The test uses only syntax that
   `sh`, `bash`, `zsh`, and `fish` read the same way. Claude Code and Codex
   block only on exit code 2 and report any other failure as an error, so
   their commands are unchanged, and the error tells the person the
   collector is gone.
6. **Receipts are the install journal.** `HarnessFiles` already records, per
   agent, each harness file enrollment touched: whether it existed, its
   mode, a byte copy, and the directories made for it. `host.json` records
   the commands, and the service has one fixed label. So
   `tacho unenroll --all --purge`, run from the per-user copy with no app on
   the machine, removes exactly what enrollment wrote. The app's own
   artifacts (the copies, the PATH links, and the shell profile block) are in
   `desktop.json`'s `created` list and the profile markers, and the app's
   **Uninstall** removes them.

## Consequences

- **An existing enrollment moves on the next enroll.** Hooks that name the
  bundle keep working while the bundle is there. The app's panel says the
  hooks do not run its tools and offers **Re-apply**, which rewrites them
  onto the copy. The app does not re-enroll by itself at launch.
- **An update no longer moves the collector by itself.** Before, the hooks
  named the bundle, so a swapped bundle and a service restart moved them to
  the new build. Now the collector stays on the version it was enrolled
  with, which is still complete and working, until **Re-apply**.
  `restart_tacho_service` restarts that same version.
- **Each version costs about 240 MB on disk until it is pruned.** At most
  two versions are kept at once in the usual case: the one the hooks name
  and the one the app carries.
- **Deleting the executable turns Cursor's and Stella's hooks off.** Anyone
  who can delete `<data-local>/oxagen/bin` can also edit
  `~/.cursor/hooks.json` or `~/.stella/stella.toml`, which already turns them
  off, so the guard adds no way around a mandate that the files did not
  already allow.
- **Windows hooks are not guarded.** Claude Code and Codex run a hook through
  `cmd.exe` there, and Stella through `bash`, and no one test reads the same
  in both. A Windows uninstaller leaves `%LOCALAPPDATA%\oxagen\bin`, so the
  hooks keep running. They block only when someone deletes the copy by hand
  without unenrolling.
- **A terminal-only uninstall leaves the app's artifacts.** Without the app,
  the person runs the copy's `tacho unenroll --all --purge` and then deletes
  the copy, the links, and the profile block by hand, as the desktop docs
  describe. A `tacho` command that reads `desktop.json` and removes them is
  not part of this decision.

## Alternatives

- **Keep the bundle path and add a macOS uninstall hook.** macOS runs nothing
  when a bundle goes to the Trash, and Linux package managers run no user
  code for a per-user enrollment, so the hook would not run where it is
  needed.
- **One unversioned per-user copy, replaced in place.** An update would
  overwrite a file the daemon holds, which Windows refuses (D-03), and hooks
  would run a new binary before the daemon restarts.
- **A `current` link to the newest version.** Hooks would never need
  rewriting, but Windows symbolic links need Developer Mode or elevation,
  and a directory junction cannot be swapped in one step. The hooks and the
  daemon could also run different versions between the swap and the restart.
- **Fail open for every harness when the collector is gone.** Claude Code and
  Codex do not block on a failed hook, and their error is the only sign the
  collector is gone, so wrapping them removes the signal and adds nothing.
