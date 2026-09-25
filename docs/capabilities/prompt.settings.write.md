# update_prompt_settings

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update the workspace prompt configuration (partial). `additionalInstructions`
and `autoImprovePrompts` are available on all plans; `overrides` (full prompt
replacement) is enterprise-only.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| additionalInstructions | string? | Appended instructions (max 8000 chars, null to clear) (optional) |
| overrides | object? | Full-replacement overrides for "conversation.title", "svg.generate", "image.analyze" (each max 4000 chars, null to clear all) (optional, enterprise-only) |
| autoImprovePrompts | boolean? | Toggle auto-improve-prompts (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| additionalInstructions | string? | Updated appended instructions (nullable) |
| overrides | object | Updated overrides |
| autoImprovePrompts | boolean | Updated toggle state |

## Roles

An org Owner or Admin, or a workspace Owner or Admin. The handler checks the contract's roles and refuses anyone else with `forbidden` (`org_role_required`).

## Side effects

Postgres workspace_prompt_settings updated. Changes take effect immediately on
next AI invocation.

The in-app assistant carries `additionalInstructions` as one SHOULD item in
its steering, beside the workspace's published context records. The steering
assembler ranks every published MUST record above the instructions and fits
both to 4,096 budget tokens. Text that does not fit is cut, and the turn's
`steering.manifest` frame names the cut (ADR-093 §7).

## Errors

None explicitly defined in the contract.
