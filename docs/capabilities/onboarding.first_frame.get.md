# get_first_frame

The register flow's "Wait for the first frame" step (mockup `regRun`; #2967), for one registered agent: whether a host has enrolled for it (`enroll_host`), what that host last reported (heartbeat, hooks), and the first frame `ingest_tacho_events` accepted from it — the moment the agent exists on Fleet, as the run `list_runs` shows.

`waitMs` is the handler-side long poll, as on `get_run`: the handler re-reads the store every 500 ms inside the tenant scope until the first frame lands or the budget runs out, so the page's stream costs one invoke per `waitMs` rather than one per tick. With no frame the answer is `firstFrame: null`, however long the wait; nothing here completes on a timer.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/onboarding/first-frame`
- MCP: `get_first_frame`
- Authentication: session or API key; org Owner, Admin or Member; workspace Owner or Member
- Capability name: `get_first_frame`
- Not billed (`noBillingGate: true`); IAM default-deny; medium sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `agentId` | string | yes | `agt_…` |
| `waitMs` | integer | no | 0-20000, default 0 |

## Output

| Field | Type | Description |
|---|---|---|
| `agentId` | string | `agt_…` |
| `agentKey` | string or null | `org_ns.ws_ns.slug` |
| `host` | object or null | `{ hostEnrollmentId: tch_…, enrolledAt, lastHeartbeatAt, hooksOk }`; null until `enroll_host` ran; `lastHeartbeatAt` and `hooksOk` null until the collector reports |
| `firstFrame` | object or null | `{ runId: tse_…, receivedAt }`, where `receivedAt` is when Oxagen stored the session, on the server's clock (the host's reported start time is not used); null until the first session lands |

## Refusals

`not_found: agent_not_found` for an agent the workspace does not hold.
