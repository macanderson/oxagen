# add_group_machine

**Capability:** `add_group_machine`
**Domain:** tacho
**Mode:** sync
**Scope:** workspace (`scoped: true`; the group belongs to the caller's workspace)
**Surfaces:** none
**Mutates:** yes
**Roles:** org Owner or Admin
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

Put an enrolled machine in a machine group. A local server, or a registry package with `source.machines`, runs only on a machine in a group the server names (mcp-studio-spec, Local servers, Machines). The cloud gateway reads a machine's groups before it signs a local call envelope, so this capability decides which machines can run which local servers.

A group is not a record of its own. It exists while at least one machine is in it, so adding the first machine creates the group.

## Reachability

The contract declares no surface. `layers` lists `schema`, `unit` and `docs`, which is everything that exists. The handler is registered in `packages/handlers/src/register.ts` and lives in `packages/handlers/src/mcp-studio/local-calls/machine-group.add.ts`. A surface for it arrives with the Machines screen.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `group` | string | yes | `^[a-z0-9][a-z0-9-]{0,62}$`, the pattern `source.machines` accepts |
| `machineId` | string | yes | the machine's enrollment id, `tch_` and 22 characters |

The workspace is the caller's scope, so the input names none.

## Output

| Field | Type | Description |
|---|---|---|
| `group` | string | the group named in the input |
| `machineId` | string | the machine named in the input |
| `addedAt` | string | ISO time the machine joined the group |
| `added` | boolean | false when the machine was already in the group |

Adding a machine that is already in the group changes nothing. The call answers `added: false` and the time of the first add.

## Side effects

One row in `tacho.machine_group_members`, written through `withTenantDb`. The row records the acting user as `created_by_id`. When the call comes from an API key, the acting user is the key's creator.

Each call that passes the role check writes one `tacho.machine_group_changed` security event in the same transaction. Its detail is `{ change: "added", group, machineId, changed }`, and `changed` is false for a repeated add. A refused call writes no event.

## Errors

| code | reason | meaning |
|---|---|---|
| `forbidden` | `org_role_required` | the caller is not an org Owner or Admin |
| `forbidden` | `no_principal` | the call carries no user, or its API key is deleted or has no recorded creator |
| `not_found` | `machine_not_found` | no machine with that id is enrolled in this workspace. Enroll the machine, then add it. |
| `conflict` | `machine_revoked` | the machine's enrollment is revoked. Enroll it again, then add it. |
| `invalid_input` | | the group name or machine id does not match its pattern, or an unknown key is present |
