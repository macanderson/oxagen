# get_onboarding_state

**Surfaces:** api, mcp, agent

Where the signed-in person is in the onboarding gate (MC spec App. F: "the app does not open until an agent has talked to Oxagen"; mockup `OB_STEPS`; #2967). A caller with no organization is at `organization`; a caller with one reads its `org.onboarding_state` row — `wrap`, `run` or `unlocked` — with the first frame `ingest_tacho_events` recorded. Sign-up and email verification belong to the session, so the row starts at `wrap` the moment `create_org` returns.

An organization that predates the gate has no row (the migration wrote none, and no first frame is known for it) and reads as `unlocked` with `firstFrameAt: null`, `firstRunId: null`, and `workspace: null`.

#4616 removed the provisional window and its `provisional` field. The steering repo job binds a workspace's steering repository when the workspace is created (ADR-212), so there is no window left to report.

## Mode

**sync**

## Surface

- API: `POST /v1/onboarding/state` (no organization yet) and `POST /v1/:org_slug/onboarding/state`
- MCP: `get_onboarding_state`
- Authentication: session or API key; any member
- Capability name: `get_onboarding_state`
- Unscoped (`scoped: false`); not billed (`noBillingGate: true`); IAM default-allow; low sensitivity
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Input

None (`{}`).

## Output

| Field | Type | Description |
|---|---|---|
| `step` | enum | `organization`, `wrap`, `run`, `unlocked` |
| `workspace` | object or null | `{ id: wrk_…, slug }`, the gate's workspace (the first one); null until the organization's first workspace exists |
| `firstFrameAt` | string or null | RFC 3339; the first frame's arrival, null until then and for an organization that predates the gate |
| `firstRunId` | string or null | the run the first frame opened (`tse_…`) |

## Honesty

The read reports what the row holds, and a row is `unlocked` exactly when it carries the frame that opened it (the table's CHECK). An organization from before the gate has no row and no invented instant.
