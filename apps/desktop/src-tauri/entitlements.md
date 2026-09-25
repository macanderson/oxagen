# `entitlements.plist`

Why the macOS bundle needs entitlements, kept here because Apple's
entitlements parser (AMFI) rejects XML comments inside the plist itself. A
commented plist fails the build with
`Failed to parse entitlements: AMFIUnserializeXML: syntax error`.

The two sidecars (`oxagen`, `tacho`) are Node single-executable
applications, so each embeds V8 and reserves a JIT CodeRange at startup.
tauri signs every bundled binary with the hardened runtime
(`codesign --options runtime`), which denies that reservation unless the
binary carries `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory`. V8 does not
degrade when the reservation fails. It aborts:

```
Fatal process out of memory: Failed to reserve virtual memory for CodeRange
```

That failure is quiet in the worst way: the app window still opens, and
only the panels that shell out to a sidecar break, so the app looks
installed and every action reports an error.

These stay correct once a Developer ID is configured. A notarized app that
ships a JIT needs exactly these two, so they are not ad-hoc scaffolding.

## Library validation stays on

The plist does not carry `com.apple.security.cs.disable-library-validation`.
#3208 added it on the theory that library validation governs launching the
sidecars. It does not. Library validation decides which dynamic libraries a
process may load. Launching a sidecar is an exec, and macOS validates each
executable against its own signature. The key did nothing for the sidecars,
and it let every process signed with this plist load unsigned libraries
(#3214).

The app and both sidecars link only system libraries, which library
validation always admits. The Node single-executable sidecars load no native
addon.

`scripts/smoke-macos-bundle.sh` checks this on every macOS build in
`.github/workflows/desktop.yml`. The script prints each binary's signature
and entitlements, runs `tacho --version` and `oxagen --version` from inside
the signed bundle under the hardened runtime, and starts the app for 20
seconds. A third-party dynamic library that a binary links, or loads during
those first 20 seconds, fails that step before anything publishes. The step
does not run every command path. A library loaded later with `dlopen`, for
example a native addon a sidecar loads for one command, would pass it and
fail on a customer's machine.

Add the key back only with the library that needs it named here.
