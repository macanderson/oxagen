---
schema: steering-record/v1
lineage: a-intel.platform.migration-names
label: Name a migration for its table
description: A migration's name says which table it changes.
kind: code-rule
force: should
scope: repository
repos:
  - github.com/a-intel/platform
skills:
  - a-intel.platform.write-migration
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5W9DE
id: rec_a_intel_platform_migration_names_cb6943d5cacf
hash: sha256:405b369c0ae0f9a4fb57f40047b775aaeb4fc4a709cc753ea82e183e6ba3c12c
---

Name each migration for the table it changes and what it does to it, such as
`runs_add_origin_message`. One migration changes one table.
