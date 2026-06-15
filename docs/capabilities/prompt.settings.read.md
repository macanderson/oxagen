# prompt.settings.read

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the workspace prompt configuration: appended instructions,
content-prompt overrides, and the auto-improve-prompts toggle.

## Input

None (no input fields).

## Output

| Field | Type | Notes |
| --- | --- | --- |
| additionalInstructions | string? | Workspace-level appended instructions (nullable) |
| overrides | object | Partial overrides for: "conversation.title", "svg.generate", "image.analyze" |
| autoImprovePrompts | boolean | Auto-improve-prompts toggle setting |

## Side effects

Read-only. Queries Postgres workspace_prompt_settings table.

## Errors

None explicitly defined in the contract.
