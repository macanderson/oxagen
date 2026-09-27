# remove_group_machine

**Capability:** `remove_group_machine`
**Domain:** tacho
**Mode:** sync
**Scope:** workspace (`scoped: true`; the group belongs to the caller's workspace)
**Surfaces:** none
**Mutates:** yes
**Roles:** org Owner or Admin
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

Take a machine out of a machine group, so it no longer runs the local servers that name the group (mcp-studio-spec, Local servers, Machines). Removing the last machine removes the group, because a group exists only while a machine is in it.

A revoked machine keeps its memberships. The cloud gateway skips a revoked machine, and this capability removes its rows like any other.

## Reachability

The contract declares no surface. `layers` lists `schema`, `unit` and `docs`, which is everything that exists. The handler is registered in `packages/handlers/src/register.ts` and lives in `packages/handlers/src/mcp-studio/local-calls/machine-group.remove.ts`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `group` | string | yes | `^[a-z0-9][a-z0-9-]{0,62}$` |
| `machineId` | string | yes | the machine's enrollment id, `tch_` and 22 characters |

## Output

| Field | Type | Description |
|---|---|---|
| `group` | string | the group named in the input |
| `machineId` | string | the machine named in the input |
| `removed` | boolean | false when the machine was not in the group |

Removing a membership that does not exist changes nothing and answers `removed: false`. An unknown machine id answers the same way.

## Side effects

Deletes at most one row in `tacho.machine_group_members`, through `withTenantDb`. Each call that passes the role check writes one `tacho.machine_group_changed` security event in the same transaction. Its detail is `{ change: "removed", group, machineId, changed }`, and `changed` is false when nothing was removed.

## Errors

| code | reason | meaning |
|---|---|---|
| `forbidden` | `org_role_required` | the caller is not an org Owner or Admin |
| `forbidden` | `no_principal` | the call carries no user, or its API key is deleted or has no recorded creator |
| `invalid_input` | | the group name or machine id does not match its pattern, or an unknown key is present |
