---
schema: steering-record/v1
lineage: a-intel.platform.write-migration
label: Write a database migration
kind: skill
name: write-migration
description: Write and check an Atlas migration for a schema change in packages/database.
force: may
scope: repository
repos:
  - github.com/a-intel/platform
load: relevant
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5W9CD
id: rec_a_intel_platform_write_migration_b0e5e977b582
hash: sha256:77f1dfe68c9257c6cb44642c7b0b80a5ae127662807818d600f7e4353017ef96
---

# Write a database migration

1. Change the schema in `packages/database/src/schema/`.
2. Run `pnpm db:diff <name>` to generate the migration.
3. Start from @template.sql for the row-level security block.
4. Add the `schema` label to the pull request. Migrations apply on merge.
