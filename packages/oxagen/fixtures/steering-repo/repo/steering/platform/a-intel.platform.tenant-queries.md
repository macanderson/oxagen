---
schema: steering-record/v1
lineage: a-intel.platform.tenant-queries
label: Tenant queries use withTenantDb
description: Every tenant table query goes through withTenantDb.
kind: code-rule
force: must
scope: repository
repos:
  - github.com/a-intel/platform
applies_to:
  - "packages/handlers/**/*.ts"
  - "packages/database/src/**"
load: match
status: active
origin: inferred
provenance:
  source: run
  uri: frame:run_01K5R8QZ/412
id: rec_a_intel_platform_tenant_queries_3ddd68163052
hash: sha256:79d6c8139f4ad5cec29df5f0684d0bca92eef3beecbcd93793d9b2b56273c030
---

Every query that reads or writes a tenant table goes through
`withTenantDb(ctx, fn)`. Never call `db()` directly in a handler.

```ts
await withTenantDb(ctx, (tx) => tx.select().from(runs).where(eq(runs.id, id)));
```
