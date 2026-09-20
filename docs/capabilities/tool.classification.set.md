# set_tool_classification

**Capability:** `set_tool_classification`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; governance configuration spends nothing)

## Intent

Set a tool version's safety classification (MC spec §6.9 part 1; ADR-072 §1): the risk grade, the side-effect class, the egress class, the consequence tags (the spec's starter set plus any customer tag), the measures the tool exposes as paths into its input, and the data classes it touches. Classification describes the tool and decides nothing by itself; a class kill switch matches a version by its tags at call time, and later approval rules are written against it.

The risk grade set here lands on `classified_risk_grade`; the version's declared `risk_grade` and the checksum over its manifest stay as published, so reclassifying never makes an unchanged manifest republish. A changed classification bumps the deny generation in the write's transaction (trigger `tool_versions_classification_deny_generation`), so a kill-switch gate already open for a turn reloads the tags before its next non-read-only call. A new version of the tool (a changed descriptor from `import_tools` or `publish_tool_declaration`) starts with this classification.

The version records who classified it, when and why; every reclassification is a `tool.classification_changed` security event carrying the actor and the capability. The contract declares the version as its audit target, so a resource-scope emergency deny naming the version refuses the call (#1261).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `toolVersionId` | string | yes | `tlv_…` in this workspace |
| `riskGrade` | enum | yes | `low`, `medium`, `high`, `critical` |
| `classification` | object | yes | `sideEffect` (`read`, `write`, `irreversible`), `egress` (`local`, `org_tenant`, `third_party`), `consequenceTags` (snake_case, unique, ≤32), `measures` (name → `{ path: "$.…", type, currencyPath?, unit? }`; a `money` measure names `currencyPath`), `dataClasses` |
| `reason` | string | yes | 1-500 characters; recorded as `classification_reason` |

## Output

| Field | Type | Description |
|---|---|---|
| `toolVersionId` | string | |
| `riskGrade` | enum | as written |
| `classification` | object | as written |
| `classifiedAt` | string | RFC 3339 |

## Roles

Org Owner or Admin (`assertOrgRole`, INV-29).

## Side effects

Updates `agent.tool_versions` (`classified_risk_grade`, `classification`, `classified_by_user_id`, `classified_at`, `classification_reason`); a changed classification bumps the deny generation (trigger). Emits `tool.classification_changed`.

## Surfaces

- `PUT /v1/{org}/{ws}/tools/versions/classification`
- MCP tool `set_tool_classification` (an API key acts as its creator at the role gate, ADR-072 decision 8)
- App: **Tools → Registry → a row opens the tool dialog** at `/{org}/{ws}/tools` — the reclassification form; the version's measures are carried through unchanged.

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or not Owner or Admin |
| `not_found` (404) | no such version in this workspace |
| `invalid_input` | a tag outside the pattern, a repeated tag, a money measure with no currency path |


## Tool changes and disabled rules

Tool classification and publication recheck matching enabled approval rules in
the same transaction as the tool write (ADR-119). A rule whose recorded author
no longer has authority is disabled. A changed measure path, type, unit, or
scale used by the rule, or a newly matching tool, requires explicit review.
The tool change itself is not refused because an existing rule fails that check.

`disabledReason` carries `code` (`classification_changed`, `measure_changed`, or
`tool_scope_changed`), `tool` (`slug@version`), `at`, and `detail`. API and MCP
reads return it, and Tools shows the reason. Switching off preserves it. Saving
or switching on reruns the authoring checks and clears it. The security event
`approval_rule.invalidated` names the rule, tool, actor, and before/after facts.
