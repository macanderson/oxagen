# cancel_assistant_turn

**Domain:** assistant
**Mode:** sync
**Scope:** workspace (`scoped: true`)
**Surfaces:** api
**Sensitivity:** medium · **Default effect:** deny · **Roles:** org Owner, Admin; workspace Owner, Member
**Billing gate:** none · **Agent tool:** no

Contract: `packages/oxagen/src/contracts/assistant.turn.cancel.ts`
Handler: `packages/agent/src/handlers/assistant.turn.cancel.ts`
API: `POST /v1/:org_slug/:workspace_slug/assistant/turn/cancel`
App: `POST /:org/:ws/assistant/stop`, the flyout's Stop control

## Intent

Stop an [`ask_assistant`](assistant.ask.md) turn that is still running (#4164). The caller names the turn by the `turnId` it minted and passed with the question. The stopped turn cancels its engine turn, keeps the reply the engine wrote before the stop, and seals its run `cancelled`. `ask_assistant` then returns with `stopped: true`.

Only the person who asked can stop the turn, and only in the workspace they asked in. The turn is looked up by the organisation, the workspace, the acting person and the turn id together. Another person's stop never matches, and it answers `found: false` like any stop that finds nothing, so a caller cannot learn whether someone else's turn exists.

Closing the flyout or leaving the page never calls this. A turn keeps running when the person walks away (ADR-092, #3292).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `turnId` | uuid | yes | the `turnId` the caller passed to `ask_assistant` |

## Output

| Field | Type | Description |
|---|---|---|
| `turnId` | uuid | the turn the stop named |
| `found` | boolean | true when a running turn of the caller's took the stop. False when none is running under this id: it already ended, it was already stopped, or it has not started yet |

## Behavior

1. A stop is idempotent. A second stop, and a stop for a turn that already ended, answer `found: false` without error.
2. A stop can arrive before its turn starts, because the question and the stop travel on separate requests. The stop is then held for one minute, and the turn stops as soon as it registers. At most 1,000 stops are held; past that the oldest is dropped.
3. The stop aborts the engine turn. The run's seal carries verdict `cancelled` and the reason `stopped by the person who asked`. The reply is saved with message status `stopped`, and it may be empty when the stop came before the first token.
4. A stop does not undo a tool call that already ran. A governed write that parked before the stop stays parked and is returned in `parkedCards`.

## Process memory

Running turns are held in the memory of the process that runs them, so a stop must reach that process. The app's stop reaches a turn asked from the app, and the API route reaches a turn asked through the API. Production runs one app node. A second replica would need the stop routed to the replica that holds the turn.

## Errors

| Code | Status | When |
|---|---|---|
| `forbidden` (reason `no_principal`) | 403 | the caller carries no person to stop as |
| `forbidden` | 403 | the person holds none of the contract's roles in the workspace |
| `validation_error` | 400 | `turnId` is missing or is not a uuid, or the body carries another field |
| (none) | 400 | the body is not JSON |
