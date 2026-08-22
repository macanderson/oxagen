# router.policy.set

**Capability name:** `set_routing_policy`
**Domain:** router
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** high

## Intent

Set the Verified-Outcome Market Router policy at the **org** or **workspace**
scope (partial update — only provided fields change). This changes how the
platform spends on models, so it is **high sensitivity** and gated to org
Owner/Admin (and workspace Owner/Admin for the workspace scope). Turning the
market on can raise or lower spend.

## Input

| Field                 | Type                                | Notes                                                             |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `scope`               | `"org" \| "workspace"` (optional)   | Which row to write; omit ⇒ `workspace`. `org` sets the org default |
| `mode`                | `"off" \| "shadow" \| "enforce"`    | Optional — omit to leave unchanged                                |
| `successThreshold`    | `number` (0..1)                     | Optional verified-success threshold                               |
| `minSamples`          | `integer` (≥0)                      | Optional min samples                                              |
| `windowDays`          | `integer` (>0)                      | Optional trailing window                                          |
| `escalateOnRejection` | `boolean`                           | Optional tier-escalation toggle                                   |

## Output

The stored policy after the merge: `{ scope, mode, successThreshold, minSamples, windowDays, escalateOnRejection }`.

## Side effects

Upserts a row in `workspace.routing_policy` (org-level row has `workspace_id = NULL`).
Takes effect on the next agent turn that routes through `runTurn`.
