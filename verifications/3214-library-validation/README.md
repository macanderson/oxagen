# #3214 library validation on

`desktop.yml` ran on this branch at a075b9eae, with
`com.apple.security.cs.disable-library-validation` removed from
`entitlements.plist`: https://github.com/macanderson/oxagen/actions/runs/36184484580
(workflow_dispatch, artifacts only, nothing published). All four build legs
passed.

The two logs are the "Start the bundle's sidecars and app" step of each macOS
leg, which runs `apps/desktop/scripts/smoke-macos-bundle.sh`:

- `aarch64-apple-darwin.log`: macos-15, Apple silicon.
- `x86_64-apple-darwin.log`: macos-15-intel.

On both legs:

- The app binary and both sidecars carry `flags=0x10002(adhoc,runtime)`: an
  ad-hoc signature with the hardened runtime on, so library validation was
  enforced. With no Team ID, any dynamic library outside the OS would have
  been refused.
- Each binary's entitlements are the two JIT keys and nothing else.
- `tacho --version` and `oxagen --version` answered 2.1.1 from inside the
  signed bundle. A Node single-executable reserves its V8 CodeRange at start,
  which is the start #3208 fixed.
- The app was still running 20 seconds after launch.
- The system log held no library validation message.

The step ran each sidecar directly rather than through the app. macOS
validates each process against its own signature and entitlements, so the
parent does not change the result.

Not covered: a Developer ID signed and notarized bundle, which needs the
Apple credentials (#4249).

## The re-sign path (#4313)

`desktop.yml` ran on the `fix/desktop-shell` branch at a4b06ef81:
https://github.com/macanderson/oxagen/actions/runs/36203799651
(workflow_dispatch, artifacts only, nothing published). Both macOS legs
passed.

The two `-resign` logs are the "Start a copy signed without the hardened
runtime" step of each macOS leg. The step copies the built bundle to
`$RUNNER_TEMP/Plain.app`, signs the copy ad hoc with
`codesign --force --deep -s -` and no `--options runtime`, and runs
`smoke-macos-bundle.sh` on it:

- `aarch64-apple-darwin-resign.log`: macos-15, Apple silicon.
- `x86_64-apple-darwin-resign.log`: macos-15-intel.

On both legs:

- The script reported a binary signed without the hardened runtime and took
  the branch that re-signs a second copy with `--options runtime` and the
  entitlements plist. That branch had never run before.
- The app binary and both sidecars of the re-signed copy carry
  `flags=0x10002(adhoc,runtime)`. The script now fails if one does not.
- `codesign --verify --deep --strict` found the re-signed copy valid on disk.
  It validated two pieces of nested code, `tacho` and `oxagen`, which the
  script re-signs before the bundle. So the outer re-sign needs no `--deep`:
  nothing else in the bundle keeps an older signature.
- `tacho --version` and `oxagen --version` answered 2.1.1, and the app was
  still running 20 seconds after launch.
- The system log held no library validation message.
