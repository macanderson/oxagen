# get_slack_connection

**Domain:** org
**Mode:** sync
**Scope:** organization (`scoped: false`, requires an orgId and no workspace)
**Surfaces:** none
**Sensitivity:** high
**Default effect:** deny
**Roles:** org Owner, Admin
**Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.slack_connection.get.ts`
Handler: `packages/handlers/src/org.slack_connection.get.ts`
App: the Slack section of Organization settings
Issue: [#4608](https://github.com/oxageninc/product/issues/4608)

## Intent

Read the organization's Slack connection for Organization settings: whether
the deployment can connect Slack at all, which workspace is connected, which
channel notices go to, and the last post that failed for a reason only a
person can fix.

## Input

None.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `configured` | boolean | The deployment holds the Slack app's client id and secret, and `APP_URL`. |
| `connected` | boolean | A Slack workspace is connected. |
| `teamName` | string or null | The Slack workspace name. |
| `channel` | `{ id, name, isPrivate }` or null | The channel notices go to. |
| `lastFailure` | `{ code, at }` or null | Slack's error code and when it happened, such as `not_in_channel`. |
| `connectedAt` | ISO 8601 string or null | When the connection was made. |

The view never carries the token.

## Side effects

None. Read-only, so no audit row.

## Errors

A caller who is not an Owner or Admin is refused.
