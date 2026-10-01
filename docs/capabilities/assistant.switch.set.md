# set_assistant_switch

**Capability:** `set_assistant_switch`
**Domain:** assistant
**Mode:** sync
**Scope:** none (`scoped: false`). The input names the organization and the workspace, and the handler enters that workspace's tenant scope.
**Surfaces:** none
**Mutates:** yes
**Platform-operator only:** yes (`platformOnly: true`)
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

Oxagen's own switch on its in-app assistant, for one workspace. Turn it on to stop the assistant there. Turn it off to let it answer again.

Customers never configure governance against the assistant (maintainer ruling, 2026-10-01), so `set_kill_switch` refuses the workspace's managed `qa-chat` agent as a target. This capability is the one switch that still reaches it, and only a person at Oxagen can flip it.

## How it stops the assistant

On writes an `agent` kill switch in `iam.emergency_denies`, the same row shape `set_kill_switch` writes for an agent:

| Column | Value |
|---|---|
| `org_id`, `workspace_id` | the input's `orgId` and `workspaceId` |
| `scope_kind` | `workspace` |
| `deny_kind` | `resource_scope` |
| `resource_scope_digest` | `resourceScopeDigestOf({ kind: "agent", id: <qa-chat public id> })` |
| `target_kind`, `target_id` | `agent`, the `qa-chat` agent's `agt_…` id |
| `reason` | the input's `reason` |
| `flipped_by_user_id`, `created_by_id` | null, because a platform operator acts with no user |

`readAssistantAgentState` (`packages/agent/src/runtime/assistant-run.ts`) matches that digest, so the next turn in the workspace is refused with `AssistantStoppedError` before it writes anything. The table's trigger bumps the deny generation in the same transaction.

Off deactivates the row, keeps it, and stores the input's `reason` as `cleared_reason`. `updated_by_id` is null.

The handler finds the agent by slug `qa-chat` and type `interactive_chat`, not deleted. The slug is what `readAssistantAgentState` reads, so the switch lands on the row the turn checks. The type keeps a customer's own agent out of reach.

## Reachability

| Declaration | What it does |
|---|---|
| `platformOnly: true` | The kernel refuses the invocation, before the IAM check, unless the `CapabilityContext` carries a platform-operator binding minted in `packages/oxagen/src/platform-operator.ts`. This is the boundary (INV-31). |
| `surfaces: []` | No API route, no MCP tool, no CLI command, no app binding. `layers` lists `schema`, `unit` and `docs`. |
| `defaultEffect: "deny"`, `defaultRoles: {}` | No role in any organization grants it. |

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `orgId` | string | yes | uuid of the organization |
| `workspaceId` | string | yes | uuid of the workspace whose assistant to stop or restart |
| `on` | boolean | yes | `true` stops the assistant. `false` lets it answer again. |
| `reason` | string | yes | 1 to 500 characters after trimming, stored on the row |

An unknown key is refused.

## Output

| Field | Type | Meaning |
|---|---|---|
| `switchId` | string or null | `emd_…` of the row this call wrote, cleared, or found already on. Null when off found no switch on. |
| `changed` | boolean | false when the switch was already in the requested state |

Turning it on when it is already on, or off when none is on, writes nothing and is not an error. You can re-run the script safely.

## Side effects

One transaction inside the workspace's tenant scope: the agent lookup and the row write. When `changed` is true, the handler awaits a `tool.kill_switch_flipped` security event naming the organization, the workspace, this capability, and the operator run's request id, with `actorUserId` null. The kernel's `capability.invoke_allowed` or `invoke_denied` row is written by the emitter the operator script registers before it invokes. The script awaits both rows before it closes the pool and exits.

## The one caller

```
pnpm assistant:switch --org <slug> --workspace <slug> --on --reason "<text>"
pnpm assistant:switch --org <slug> --workspace <slug> --off --reason "<text>"
```

`tools/scripts/assistant-switch.ts` echoes the target database, resolves the organization and the workspace by slug, loads `@oxagen/handlers/register`, and invokes the capability through `tools/scripts/lib/platform-operator-run.ts` with `surface: "runner"` on the context and no `opts.surface`. Run it with the production `DATABASE_URL`, the way `pnpm billing:terms` runs.

## Errors

| code | meaning |
|---|---|
| `authz_denied` (`CapabilityError`) | the context carries no platform-operator binding, or carries a value the kernel did not mint |
| `invalid_input` | `orgId` or `workspaceId` is not a uuid, `on` is missing, `reason` is empty or longer than 500 characters, or an unknown key is present |
| `not_found` (`assistant_agent_not_found`) | the workspace has no managed assistant agent, or the workspace is not in the organization |
