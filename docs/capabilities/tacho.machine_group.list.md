# list_machine_groups

**Capability:** `list_machine_groups`
**Domain:** tacho
**Mode:** sync
**Scope:** workspace (`scoped: true`; the caller's workspace)
**Surfaces:** none
**Mutates:** no
**Roles:** org Owner or Admin; workspace Owner, Member or Viewer
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

List the workspace's machine groups and the machines in each (mcp-studio-spec, Local servers, Machines). A group appears while at least one machine is in it.

A revoked machine stays listed with status `revoked`, because its membership row stays until someone removes it. The cloud gateway never sends a revoked machine a call.

## Reachability

The contract declares no surface. `layers` lists `schema`, `unit` and `docs`, which is everything that exists. The handler is registered in `packages/handlers/src/register.ts` and lives in `packages/handlers/src/mcp-studio/local-calls/machine-group.list.ts`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `group` | string | no | `^[a-z0-9][a-z0-9-]{0,62}$`; reads only that group |

## Output

| Field | Type | Description |
|---|---|---|
| `groups` | object[] | one entry per group, sorted by name |
| `groups[].group` | string | the group name |
| `groups[].machines` | object[] | the group's machines, sorted by enrollment id |
| `groups[].machines[].machineId` | string | enrollment id |
| `groups[].machines[].hostname` | string | the hostname the machine reported at enrollment |
| `groups[].machines[].status` | enum | `active`, `paused`, `suspended` or `revoked` |
| `groups[].machines[].addedAt` | string | ISO time the machine joined the group |

## Side effects

None. One read of `tacho.machine_group_members` joined to `tacho.hosts`, through `withTenantDb`.

## Errors

| code | reason | meaning |
|---|---|---|
| `forbidden` | `org_role_required` | the caller holds none of the roles above |
| `forbidden` | `no_principal` | the call carries no user, or its API key is deleted or has no recorded creator |
| `invalid_input` | | the group name does not match its pattern, or an unknown key is present |
