# create_org

**Domain:** org
**Mode:** sync
**Scope:** none (`scoped: false`: the caller has no org yet; the app reaches it with a pre-tenant context, the API with `requireOrg: false`)

## Intent

Complete the org bootstrap for a signed-in user in one call: the organization
with a globally-unique slug and an immutable namespace (chosen, or derived from the slug), the caller's owner
membership, the IAM bootstrap (system roles, owner principal, owner role
assignment, role grants) and the first workspace with everything a workspace
needs (owner membership, built-in agent, default MCP registry, default
environment). All of it commits in one transaction or not at all.

The slug becomes the first path segment in every URL (`/{org}/...`), so a
top-level route segment (`login`, `api`, `invite`, …) is refused by the input
schema (`RESERVED_ORG_SLUGS`, exported from the contract). The first
workspace's slug becomes the second segment (`/{org}/{ws}`), so an org-level
route segment (`billing`, `api-keys`, `audit`, …) is refused the same way
(`RESERVED_WORKSPACE_SLUGS`).

Nothing billing-shaped is written: no credit, subscription, contract-terms,
GAU-bucket, settlement or billing-settings row exists for a new org (ADR-055
§3.9 item 14). The billing settings row appears on the first write that needs
it.

## Input

| Field            | Type                              | Notes                                                                 |
| ---------------- | --------------------------------- | --------------------------------------------------------------------- |
| `name`           | `string` (1 – 120 chars)          | Human-readable organization name.                                     |
| `slug`           | `string` (2 – 40 chars)           | Lowercase letters, digits, hyphens; not a reserved route segment.     |
| `planSlug`       | `"free"`                          | Always `free`; privileged plans come only from the subscription lifecycle. |
| `type`           | `"business" \| "personal"`        | Defaults to `business`.                                               |
| `website`        | `string` (URL, ≤ 2048)            | Business only.                                                        |
| `industry`       | industry slug                     | Business only.                                                        |
| `employeeSize`   | employee-size slug                | Business only.                                                        |
| `namespace`      | `string` (2 – 6 chars)            | Optional. Lowercase letters and digits. The immutable prefix of every agent key; used verbatim, refused if taken. Derived from the slug when absent. |
| `workspace`      | `{ name, slug }`                  | The first workspace. Defaults to `{ name: "Default", slug: "default" }`; the slug follows the org slug rules and may not be an org-level route segment. |

The namespace is optional. Given, it is stored verbatim or refused as
`namespace_taken`. Absent, it is derived from the slug server-side and kept
unique across organizations.

## Output

| Field                | Type                | Notes                                   |
| -------------------- | ------------------- | --------------------------------------- |
| `publicId`           | `string`            | Prefixed with `org_`.                   |
| `name`               | `string`            | Echoes the stored name.                 |
| `slug`               | `string`            | Echoes the reserved slug.               |
| `type`               | `string`            | `business` or `personal`.               |
| `createdAt`          | `string` (ISO 8601) | Server-side creation timestamp.         |
| `workspace.publicId` | `string`            | Prefixed with `ws_`.                    |
| `workspace.slug`     | `string`            | The first workspace's slug; `/{slug}/{workspace.slug}` is the Fleet page. |

## Side effects

One `withSystemDb` transaction:

- `org.organizations` (name, slug, namespace, type, status `active`)
- `org.org_users` (caller as `owner`)
- `iam.roles`, `iam.principals`, `iam.principal_role_assignments`, `iam.role_grants` (`bootstrapOrgIAM`)
- `workspace.workspaces`, `workspace.workspace_users` (caller as `owner`), `agent.agents` + `agent.agent_versions` (the `qa-chat` agent), `mcp.mcp_registries` (default), `environments.environments` (default) — `bootstrapWorkspace`, the same code `create_workspace` runs

After commit: a `security.security_events` row `organization.created`.

No `billing.*` row.

## Errors

| message                                              | meaning                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `slug "<slug>" already in use`                       | Slug collides with an existing organization (pre-check or race). |
| `namespace "<ns>" already in use`                    | The chosen namespace belongs to another organization (`conflict: namespace_taken`). |
| `organization.create requires an authenticated user` | No user on the context.                                          |
| zod issue at `slug` / `workspace.slug`               | Slug fails the regex or is a reserved route segment.             |

## Tests

- `packages/oxagen/src/contracts/org.create.test.ts` — input rules including every reserved slug, the first-workspace default, `scoped: false`.
- `packages/handlers/src/org.create.test.ts` — guards and the transaction shape with fakes; the billing package is never loaded.
- `packages/handlers/src/org.create.pg.test.ts` — against Postgres (CI `test` job, `DATABASE_URL`): a user with no memberships gets the org, owner membership, IAM and first workspace in one call, and every `billing.*` table keyed by `org_id` has no row for the new org.
