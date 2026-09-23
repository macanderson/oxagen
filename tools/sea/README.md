# tools/sea

`compile.mjs` turns a CommonJS bundle into a single executable with Node's
single-executable-application (SEA) support, so a machine without Node can
run `tacho` or `oxagen`. This directory is not a workspace package: it has no
`package.json`, and callers run the script with `node`.

## Boundary

- **Owns:** writing the SEA config, generating the blob, copying the host
  `node` binary, injecting the blob with `postject`, and on macOS stripping
  and re-signing the binary ad hoc.
- **Does not own:** the bundles it compiles (`scripts/bundle.mjs` in
  [`apps/cli`](../../apps/cli/README.md) and `bundle` in
  [`@oxagen/tacho`](../../packages/tacho/README.md)); staging the binaries
  as Tauri sidecars ([`apps/desktop`](../../apps/desktop/README.md),
  `scripts/sidecars.mjs`); Authenticode and notarization, which the release
  workflow applies; the Homebrew and Scoop manifests
  ([`tools/packaging`](../packaging/README.md)).
- **Depends on:** No `@oxagen/*` dependencies. It uses Node built-ins and
  `postject`, a root `devDependency`.
- **Used by:** the `compile` scripts of `apps/cli` and `packages/tacho`.
  `apps/desktop/scripts/sidecars.mjs` runs those two scripts and stages the
  results under the Rust target triple.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `node tools/sea/compile.mjs --entry <bundle.cjs> --name <tacho\|oxagen> --out <dir> [--triple <target>]` | boundary | `tools/sea/compile.mjs` | `pnpm --filter @oxagen/cli compile`, `pnpm --filter @oxagen/tacho compile` |
| Output name `<name>[-<triple>][.exe]` | boundary | `tools/sea/compile.mjs` | Tauri's `externalBin` expects the triple suffix. `apps/desktop/scripts/sidecars.mjs` currently adds it when it stages the binary |

## Entry points

- `compile.mjs`: the only file. It prints the output path on success and
  exits non-zero when a step fails.

## Rules

- Run it on the target OS and architecture. The host Node is the runtime that
  ships, and there is no cross-compile.
- On macOS, strip the Apple signature before injection, because `postject`
  cannot patch a signed Mach-O.

## Tests

This directory has no tests. To check a change, run one package's `compile`
script on your own OS and run the binary it prints.
