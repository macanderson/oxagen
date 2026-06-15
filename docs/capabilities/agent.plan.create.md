# agent.plan.create

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Create a structured hierarchical execution plan with tasks, dependencies, and
approval gates; the plan must be approved via agent.plan.approve before
execution proceeds.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| goals | array of strings | High-level goals this plan achieves (1-20 items) |
| constraints | array of strings | Hard constraints the plan must respect (default: empty) |
| tasks | array of objects | Task definitions with hierarchy and dependencies (1-100 items) |
| approvalRequired | boolean | Whether user approval is required before execution (default: true) |
| messageId | string? | Originating conversation message ID (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| planId | string | Unique plan identifier |
| status | enum | Plan status: "draft" or "awaiting_approval" |
| goals | array of strings | Goals copied from input |
| tasks | array of objects | Task definitions |
| approvalRequired | boolean | Approval requirement flag |
| createdAt | string | ISO 8601 timestamp |

## Side effects

Plan record written to Postgres. If approvalRequired=true, creates approval
gate that blocks downstream execution until manually approved.

## Errors

None explicitly defined in the contract.
