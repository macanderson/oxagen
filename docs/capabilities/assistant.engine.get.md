# get_assistant_engine

Whether the in-app agent's engine can take a turn (ADR-053 §4; MC spec §4.4). The engine is a required service, so the flyout reads this before it offers a composer and again on Retry after an `engine_unavailable` refusal.

The probe calls the engine's own readiness route, `GET /readyz`, up to three times with a two-second timeout each, and the answer names what was observed. Nothing here starts a turn or falls back to an in-process loop.

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/assistant/engine`
- MCP: `get_assistant_engine`
- Authentication: session (org Owner, Admin or Member; workspace Owner, Member or Viewer)
- Capability name: `get_assistant_engine`
- Not billed (`noBillingGate: true`): a console read is never a governed action (ADR-052 exclusion 2).

## Input

None.

## Output

| Field | Type | Description |
|---|---|---|
| `state` | enum | `ready`, `starting`, `draining` (the engine's own word), `unreachable` (no answer after the attempts made), `unconfigured` (`STELLA_SERVE_URL` or `STELLA_SERVE_TOKEN` is not set) |
| `endpoint` | string or null | `host:port` the probe was aimed at; null when unconfigured |
| `attempts` | integer | 0 to 3 |
| `error` | string or null | the last failed attempt's code (`ECONNREFUSED`, `ETIMEDOUT`, …) or `engine_unavailable` when unconfigured; null when the engine answered |
| `checkedAt` | string | RFC 3339 |
| `incident` | object or null | null: rev1 has no incident store (`apps/app/ARCHITECTURE.md` §1.2), so an unreachable engine is reported here and filed nowhere |
