# tools/packaging

Package-manager distribution: templates and scripts for installing the Oxagen
desktop app and the two compiled CLIs through Homebrew and Scoop. This
directory is not a workspace package. It has no `package.json`, and callers
run its scripts with `node`.

## Boundary

- **Owns:** the Homebrew cask and formula templates (`homebrew/`), the Scoop
  manifest template (`scoop/`), the checksum writer (`checksums.mjs`), and the
  template filler (`stamp.mjs`).
- **Does not own:** compiling the binaries ([`tools/sea`](../sea/README.md));
  building and signing the desktop bundles
  ([`apps/desktop`](../../apps/desktop/README.md) and
  `.github/workflows/desktop.yml`); the tap and the bucket, which do not
  exist yet; the release artifact table the publish script checks
  (`tools/scripts/lib/release-artifacts.ts`, which mirrors the tables here).
- **Depends on:** No `@oxagen/*` dependencies. Both scripts use Node
  built-ins only.
- **Used by:** `.github/workflows/desktop.yml`, which runs `checksums.mjs` on
  each release job. `stamp.mjs` is run by hand, or later by a tap job.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `node tools/packaging/checksums.mjs <dir \| file> [...]` | boundary | `tools/packaging/checksums.mjs` | `.github/workflows/desktop.yml` |
| `<asset>.sha256` files in `sha256sum` format | boundary | `tools/packaging/checksums.mjs` | Read back by `stamp.mjs`, and by `shasum -a 256 -c` or `sha256sum -c` |
| `{{version}}`, `{{sha256:<asset>}}`, and `# stamp:` tokens | boundary | `tools/packaging/stamp.mjs` | The templates in `homebrew/` and `scoop/` |
| Release asset names | boundary | This README's tables | `tools/scripts/lib/release-artifacts.ts` mirrors them |

## Entry points

- `checksums.mjs`: writes a `.sha256` beside every release asset.
- `stamp.mjs --version <v> --sums <dir> --out <dir>`: fills the templates.
- `homebrew/oxagen.rb`, `homebrew/tacho.rb`, `scoop/oxagen.json`: the
  templates.

## Rules

- A checked-in template carries no digest for a build nobody has made.
- `stamp.mjs` fails on a token with no matching `.sha256` rather than writing
  a file that installs nothing.
- Every package runs `tacho unenroll` before it removes the binaries.

## Tests

This directory has no tests. `brew audit` and Scoop's `checkver` run in the
tap and the bucket, on the stamped copies.

## Overview

Templates for installing the Oxagen desktop app and the two compiled CLIs
through Homebrew and Scoop. They are **templates until a tap and a bucket
exist**: nothing here is published anywhere yet, `brew install` and
`scoop install` cannot find them, and the release flow below is the flow a
tap job will run, not one that runs today. Spec for the app and the binaries:
`docs/specs/oxagen-desktop/spec.html` (§8, §9).

| File | Installs | From |
|---|---|---|
| `homebrew/oxagen.rb` | Cask: `Oxagen.app` plus `tacho` and `oxagen` linked from inside it | `Oxagen_<version>_aarch64.dmg`, `Oxagen_<version>_x64.dmg` |
| `homebrew/tacho.rb` | Formula: the bare `tacho` and `oxagen` executables, no app | `tacho-<triple>`, `oxagen-<triple>` for the two macOS triples and `x86_64-unknown-linux-gnu` |
| `scoop/oxagen.json` | Scoop: the bare `tacho.exe` and `oxagen.exe` shimmed as `tacho` and `oxagen` | `tacho-x86_64-pc-windows-msvc.exe`, `oxagen-x86_64-pc-windows-msvc.exe` |

The desktop app on Windows and Linux is the `.msi` / `-setup.exe` and the
`.deb` / `.rpm` / `.AppImage` on the release page; there is no winget, apt or
dnf entry.

## What the release produces

`.github/workflows/desktop.yml` runs on a `desktop-v<version>` tag, one job
per target. Each job:

1. compiles `tacho` and `oxagen` into Node single-executables with
   `tools/sea/compile.mjs` and stages them as
   `apps/desktop/src-tauri/binaries/<name>-<triple>[.exe]`;
2. builds the app with `tauri-action`, which creates the draft GitHub
   release `Oxagen desktop-v<version>` and attaches the bundles, named by the
   tauri bundler:

   | Target | Assets |
   |---|---|
   | `aarch64-apple-darwin` | `Oxagen_<version>_aarch64.dmg` |
   | `x86_64-apple-darwin` | `Oxagen_<version>_x64.dmg` |
   | `x86_64-unknown-linux-gnu` | `Oxagen_<version>_amd64.deb`, `Oxagen-<version>-1.x86_64.rpm`, `Oxagen_<version>_amd64.AppImage` |
   | `x86_64-pc-windows-msvc` | `Oxagen_<version>_x64_en-US.msi`, `Oxagen_<version>_x64-setup.exe` |

3. writes a `<asset>.sha256` next to each staged binary and, on the macOS
   jobs, next to the `.dmg` (`tools/packaging/checksums.mjs`, `sha256sum`
   format) and attaches the binaries and every checksum to the same release,
   so the formula and the manifest can install the CLIs without the app and
   the cask's `# stamp:` digests have a `.sha256` to read.

The version is the lockstep monorepo version (`pnpm release:*` bumps every
package, `apps/desktop/package.json` included, and `tacho --version` prints
the same number), so the tag is `desktop-v` plus that version.

## Filling the templates

Every digest in the templates is a token, and the version is a token, because
the checked-in files must not carry a digest for a build nobody has made:

| Token | Meaning |
|---|---|
| `{{version}}` | the release version without the `desktop-v` prefix |
| `{{sha256:<asset>}}` | the digest of that release asset, read from `<asset>.sha256`; `<asset>` may contain `{{version}}` |
| `# stamp: <text>` | a directive: the stamped file gets `<text>` in place of the *next* line |

The cask keeps `sha256 :no_check` in the template, which is the honest value
for an unsigned build with no digest on file, and a `# stamp:` directive
above it that says what the tap copy becomes (`sha256 arm: "…", intel: "…"`).
A formula cannot use `:no_check` (that stanza is cask-only), so `tacho.rb`
carries a `{{sha256:…}}` token per asset and refuses to stamp if one is
missing.

Once the release is published, a tap job (or a person) runs:

```
mkdir -p /tmp/sums && cd /tmp/sums
gh release download desktop-v2.1.1 --repo macanderson/oxagen --pattern '*.sha256'
cd - && node tools/packaging/stamp.mjs --version 2.1.1 --sums /tmp/sums --out /tmp/stamped
```

and commits `/tmp/stamped/homebrew/*.rb` to the tap's `Casks/` and
`Formula/` and `/tmp/stamped/scoop/oxagen.json` to the bucket. `stamp.mjs`
fails on a token with no matching `.sha256` rather than shipping a file that
installs nothing. `brew audit --cask` / `brew audit --strict` and Scoop's
`checkver` are the tap's and the bucket's gates; run them there, on the
stamped copies.

## Uninstall order, everywhere

All three carry the order the app enforces: `tacho unenroll` first (strips
the hooks it wrote into every enrolled harness, stops the service, revokes on the control plane,
deletes the host credentials), then the package. The cask runs it in
`uninstall script:` and also unloads `sh.oxagen.tachod`; the manifest runs it
in `pre_uninstall` when `host.json` exists; the formula says so in its
caveats because a formula has no uninstall hook. `~/.config/oxagen` is only
removed by the cask's `zap`.
