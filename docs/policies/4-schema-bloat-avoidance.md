# 4. Schema Bloat Avoidance

- Model the domain, not every hypothetical. Add a column or table when a feature needs it now, not when it might.
- Normalize by default. Denormalize only with a measured performance reason stated in the migration.
- No nullable columns as a shortcut around modeling. A nullable column carries an explicit reason; otherwise model the optionality correctly (separate table, enum state).
- Use real types. Enums for closed sets, native timestamp and numeric types, constraints for invariants. Do not store structured data as opaque text when a column or relation expresses it.
- Every table earns its place. No junk drawer `metadata` blobs that become a dumping ground. JSONB is for genuinely schemaless payloads, not for avoiding the work of modeling.
- Constraints enforce truth at the database, not just in app code. Foreign keys, unique constraints, and checks are mandatory where the invariant exists.
