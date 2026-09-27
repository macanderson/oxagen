# update_runtime

**Capability:** `update_runtime`
**Domain:** runtime
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Rename a runtime, or change whether every agent on it must run under the contained launcher (ADR-204, #4372). A field left out keeps its value, so a call that names neither changes nothing and answers the runtime as it stands.

The host bundle reads `containmentRequired` from the runtime the host enrollment binds, and from the agent's current runtime when the host binds none. Each host bound to the runtime carries the change on its next bundle fetch. The contained launcher and the tier it earns are ADR-152.

A named runtime's page calls this from its Containment switch.

## Input

| Field | Type | Notes |
|---|---|---|
| `runtimeId` | `string` | `rtm_…`, a live runtime in the workspace. |
| `name` | `string?` | 1 to 128 characters after trimming. The slug stays, because enrollments and records name the runtime by it. |
| `containmentRequired` | `boolean?` | Whether every agent on the runtime must run under the contained launcher. |

## Output

| Field | Type | Notes |
|---|---|---|
| `runtime.id` | `string` | `rtm_…`. |
| `runtime.name` | `string` | The name after the call. |
| `runtime.slug` | `string` | |
| `containmentRequired` | `boolean` | The setting after the call. |

## Roles

Org Owner or Admin, checked by the handler (`assertOrgRole` over the contract's roles, INV-29) for the signed-in user or, on an API-key call, the key's creator. Agent callers need approval (`requiresApproval: true`).

## Side effects

- Postgres: the `agent.runtimes` row's `name`, `containment_required`, `updated_at` and `updated_by_id`, written under a row lock. A call that changes nothing writes nothing.
- A change to `containmentRequired` writes a `capability.invoke_allowed` security event in the same transaction, with `feature: "runtime_containment"` and the value before and after. A rename alone writes none. The kernel's `capability.invoke_*` audit records every call.

## Surfaces

- `POST /api/v1/{org}/{ws}/runtimes/update`
- MCP tool `update_runtime`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or the acting user is not an org Owner or Admin (`org_role_required`). |
| `not_found` | No live runtime with that id in the workspace (`runtime_not_found`). |
