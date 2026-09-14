# organization.create

**Domain:** organization
**Mode:** sync
**Scope:** none (operates above org scope; the caller creates the org they will then belong to)

## Intent

Create a new organization with a globally-unique slug and attach the
calling user as the first member. The slug becomes the first path segment
in every URL (`/:org_slug/...`), so it is validated and reserved
atomically. Plan selection defaults to `free` but accepts any seeded
plan slug.

## Input

| Field      | Type                     | Notes                                       |
| ---------- | ------------------------ | ------------------------------------------- |
| `name`     | `string` (1 – 120 chars) | Human-readable organization name.           |
| `slug`     | `string` (2 – 40 chars)  | Lowercase letters, digits, hyphens.         |
| `planSlug` | `string`                 | Plan catalogue slug. Defaults to `free`.    |

## Output

| Field       | Type                | Notes                              |
| ----------- | ------------------- | ---------------------------------- |
| `publicId`  | `string`            | Prefixed with `org_` per §4.3.     |
| `name`      | `string`            | Echoes the stored name.            |
| `slug`      | `string`            | Echoes the reserved slug.          |
| `createdAt` | `string` (ISO 8601) | Server-side creation timestamp.    |

## Side effects

- Postgres: insert `org.organizations`, insert `org.org_users` (caller as owner), insert `billing.subscriptions` (free plan), insert `billing.credit_balances`.
- ClickHouse: emit an `organization.created` row in `events`.
- Neo4j: upsert `(:Org { public_id })` and `(:User)-[:OWNS]->(:Org)`.

## Errors

| code             | meaning                                          |
| ---------------- | ------------------------------------------------ |
| `slug_taken`     | Slug collides with an existing organization.     |
| `invalid_slug`   | Slug fails the regex validator.                  |
| `plan_not_found` | `planSlug` does not match a seeded plan.         |

## SPEC references

- §4.1 — identifier strategy
- §4.3 — public ID prefixes
- §4.4 — slug uniqueness
- §6.1 — `org` schema
- §6.13 — `billing` schema
