# reference.search

**Domain:** reference
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Typed autocomplete search behind the chat composer's `@`-mention picker
(and any surface that needs to reference a platform object by stable
public id). Scoped to the caller's tenant, it searches across every
referenceable kind — connected repositories and their default branches,
code-graph files/directories, agent definitions, skills, agent tools,
MCP servers, capabilities, and knowledge-graph nodes/edges — and returns
rows carrying the fields a mention token needs.

Two modes: **query** mode does free-text substring search (optionally
restricted to `types`); **resolve** mode (`slug` set) does an exact
public-id lookup, used to re-hydrate a previously inserted mention chip.

## Input

| Field    | Type               | Notes                                                                 |
| -------- | ------------------ | --------------------------------------------------------------------- |
| `query`  | `string`           | Free-text search string (0–500 chars, default `""`).                  |
| `types`  | `ReferenceType[]?` | Restrict results to these kinds; omit to search all kinds.            |
| `slug`   | `string?`          | Exact public-id resolve mode — ignores `query` when set.              |
| `limit`  | `number`           | Maximum rows to return (1–25, default 10).                            |

`ReferenceType` is one of `repository`, `branch`, `file`, `directory`,
`agent`, `skill`, `tool`, `mcp_server`, `capability`, `node`, `edge`.

## Output

| Field     | Type                                                                           | Notes                          |
| --------- | ------------------------------------------------------------------------------ | ------------------------------ |
| `results` | `Array<{ type, slug, location, label, description, properties }>`               | Up to 25 typed reference rows. |

Each row's `slug` is the stable identifier the mention token carries
(connection publicId, capability name, path, node publicId, …), `label`
is what a chip renders, and `properties` is the bag revealed when a
mention chip is inspected.

## Side effects

None — read-only. Every source arm is best-effort: a failing store
degrades to zero rows for its types rather than failing the whole
search. Postgres arms filter `orgId` + `workspaceId` via `withTenantDb`
(RLS-enforced); graph reads run inside `runInTenantScope` with
org/workspace predicates in every Cypher.

## Errors

None expected beyond auth / scope failures handled by middleware.

## SPEC references

- `@oxagen/ai` `mentions` — the `@`-mention reference grammar these rows tokenize into
- Capability parity — contract → API route → MCP tool → agent surface
