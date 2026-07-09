---
name: mcp-build-duckdb-native-externals
type: bug
domain: mcp
severity: P1
linear:
date: 2026-07-04
---

**Symptom:** `@oxagen/mcp` production build (rspack via `xmcp build`) failed with
`Module parse failed` / `Module not found` (9 errors) — it tried to statically
bundle the native `duckdb` addon and its `@mapbox/node-pre-gyp` -> `node-gyp`
toolchain, which ship non-JS assets (C# `Find-VisualStudio.cs`, `index.html`,
`s3_setup.js`) and dynamically `require()` aws-sdk / mock-aws-s3 / nock. This
broke every `e2e` shard on main's CI (the e2e job's "Build (affected)" step
builds `@oxagen/mcp`).

**Root cause:** `duckdb` is dragged into the mcp bundle transitively:
`src/middleware.ts` -> `@oxagen/agent` register/handlers ->
`agent.trace.get.ts` -> `@oxagen/engram` barrel -> `store/graph-store.ts`,
which does a runtime `require("duckdb")` (line ~147). rspack resolves that
require statically and pulls the whole native toolchain into the graph.
`apps/mcp/xmcp.config.ts` already externalizes heavy/native packages
(dockerode, neo4j-driver, etc.) but the `duckdb` chain was missing from the
list, even though `apps/app/next.config.mjs` had long externalized it.

**Fix:** added `duckdb`, `@mapbox/node-pre-gyp`, `node-gyp`, `mock-aws-s3`,
`aws-sdk`, `nock`, `blake3` to the `heavyPackages` externals list in
`apps/mcp/xmcp.config.ts` so they resolve from `node_modules` at runtime
instead of being bundled — mirrors the identical externals in
`apps/app/next.config.mjs`. Build then succeeds: "Built STDIO server / Built
HTTP server / Registered 280 tools", 0 errors.

**Guard:** `apps/mcp/src/xmcp-config.externals.test.ts` invokes the bundler
override's function-based external for every package in the native chain and
asserts each is returned as `commonjs <pkg>` (including sub-path imports), plus
negative cases (workspace contracts / relative imports / `duckdbx` must NOT be
externalized). Fails on the old config (14/15 fail), passes on the new (15/15).

**Watch-outs:**
- Any new `@oxagen/engram` (or other native-addon) import reaching `apps/mcp`
  via `@oxagen/agent`'s handler barrel will re-trigger this. If you add a
  native/Node-only dep anywhere in the handler chain, add it to BOTH
  `apps/mcp/xmcp.config.ts` heavyPackages AND `apps/app/next.config.mjs`
  externals (and the app's `turbopack.resolveAlias` stub if node-pre-gyp).
- `packages/engram`'s `duckdb`/`blake3` are `optionalDependencies` reached via
  `require()` / dynamic import with fallbacks — they are runtime-only and must
  never be bundled.
- Verifying an mcp build in a `.claude/worktrees` worktree fails
  (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR` / missing package bins). Verify the
  build/test in the fully-installed shared checkout with
  `pnpm --config.verify-deps-before-run=false --filter @oxagen/mcp exec <cmd>`
  to bypass the contested-tree auto-install, then restore the shared checkout.
