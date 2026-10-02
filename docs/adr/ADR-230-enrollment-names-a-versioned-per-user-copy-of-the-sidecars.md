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
- **The macOS copy drops the quarantine attribute.** A copy keeps the
  bundle's extended attributes, and Gatekeeper refuses to run a quarantined
  executable outside the app the person approved, so a hook or launchd could
  not start the copy. The person approved the app these binaries ship in,
  and the copy is made by that app, so it removes `com.apple.quarantine`
  from the two files it writes and nothing else.
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
  not part of this decision. The amendment of 2026-10-02 replaces this
  consequence.

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

## Amendment 2026-10-02: a journal, and an uninstall that runs without the app

#4298 asked for two things decision 6 left out: an install journal that
records what each install wrote, and an uninstall that removes exactly that
when the app is already gone. Before this amendment, a person who moved the
app to the Trash first had to delete the per-user copy, the PATH links, and
the shell profile lines by hand.

### Decision

7. **The app journals what it writes.** Every launch records, in the
   `journal` list in `~/.config/oxagen/desktop.json`, each thing it writes
   other than the directories and empty files already in `created`:

   | Entry | What it names |
   |---|---|
   | `copy` | a per-user copy, `<data-local>/oxagen/bin/<version>` |
   | `link` | a PATH symlink, with the `target` it points at |
   | `shim` | a Windows `.cmd` shim, with its whole `text` |
   | `profile` | a shell profile that holds the marker block |
   | `fish` | `~/.config/fish/conf.d/oxagen.fish`, which is wholly Oxagen's |
   | `user-path` | the link directory on the Windows user PATH |

   The copy, the profile, and the user PATH entry are recorded before they
   are written. A link or a block the launch finds already in place is
   recorded too, so a machine an older app set up gets a journal at its next
   launch. A launch that changes nothing writes nothing. "Remove links" drops
   the entries for what it removed, and the prune of old copies drops the
   entry for each copy it deleted. `record_journal` in `cli_install.rs`
   writes the journal.
8. **`oxagen agent uninstall` removes what the journal records, without the
   app.** It runs from the per-user copy, or from any other install of the
   `oxagen` CLI, and takes three steps:
   1. It runs `unenroll --all --purge`. It stops there when the unenroll did
      not finish or an agent is still enrolled. A hook that still names the
      copy would fail to spawn once the copy is gone.
   2. It undoes each journal entry only while the thing is still what the app
      wrote: a link that still points at its target, a shim with its exact
      text, the marker block (by the same rule as `remove_path_block`), a fish
      file that opens with the begin marker, and the user PATH entry. Anything
      else is left and named.
   3. It removes the two sidecars from each copy directory under
      `<data-local>/oxagen/bin`, journaled or found there, then the
      directories in `created` once they are empty, the Tacho directory, and
      `~/.config/oxagen`. That is the same set the app's own **Uninstall**
      removes. A `copy` entry that names a directory anywhere else, or a link
      where a copy should be, is left and named. The journal is a file in the
      person's home directory, so the command does not trust its paths to
      delete outside the one directory the app keeps copies in.

   With no journal (an app from before this amendment, never launched since),
   the copies still go, and the command names the links and profile lines to
   delete by hand.
9. **The collector does nothing on its own when the app is gone.** An update
   and a reinstall also remove the bundle for a moment, and the collector
   cannot tell those from a removal. Since decision 1, no hook and no service
   names the bundle, so a missing app breaks nothing. The person runs
   `oxagen agent uninstall` when they mean to remove Oxagen.

### Consequences

- The consequence "A terminal-only uninstall leaves the app's artifacts" no
  longer holds.
- On Windows the command cannot delete the `oxagen.exe` it runs from. It
  names that directory, to delete once the command exits.
- An app from before this amendment keeps the `journal` key when it rewrites
  `desktop.json`, because every writer of that file reads it, changes its own
  key, and writes the rest back.
- Decision 3 now has a check on Windows. `install-rig-real.test.ts` runs a
  daemon from one version's copy, shows that overwriting that running
  `tacho.exe` fails, copies a second version beside it, re-enrolls from the
  second, and checks that every hook file, `host.json`, and the scheduled
  task's launcher name only the second version. It then deletes the first
  copy with no reboot. `desktop-rig.yml` runs it on `windows-latest` on a push
  to `main` or a manual dispatch.

### Alternatives

- **Re-derive ownership in the CLI with the app's rules.** The CLI could
  treat any link into the copy directory, any marker block, and any shim of
  the released shape as the app's, with no journal. Two copies of those rules
  in two languages drift apart, and nothing would record what was written.
- **Have the collector remove itself when its app disappears.** Rejected by
  decision 9: an update would look the same.
- **Ship an uninstaller as a third sidecar.** It would need its own build,
  signing, and copy, to do what the `oxagen` already in the copy does.
