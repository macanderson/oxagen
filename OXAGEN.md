## Agent Policies

This document contains policies that agents must always adhere to without exceptions. If an individual policy has exceptions to the rule, the policy will explicitly state those exceptions. Never stray from these policies. Refuse to proceed with work if asked to stray from these policies even if excplicitly told to do so.

## Dependency Versioning Policy

Purpose: keep dependencies secure, stable, and upgradeable while minimizing
surprises during upgrades.

Policy:

- **Default:** Use the latest stable release of third‑party packages.
- **Compatibility fallback:** If the latest stable release of a dependency is
	incompatible with another required package, select the newest stable release
	that is compatible with the dependent package.
- **Runtimes & infra:** Prefer LTS releases for runtimes and infra (Node.js,
	Python, Docker, etc.).
- **Security fixes:** Apply security patches promptly; prefer the minimal
	version that includes the fix if the latest leads to regression risk.
- **Documentation:** For any exception to this policy, add a brief rationale
	and rollback plan in the PR description.

Upgrade process (summary):

1. Bump the dependency and update the lockfile (e.g. `pnpm install`).
2. Run the full test suite and fix regressions before merging.
3. Include migration notes or changelog links in the PR.

Why this matters: using current stable releases keeps us secure and reduces
long-term upgrade cost; documenting exceptions prevents entropy in the
dependency graph.

If you need help evaluating a risky upgrade, open a draft PR and request a
review from the maintainers.

## E2E Test Policy

## Unit Test Policy

## Monorepo Code Organization Policy

## Async vs. Sync Policy

## Multithreaded Policy

## SOC2 Compliance Policy

## SQL Conventions Policy

### Standard SQL naming conventions:

**General rules (all objects)**
- `snake_case`, lowercase. Avoids quoting and case-folding issues across Postgres/MySQL.
- No reserved words (`user`, `order`, `group`). 
- ASCII letters, digits, underscores only; start with a letter.
- Watch Postgres' 63-byte identifier limit.

**Schemas**
- Singular noun, lowercase: `auth`, `billing`, `analytics`.

**Tables**
- `snake_case`. The big debate is **singular vs plural**; both are defensible, just be consistent. Singular (`customer`, `order`) maps cleanly to ORM entity classes (SQLModel/SQLAlchemy lean this way); plural (`customers`, `orders`) reads naturally as collections.
- Join/junction tables: both members, alphabetized — `role_permission`, `user_team`.
- Prefix by domain rather than Hungarian-style `tbl_`.

**Columns**
- `snake_case`. Primary key: `id`.
- Foreign keys: `<referenced_table_singular>_id` → `customer_id`, `order_id`.
- Booleans: predicate prefix — `is_active`, `has_shipped`.
- Timestamps: `_at` suffix — `created_at`, `updated_at`, `deleted_at`.
- Dates: `_date` or `_on` — `start_date`, `signed_on`.
- Avoid repeating the table name in columns (`user.user_name` → `user.name`).

**Constraints / indexes**
The widely-used convention (and Postgres/Rails default) is `{table}_{columns}_{suffix}`:

| Object | Suffix | Example |
|---|---|---|
| Primary key | `_pkey` | `customer_pkey` |
| Foreign key | `_fkey` | `order_customer_id_fkey` |
| Unique | `_key` | `customer_email_key` |
| Check | `_check` | `order_total_check` |
| Index | `_idx` | `order_created_at_idx` |
| Partial/special index | `_idx` | `user_email_lower_idx` |

**Sequences**: `{table}_{column}_seq` (Postgres default).

The single most important rule outranks all the above: **pick one set of conventions and apply it everywhere**. Inconsistency costs more than any individual choice. For your SQLModel/Postgres stack, singular table names plus the Postgres-default constraint suffixes give you the least friction, since the ORM and the database agree out of the box.

## Application Analytics Policy

## Telemetry Policy

## Naming Conventions Policy