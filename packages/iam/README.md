# @oxagen/iam

`@oxagen/iam` is the IAM runtime the capability kernel calls on every `invoke()`: it reads a principal's roles and grants from Postgres, runs the resolver, records the decision, and answers allow or deny. It also holds the organisation-role, mandate-role, machine-key, and kill-switch checks that handlers call directly.

## Boundary

- **Owns:**
  - `bootstrapIAMRuntime()`, which installs the kernel's IAM check and the access-request creator.
  - `checkIAM` (`src/check-iam.ts`): the non-enterprise fast path, the full resolve for enterprise organisations, and resolution for agent runs at every tier.
  - Authorization reads (`src/fetch-authz.ts`, `src/fetch-agent-authz.ts`), the delegation ceiling for agent runs, and authorization snapshots.
  - Machine-key scope (`src/machine-key-scope.ts`): which capabilities each API-key purpose may invoke.
  - Handler-level checks: `assertOrgRole` (`src/org-role.ts`) and `assertConsequenceRole` / `assertApprover` (`src/mandate-role.ts`).
  - Kill-switch reads and guards, JIT access requests, and IAM audit emission.
- **Does not own:**
  - The pure policy resolver `resolve()` and the gate slot `setKernelIAMRuntime`: [`@oxagen/oxagen`](../oxagen/README.md) (`src/iam/resolve.ts`, `src/kernel.ts`).
  - The IAM tables (`principals`, `roles`, `role_grants`, `principal_role_assignments`): [`@oxagen/database`](../database/README.md) (`src/schema/iam.ts`).
  - Default role and permission seeding: `tools/scripts/seed-iam-defaults.ts` (`pnpm db:seed-iam`).
  - Organisation IAM provisioning at creation: `bootstrapOrgIAM` in [`@oxagen/handlers`](../handlers/README.md).
  - Session and API-key identity resolution: [`@oxagen/auth`](../auth/README.md).
- **Depends on:**
  - `@oxagen/oxagen`: the kernel setters, `resolve()`, and context types.
  - `@oxagen/database`: `withTenantDb` / `withSystemDb` and the IAM schema for authorization reads.
  - `@oxagen/billing`: `resolveOrgTierDetailed` and `canAccessACL`, to decide whether an organisation gets the fast path.
  - `@oxagen/run-evidence`: RFC 8785 digests for resource scopes and decision records.
  - `@oxagen/telemetry`: error capture.
- **Used by:** `apps/api`, `apps/app`, `apps/mcp`, `apps/app_deprecated`, `@oxagen/agent`, `@oxagen/handlers`, `@oxagen/plugins`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `bootstrapIAMRuntime()` calls `setKernelIAMRuntime(adapter, true)` | injection | `packages/iam/src/bootstrap.ts` | `apps/app/instrumentation.ts`, `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, and `packages/agent/src/runtime/approval-resume.ts` |
| `setKernelAccessRequestCreator(createAccessRequest)` | injection | `packages/iam/src/bootstrap.ts` | The same `bootstrapIAMRuntime()` call |
| `KernelIAMCheckFn` | adapter | `packages/iam/src/bootstrap.ts` | Implements the kernel's port from `packages/oxagen/src/kernel.ts` by flattening `checkIAM`'s result |
| `machineKeyDenial` | boundary | `packages/iam/src/machine-key-scope.ts` | Runs inside the adapter before `checkIAM`. `tools/scripts/check-machine-key-purpose-coverage.mjs` (part of `pnpm check:contracts`) fails when a key purpose has no branch |
| `assertOrgRole` | export | `packages/iam/src/org-role.ts` | Imported as `@oxagen/iam/org-role` by handlers in `packages/handlers` and `packages/agent` |
| `assertConsequenceRole`, `assertApprover` | export | `packages/iam/src/mandate-role.ts` | Mandate handlers in `packages/handlers` and `packages/agent/src/handlers/agent.approval.resolve.ts` |

## Entry points

- `.` (`src/index.ts`): `bootstrapIAMRuntime`, `checkIAM`, authorization reads, kill switches, access requests, and audit emission.
- `./*` (`src/*.ts`): any module by file name. The common ones are `./org-role`, `./mandate-role`, `./machine-key-scope`, `./kill-switch-guard`, and `./live-agent-run-authorization`.

## Rules

- IAM fails closed. When the IAM tables are missing (Postgres `42P01`), `fetchAuthz` returns a synthetic deny, never empty data, so a contract's `defaultEffect` cannot become an unnoticed allow.
- Non-enterprise organisations get an unconditional allow for human principals only. Agent runs resolve at every tier against the delegation ceiling (agent principal intersected with the invoking human, deny wins), per `docs/specs/agent-rbac/spec.md` §3.4 and §3.5.
- The fast path reads no roles, so a handler that must enforce an organisation role calls `assertOrgRole` itself.
- `assertOrgRole` throws `forbidden` with reason `no_principal` when `ctx.userId` is null. The MCP surface authenticates by API key and sets `userId` to null, so a handler that calls `assertOrgRole` cannot succeed over MCP.
- The machine-key check runs before `checkIAM`, because an API-key principal passes every role gate and the fast path would otherwise admit a narrow machine key to every capability.
- `bootstrapIAMRuntime()` is idempotent. A repeat call overwrites the kernel slot.

## Tests

```bash
pnpm --filter @oxagen/iam test:unit src/check-iam.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`.
