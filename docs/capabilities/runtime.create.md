# create_runtime

**Capability:** `create_runtime`
**Domain:** runtime
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Name a runtime in the workspace (ADR-198, #4369): a laptop, a VM, or a cloud workspace agents run on. A runtime holds a name and a slug and no machine facts. A host enrollment binds a machine to it later, and the runtime keeps its id when that machine is replaced, so the agents on it keep theirs.

The Runtimes page's Add a runtime dialog calls this, then goes straight to registering the runtime's first agent (`register_agent`).

## Input

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | 1 to 128 characters. |
| `slug` | `string?` | 1 to 40 characters, lowercase letters and digits joined by single hyphens. Derived from `name` when absent: spaces become hyphens and every other special character, apostrophes included, is dropped, so "Mac's Laptop" becomes `macs-laptop`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `runtime.id` | `string` | `rtm_…`. |
| `runtime.name` | `string` | |
| `runtime.slug` | `string` | |

## Roles

Org Owner or Admin, checked by the handler (`assertOrgRole` over the contract's roles, INV-29) for the signed-in user or, on an API-key call, the key's creator.

## Side effects

- Postgres: one `agent.runtimes` row.
- No domain security event: naming a runtime grants nothing. The kernel's `capability.invoke_*` audit records the call.

## Surfaces

- `POST /api/v1/{org}/{ws}/runtimes/create`
- MCP tool `create_runtime`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or the acting user is not an org Owner or Admin (`org_role_required`). |
| `conflict` | Another live runtime in the workspace holds the slug (`runtime_slug_taken`), or the name has no letter or digit to derive a slug from (`runtime_slug_empty`). |
