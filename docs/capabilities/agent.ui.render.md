# agent.ui.render

**Domain:** agent
**Mode:** sync
**Scope:** organization/system
**Surfaces:** agent (client-side only)
**Risk level:** low

## Intent

Render a UI component from an agent response.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| componentId | string | UI component identifier (required, non-empty) |
| props | object | Component props as key-value pairs (default: empty) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| render | object | Render instruction with componentId and props |

## Side effects

Client-side rendering only. No backend mutations. Emits render event to chat UI.

## Errors

Unknown componentId renders UnknownComponentCard in the client.
