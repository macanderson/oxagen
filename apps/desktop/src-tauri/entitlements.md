# `entitlements.plist`

Why the macOS bundle needs entitlements, kept here because Apple's
entitlements parser (AMFI) rejects XML comments inside the plist itself —
a commented plist fails the build with
`Failed to parse entitlements: AMFIUnserializeXML: syntax error`.

The two sidecars (`oxagen`, `tacho`) are Node single-executable
applications, so each embeds V8 and reserves a JIT CodeRange at startup.
tauri signs every bundled binary with the hardened runtime
(`codesign --options runtime`), which denies that reservation unless the
binary carries `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory`. V8 does not
degrade when the reservation fails — it aborts:

```
Fatal process out of memory: Failed to reserve virtual memory for CodeRange
```

That failure is quiet in the worst way: the app window still opens, and
only the panels that shell out to a sidecar break, so the app looks
installed and every action reports an error.

`com.apple.security.cs.disable-library-validation` is there because the
app execs the sidecars as nested code; library validation refuses code
signed under a different team identity, and an ad-hoc signature carries no
team identity at all.

These stay correct once a Developer ID is configured — a notarized app
that ships a JIT needs exactly these — so this is not ad-hoc-only
scaffolding.
