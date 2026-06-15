# prompt.settings.write

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

## Side effects

Postgres workspace_prompt_settings updated. Changes take effect immediately on
next AI invocation.

## Errors

None explicitly defined in the contract.
