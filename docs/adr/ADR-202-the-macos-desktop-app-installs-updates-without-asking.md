# ADR-202: The macOS desktop app installs updates without asking

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** desktop
- **Related:** issue #4418 (this change), issue #3697 (the prompt-only rule
  this replaces), PR #4303 (the update watch), ADR-158 (the installers and
  the updater feed), issue #4249 (Developer ID signing).

## Context

Since #4303 the desktop app reads the updater feed
(`desktop-latest/latest.json`) at launch, every hour, and when the window
takes focus 15 minutes or more after the last check. A newer version gets a
panel with **Install and relaunch** and **Later**, and nothing downloads
until you click. Mac confirmed that rule on #3697 on 2026-09-25.

On 2026-09-26 Mac asked for updates that install without asking, and asked
whether that is allowed.

It is allowed for how Oxagen ships. The Mac App Store and the Microsoft
Store forbid an app that updates itself outside the store. Oxagen ships
through neither: installers come from downloads.oxagen.sh and GitHub
releases (ADR-158). Outside the stores, silent updates are ordinary: Chrome,
VS Code, Slack, and Zoom all do it. Four things keep it honest:

1. The update is signed, and the app checks the signature before it
   installs anything. The updater plugin verifies every download against
   the minisign key in `tauri.conf.json`.
2. You can turn it off, and an administrator can turn it off for you.
3. The install never asks for an administrator password it did not ask for
   before.
4. The terms of service say the app updates itself.

What the plugin (`tauri-plugin-updater` 2.12.0) does on each platform
decides where a silent install is possible:

- **macOS.** It unpacks the new bundle into the temporary folder, renames
  the running `Oxagen.app` into a backup folder there, and renames the new
  bundle into place. The running process keeps its old files, so the swap
  is safe mid-session. If the first rename fails with a permission error, it
  asks for an administrator password through AppleScript. If the bundle is
  on a different volume from the temporary folder, the rename fails and the
  install fails.
- **Windows.** It launches the NSIS or MSI installer and exits the app at
  once. The collector's scheduled task runs `tacho.exe` from the app's
  install folder (`bin_dir`), and Windows cannot replace a running
  executable.
- **Linux.** A `.deb` or `.rpm` installs through `pkexec`, which asks for a
  password. An AppImage is renamed in place, but it runs from a transient
  mount, so hooks and the collector use a durable copy of the sidecars that
  the swap does not refresh.

Three defects sit next to this change:

- A clicked install relaunches the app but leaves `tachod` on the old
  binary until the next login, `tacho enroll`, or reboot. New `tacho hook`
  processes start from the new bundle and talk to the old daemon.
- A clicked install hides the window and never relaunches. The click sets
  the page's busy hold, and Tauri 2's `request_restart` goes through the same
  `ExitRequested` event that `lib.rs` holds while the page is busy. The
  window hides, and when the page goes idle `activity.rs` quits the app with
  `exit(0)`, so it never reopens. The fix releases the hold after the
  install and before the relaunch.
- The feed has never existed. ADR-158 §3 keeps deploy builds off it, and no
  `desktop-v*` release has run, so `desktop-latest/latest.json` answers 404
  and every background check fails quietly.

## Decision

### 1. macOS installs without asking when five gates pass

`update_policy` in `apps/desktop/src-tauri/src/update.rs` checks all five.
The page reads the result before it acts on an offer.

1. The app runs on macOS.
2. The executable sits inside an `.app` bundle.
3. The bundle is not transient: not on a mounted disk image and not under
   App Translocation (`cli_install::is_transient_dir`).
4. Your account can write the bundle and the folder it is in, so the
   plugin's rename needs no password. `/bin/test -w` answers for each.
5. The bundle is on the same volume as the temporary folder, where the
   plugin parks the old bundle.

The off switch in §5 is the sixth condition. When any check fails, the app
shows the prompt from #4303, and the Updates panel names the gate that
failed.

### 2. The install never relaunches the app

1. The watch offers a version, as it does today.
2. The app downloads it with no hold on quit. A quit mid-download drops the
   download, and the next launch checks again.
3. The app installs it under the page's busy hold (`set_busy`), so a close
   or a Quit during the swap waits for the swap to finish.
4. The app restarts `tachod` (§4).
5. The masthead says the version is installed and shows **Restart**.

The app keeps running the old build until you restart it. Closing the
window quits the app when nothing is running, so the next open runs the new
build. Until then, the old window drives the new sidecars, because
`run_sidecar` finds them by path inside the bundle. A newer offer before the
restart installs over the first one.

### 3. A failed install falls back to the prompt

A download, signature, or install error writes the error to the activity
log and shows the prompt for the same version. The watch does not retry a
version it offered, so a failure costs one prompt, not a loop.

### 4. Every install restarts the collector

After an automatic install, and after a clicked install before its
relaunch, the app runs `restart_tacho_service`:

- **macOS.** `launchctl print gui/<uid>/sh.oxagen.tachod` answers whether
  the service is loaded. When it is, `launchctl kickstart -k` restarts it,
  the same call `tacho enroll` makes.
- **Linux.** `systemctl --user is-active tachod.service` answers whether it
  runs. When it does, `systemctl --user restart tachod.service` restarts it.
- **Windows.** Not reached: the installer exits the app first (§6).

A restart that fails is logged and does not fail the update.

### 5. `autoUpdate` in `desktop.json` is the off switch

`~/.config/oxagen/desktop.json` already holds the app's preferences
(`autoLinkCli`). `autoUpdate` joins it:

- Absent means on.
- `true` means on.
- Any other value means off, so a mistyped `"false"` string stops installs
  instead of allowing them.

The **Install updates automatically** checkbox in the Updates panel writes
the key and keeps every other key. An administrator can ship the file with
a management tool.

### 6. Windows and Linux keep the prompt

Their installers need a password (`.deb`, `.rpm`), exit the app mid-session
and meet a running `tacho.exe` (Windows), or leave the durable sidecar copy
behind (AppImage). Each needs work of its own, listed under phase 2.

### 7. The feed stays release-only and forward-only

ADR-158 §3 stands: deploy builds never reach the feed.
`.github/scripts/desktop-update-feed.sh` never moves the feed backwards, so
a bad release is fixed by a newer one. With silent installs, a release
reaches every Mac that has automatic updates on within about an hour. The
release workflow is the gate.

## Phase 2

Recorded here, not built:

- **Installs while the app is closed.** `tachod` runs all day and could read
  the feed and stage the update.
- **Organization policy.** Automatic, prompt, or a pinned version, set in
  the control plane for every enrolled machine.
- **Staged rollout and a kill switch.** A rollout percentage and a halt flag
  in `latest.json`, which the plugin exposes as `rawJson`, so a release
  reaches 10 percent of machines before the rest.
- **Windows.** A quiet NSIS install (`plugins.updater.windows.installMode:
  "quiet"`) that stops the collector's scheduled task before the installer
  runs and starts it after.
- **Linux AppImage.** An in-place swap that also refreshes the durable
  sidecar copy.
- **Developer ID signing and notarization** (#4249). Until then every
  update is ad-hoc signed. Credentials live in sealed files, not the
  keychain, so a new signature triggers no keychain prompt.

## Consequences

- No update reaches anyone until a `desktop-v*` release publishes
  `latest.json` to `desktop-latest`. On 2026-09-26 none has.
- A Mac with automatic updates on runs a release within about an hour of the
  feed moving, plus one restart.
- A standard account with the app in `/Applications` cannot write that
  folder, so it keeps the prompt, and a click still asks for an
  administrator password.
- A process killed between the plugin's two renames leaves no app in the
  folder. The old bundle waits in the temporary folder. The clicked install
  carries the same risk.
- Oxagen has no terms of service. On 2026-09-26 Mac asked for the fourth
  condition to be met anyway, so the disclosure lives on the page you
  download the app from (`apps/docs/content/docs/cli/desktop.mdx`, under
  Updates). It says what installs, when, how to turn it off, and that
  Windows and Linux ask first. Every other block that hands out an
  installer carries a short notice. In the docs, `LatestDownloads` and
  `ReleaseDownloads` link to that section (`ReleaseDownloads` from 2.1.2,
  the first app with the updater). In the web app, `DesktopDownloads` on
  the enrollment and onboarding screens names the off switch. On
  downloads.oxagen.sh, `renderIndexHtml` (`apps/desktop/src/downloads.ts`)
  puts a short notice under the download button and a full one, with the
  off switch, under Verify, from 2.1.2 on. When Oxagen writes terms of
  service, they carry this sentence: "On macOS, the Oxagen desktop app
  downloads and installs new versions automatically unless you turn
  automatic updates off."
- This replaces the rule confirmed on #3697 for macOS installs that pass the
  gates. Everywhere else, that rule still holds.
