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
  memories:
    - agent: a-intel.core.ci-reviewer
      run: run_01K5R8QZ
      statement: A handler query that called db() directly skipped the tenant filter. Route every tenant table query through withTenantDb.
      evidence:
        - frame:run_01K5R8QZ/412
id: rec_a_intel_platform_tenant_queries_c6f214d8974e
hash: sha256:059c1e341ca21c13fe046257f0e6adda01d31ff7924235680b81fa07d53224d2
---

Every query that reads or writes a tenant table goes through
`withTenantDb(ctx, fn)`. Never call `db()` directly in a handler.

```ts
await withTenantDb(ctx, (tx) => tx.select().from(runs).where(eq(runs.id, id)));
```
