# kill_switch.list

**Capability:** `list_kill_switches`
**Domain:** kill_switch
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The Tools page's kill switches (MC spec §6.11): every switch reaching this workspace — the org-wide class, operator, workspace and organisation switches and the workspace's own — newest first, on and off, with who flipped and who cleared each, and the current deny generation for the header's "deny generation N" line.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `onlyOn` | boolean | no | default false |
| `limit` | integer | no | 1-200, default 100 |

## Output

| Field | Type | Description |
|---|---|---|
| `denyGeneration` | object | `{ org, workspace }` |
| `switches` | object[] | `{ id (emd_…), target: { kind, id }, scope: org \| workspace, on, reason, flippedBy, flippedAt, clearedAt, clearedBy }` |

## Roles

Org Owner, Admin or Compliance, or workspace Owner or Member (`assertOrgRole`, INV-29).

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /v1/{org}/{ws}/kill-switches/list`
- MCP tool `list_kill_switches` (an API key acts as its creator at the role gate, ADR-068 decision 8)

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
