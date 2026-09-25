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
