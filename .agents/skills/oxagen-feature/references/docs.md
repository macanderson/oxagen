# User docs + SPEC

Every feature ships a SPEC and updates user-facing docs. Write intent first, then mechanics. Active voice, present tense, Oxford commas.

## SPEC.md (per feature)

```markdown
# <Capability> SPEC

## Intent
One paragraph on what this capability does and why it exists, from the user's point of view.

## Capability
- Name: `<capability.name>`
- Mode: sync | async | batch
- Scope: tenant, workspace

## API
`POST /v1/<capability>` — request shape, response shape, status codes. Link the shared schema.

## MCP tool
`<capability.name>` — same input/output as the API. Note any session-scope behavior.

## Data
Tables touched, migration name, and (if applicable) the Neo4j projection and its sync point.

## Async/batch
Job lifecycle, status route, polling contract. Omit if sync.
```

## User docs

Update the user-facing docs site and the package README so a user can discover and call the capability without reading source. Show a request example and the response. If the capability is exposed over MCP, document the tool name and a sample agent invocation.

## Rules

- SPEC.md lives beside the feature and is updated, not duplicated, on later changes.
- Docs describe the contract, not the implementation. A user should never need to read the route handler.
- Keep examples runnable and current with the shared schema.
