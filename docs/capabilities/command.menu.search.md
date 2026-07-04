# command.menu.search

**Domain:** command
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Risk level:** low

## Intent

Full-text entity search for the Command Menu. Accepts an optional entity-kind filter and a query string, and returns up to 8 typed rows (label, scope, contextLine, href) composed from the ontology graph and operational Postgres tables, filtered to the caller's tenant grants. Each row carries a ready-to-navigate href so the client can push the route on selection without an additional data fetch.

## Input

| Field | Type | Notes |
|---|---|---|
| `kind` | `SearchableKind?` | Restrict results to a single entity kind: run, principal, playbook, trigger, event, agent (optional). |
| `query` | `string` | Free-text search string (0–500 chars). |
| `orgSlug` | `string` | Organization slug for href construction. |
| `workspaceSlug` | `string` | Workspace slug for href construction. |

## Output

| Field | Type | Notes |
|---|---|---|
| `rows` | `SearchResultRow[]` | Up to 8 typed result rows. |
| `rows[].kind` | `SearchableKind` | Entity kind. |
| `rows[].id` | `string` | Stable internal id (publicId or db id). |
| `rows[].label` | `string` | Human-readable display name. |
| `rows[].scope` | `string` | Scope hint shown beneath the label (e.g. 'Workspace: Production'). |
| `rows[].contextLine` | `string \| null` | Brief additional context (status, last-run, etc.). |
| `rows[].href` | `string` | Route the menu pushes when this item is selected. |

## Roles

Org Owner, Org Admin, Org Member, Workspace Owner, Workspace Member, Workspace Viewer.

## Side effects

None (read-only). Reads from the Neo4j ontology graph and operational Postgres tables, filtered to the caller's grants.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. query over 500 chars, unknown kind). |
| `unauthorized` | Caller lacks the required org/workspace role. |
