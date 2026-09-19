# Retired ADR-025 re-land runbook

Do not execute the old production grant-remapping procedure. The July 2026 capability pruning invalidated its name set and SQL assumptions. The former instructions have been removed rather than retained as a runnable migration plan.

[ADR-025](../adr/ADR-025-verb-first-snake-naming.md) records the naming decision. The [executed name ledger](adr025-naming-mapping.md) preserves the historical mapping. Neither is a current production migration procedure.

The script `tools/scripts/adr025-reland-custom-role-grant-remap.sql` still points here. It is historical migration material, not an approved operation. Any new grant migration needs a fresh comparison against the live contracts, role schema, and target database, followed by a reviewed migration.
