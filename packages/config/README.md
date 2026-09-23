# @oxagen/config

`@oxagen/config` owns environment validation and the environment-variable registry, plus the shared constants and URL guard that several packages need without depending on each other.

## Boundary

- **Owns:** the Zod runtime schema for environment variables (`baseEnvSchema`) and its readers `loadEnv` and `requireEnv`; the registry `ENV_REGISTRY`, which records each variable's services, origin, and documentation and renders `.env.example`; the outbound URL guard `assertPublicHttpUrl`; and the shared domain constants (organisation types, industries, employee sizes, countries, US states, local ports, `platformVersion()`).
- **Does not own:** the store clients that read `DATABASE_URL`, `NEO4J_URI`, and `CLICKHOUSE_URL` ([`@oxagen/database`](../database/README.md), [`@oxagen/ontology`](../ontology/README.md), [`@oxagen/telemetry`](../telemetry/README.md)), secret storage ([`@oxagen/crypto`](../crypto/README.md) and [`@oxagen/plugins`](../plugins/README.md)), or the deploy-time environment catalog (`tools/env-manager`).
- **Depends on:** no `@oxagen/*` runtime dependencies.
- **Used by:** `apps/api`, `apps/mcp`, `apps/app_deprecated`, `@oxagen/agent`, `@oxagen/ai`, `@oxagen/auth`, `@oxagen/billing`, `@oxagen/database`, `@oxagen/handlers`, `@oxagen/inngest-functions`, `@oxagen/notifications`, `@oxagen/ontology`, `@oxagen/oxagen`, `@oxagen/storage`, `@oxagen/telemetry`, `tools/env-manager`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `requireEnv(keys)` | export | `packages/config/src/env.ts` | Each package reads only its own keys, for example `packages/database/src/client.ts` and `packages/ai/src/models.ts` |
| `loadEnv()` | export | `packages/config/src/env.ts` | Whole-environment check at service boot in `apps/api/src/bootstrap.ts` |
| `ENV_REGISTRY` and `renderEnvExample()` | registry | `packages/config/src/registry.ts` | `tools/scripts/env-check.ts` (`pnpm env:check`) and `tools/env-manager/src/catalog.ts` |
| `assertPublicHttpUrl`, `fetchWithoutRedirects` | boundary | `packages/config/src/public-url.ts` | Customer-supplied URLs in `packages/ai/src/credential-probe.ts`, `packages/ai/src/models.ts`, and `packages/handlers` |

## Entry points

- `.` (`src/index.ts`): env readers, the registry, domain and geography constants, `PORTS`, and `platformVersion()`.
- `./env` (`src/env.ts`): `baseEnvSchema`, `loadEnv`, `requireEnv`, `normalizeEnv`, and `isProductionRuntime` without the rest of the barrel.
- `./public-url` (`src/public-url.ts`): the outbound URL guard.

## Rules

- A package calls `requireEnv([...its keys])`, not `loadEnv()`, so importing one package never demands every variable in the monorepo.
- Read `DATABASE_URL`, `NEO4J_URI`, and `CLICKHOUSE_URL` only inside their store clients (`CLAUDE.md`, Runtime checks).
- Every key in `baseEnvSchema` has an `ENV_REGISTRY` entry. `registry.test.ts` asserts it.
- A workflow variable a Turbo task reads must also appear in that task's `env[]` in `turbo.json`.
- `assertPublicHttpUrl` rejects private, loopback, link-local, and metadata addresses in the URL as typed. It does not re-check after DNS resolves, so it does not close a DNS-rebinding window.
- ADR-004 keeps configuration in environment variables rather than a secret manager.

## Tests

```bash
pnpm --filter @oxagen/config test:unit src/env.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`.
