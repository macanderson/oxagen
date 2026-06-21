---
description: Fix React build failures in a Turborepo monorepo using Next.js (App Router) — incremental fixes for TypeScript/JSX compile errors, Next.js server/client component boundary issues, hydration mismatches, and missing types. Invokes the react-build-resolver agent for minimal, surgical fixes.
---

# React Build and Fix

This command invokes the **react-build-resolver** agent to incrementally fix React/Next.js build errors in a Turborepo monorepo with minimal, surgical changes.

## What This Command Does

1. **Detect Build System**: Focus on Next.js apps inside a Turborepo monorepo
2. **Run Build**: Execute the workspace build targeting affected Next.js app(s)
3. **Parse Errors**: Group by layer (TypeScript / bundler config / runtime / hydration)
4. **Fix Incrementally**: One error at a time, re-running build after each change
5. **Report Summary**: Show what was fixed and what remains

## When to Use

Use `/react-build` when:

- `pnpm -w turbo run build` or a workspace build fails, or a specific Next.js app build fails
- JSX/TSX compile errors after a TypeScript or React upgrade
- Next.js hydration mismatch errors at runtime
- Server/Client Component boundary errors in the App Router
- After upgrading `react`, `react-dom`, `@types/react`, next, or shared workspace packages
- Missing types or "module not found" errors involving React/shared packages

## Scope

This command owns **Next.js (App Router) build, server/client component, and hydration** failures in a Turborepo monorepo. For pure TypeScript type errors with no React/Next.js involvement, use `/build-fix` (generic) instead.

## Diagnostic Commands Run

```bash
# Monorepo build (preferred)
pnpm -w turbo run build 2> /dev/null

# Build a specific Next.js app (from workspace root)
pnpm --filter ./apps/<app-name> run build

# Standalone typecheck (workspace-aware)
pnpm -w run typecheck --if-present
pnpm --filter ./apps/<app-name> exec tsc --noEmit -p apps/<app-name>/tsconfig.json

# Next.js explicit build
next build apps/<app-name> || (cd apps/<app-name> && pnpm run build)
```

## Example Session

````text
User: /react-build

Agent:
# React Build Resolution

## Build System Detected
Turborepo monorepo with Next.js apps (detect apps/* or packages/* with next.config.js / package.json scripts)

## Initial Diagnostics

```bash
$ pnpm --filter ./apps/web run build
> tsc -b && next build

apps/web/src/app/components/UserCard.tsx:1:8 - error TS6133: 'React' is declared but its value is never read.
apps/web/src/app/components/Modal.tsx:12:15 - error TS7016: Could not find a declaration file for module 'react-portal'.
apps/web/src/app/page.tsx:42:5 - error: 'useState' is not defined
```

Errors found: 3

## Fix 1: Old JSX transform leftover (monorepo app)

File: apps/web/src/app/components/UserCard.tsx:1
Cause: app tsconfig or root tsconfig.json uses `"jsx": "react-jsx"`; explicit `import React` is unused.

```tsx
// Removed
- import React from 'react';
```

```bash
$ npm run build
# 2 errors remaining
```

## Fix 2: Missing types

File: apps/web/src/app/components/Modal.tsx
Cause: `@types/react-portal` not installed in workspace.

```bash
pnpm -w add -D @types/react-portal
```

```bash
$ npm run build
# 1 error remaining
```

## Fix 3: Missing hook import

File: apps/web/src/app/page.tsx
Cause: `useState` referenced but not imported.

```tsx
- import { useEffect } from "react";
+ import { useEffect, useState } from "react";
```

```bash
$ pnpm --filter ./apps/web run build
# Build successful!
```

## Final Verification

```bash
pnpm -w turbo run build
[32m✓ built apps/web in 2.34s[0m

pnpm -w test
[32m✓ 47 tests passed[0m
```

## Summary

| Metric | Count |
|--------|-------|
| Build errors fixed | 3 |
| Files modified | 2 |
| Dependencies added | 1 (@types/react-portal) |
| Remaining issues | 0 |

Build Status: PASS: SUCCESS
````

## Common Errors Fixed

| Error | Typical Fix |
|---|---|
| `'React' is not defined` | Set `"jsx": "react-jsx"` in tsconfig (React 17+) |
| Missing `@types/react` | `npm i -D @types/react @types/react-dom` |
| `Unexpected token '<'` | Add `@vitejs/plugin-react` / `babel-loader` |
| `You're importing a component that needs useState` (Next.js) | Add `"use client"` or move hook to a Client Component child |
| `Module not found: Can't resolve 'fs'` (Next.js) | Remove `fs` import or move logic into Server Component / API route |
| `Hydration failed because the initial UI does not match` | Move `Date.now()`/`Math.random()`/`window.*` to `useEffect` |
| `Invalid hook call` | Multiple React copies — dedupe via `resolutions`/`overrides` |
| `Element type is invalid` | Default vs named import mismatch |

## Fix Strategy

1. **Compile errors first** — code must build
2. **Hydration errors second** — affects production correctness
3. **Bundler config third** — restore plugin/loader correctness
4. **One fix at a time** — verify each change
5. **Minimal changes** — never `// @ts-ignore` without explanation
6. **Re-run after each fix** — surface new errors immediately

## Stop Conditions

The agent will stop and report if:

- Same error persists after 3 attempts
- Fix introduces more errors than it resolves
- Requires architectural change beyond build resolution (e.g., redesigning the RSC boundary)
- Bundler version no longer supports the installed React major

## Related Commands

- `/react-test` — run tests after the build is green
- `/react-review` — review code quality after the build succeeds
- `/build-fix` — generic build fixer (non-React)
- `verification-loop` skill — full verification loop

## Related

- Agent: `agents/react-build-resolver.md`
- Skills: `skills/react-patterns/`, `skills/frontend-patterns/`
- Rules: `rules/react/coding-style.md`, `rules/react/patterns.md`