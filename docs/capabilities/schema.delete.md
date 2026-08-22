# schema.delete

**Domain:** schema
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** high

## Intent

Drop an entire named schema from the draft — its labels, relationship types, and properties. Invoked by the schema chat agent against draft-state grounding; not exposed as an API route or MCP tool.

## Input

| Field | Type | Notes |
|---|---|---|
| `schemaName` | `string` | Name of the schema to drop (min 1 char). |

## Output

| Field | Type | Notes |
|---|---|---|
| `deleted` | `boolean` | True if the schema was dropped. |
| `schemaName` | `string` | The name of the schema that was dropped. |
| `labelsRemoved` | `number` | Count of labels removed from the draft. |
| `relationshipTypesRemoved` | `number` | Count of relationship types removed from the draft. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Mutates the draft schema state: removes the named schema's labels, relationship types, and properties.

## Errors

| code | meaning |
|---|---|
| `validation_error` | `schemaName` was empty. |
| `not_found` | No schema by that name exists in the draft. |
| `unauthorized` | Caller lacks the required org/workspace role. |
