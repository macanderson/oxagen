# context.steering.index.get

Returns the workspace's published record index and what Oxagen knows outside the steering repo, so `oxagen check` can run the steering PR checks on a clone before you push.

Two of the checks read more than the tree. The hash and conflicts checks compare your change with the records the workspace has published. The references check resolves each runtime, operator, reviewer group, and credential your repo names against what Oxagen holds. This read returns both in one answer.

`index` is null until the workspace publishes its first version. Each record carries the fields the checks read. No record carries a statement, because `bundle/v1` keeps a record's body in the repository.

`context` holds five sorted lists of names:

- `runtimes`: the slug of each runtime enrolled in the workspace.
- `credentials`: the name of each credential in the workspace's vault, the `<name>` of `oxagen:credential/<name>`. A revoked credential is left out.
- `members`, `teams`, `groups`: always empty for now. Oxagen stores no member handle, no team, and no reviewer group slug yet. Until it does, the references check reports each agent's `operator` and each reviewer group as missing.

**Surfaces:** api, cli

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/context/steering/index` → 200
- CLI: `oxagen check`
- Authentication: session or API key; org Owner or Admin, or a workspace Owner, Admin, or Member
- Capability name: `get_steering_index`
- Not billed (`noBillingGate: true`); IAM default-deny; low sensitivity

## Input

None. Send no body.

## Output

| Field | Type | Description |
|---|---|---|
| `index` | object or null | the published version's records; null before the first publish |
| `index.records` | array | `{ lineage, path, id, hash, kind, effect }` for each record; `effect` is `require` or `forbid` for a constraint and null otherwise |
| `context.runtimes` | string[] | runtime slugs enrolled in the workspace |
| `context.members` | string[] | member handles; empty for now |
| `context.teams` | string[] | team slugs; empty for now |
| `context.groups` | string[] | reviewer group slugs; empty for now |
| `context.credentials` | string[] | credential names in the workspace's vault, revoked ones left out |

## Refusals

None beyond the kernel's. A caller outside the workspace gets 403 from the route before the capability runs.
