# onboarding.state.get

Where the signed-in person is in the onboarding gate (MC spec App. F: "the app does not open until an agent has talked to Oxagen"; mockup `OB_STEPS`; #2967). A caller with no organization is at `organization`; a caller with one reads its `org.onboarding_state` row — `wrap`, `run` or `unlocked` — with the first frame `ingest_tacho_events` recorded and the provisional window `bind_main_repository` closes. Sign-up and email verification belong to the session, so the row starts at `wrap` the moment `create_org` returns.

An organization that predates the gate has no row (the migration wrote none: it was never provisional and no first frame is known for it) and reads as `unlocked` with `firstFrameAt: null`, `firstRunId: null`, `workspace: null`, `provisional: null`.

## Mode

**sync**

## Surface

- API: `POST /v1/onboarding/state` (no organization yet) and `POST /v1/:org_slug/onboarding/state`
- MCP: `get_onboarding_state`
- Authentication: session or API key; any member
- Capability name: `get_onboarding_state`
- Unscoped (`scoped: false`); not billed (`noBillingGate: true`); IAM default-allow; low sensitivity

## Input

None (`{}`).

## Output

| Field | Type | Description |
|---|---|---|
| `step` | enum | `organization`, `wrap`, `run`, `unlocked` |
| `workspace` | object or null | `{ id: wrk_…, slug }`, the gate's workspace (the first one); null before an organization exists |
| `firstFrameAt` | string or null | RFC 3339; the first frame's arrival, null until then and for an organization that predates the gate |
| `firstRunId` | string or null | the run the first frame opened (`tse_…`) |
| `provisional` | object or null | `{ until, mainRepoBoundAt, detectedRepository }`; open while `mainRepoBoundAt` is null; null before an organization exists and for an organization that predates the gate. `detectedRepository` is `{ provider: "github", owner, name }` from the git remote the enrolling host reported, or null |

## Honesty

The read reports what the row holds, and a row is `unlocked` exactly when it carries the frame that opened it (the table's CHECK). An organization from before the gate has no row and no invented instant or window. The `until` date is the window the mockup prints; the provisional state itself is `mainRepoBoundAt === null`, and only `bind_main_repository` changes it.
