# list_slack_channels

**Domain:** org
**Mode:** sync
**Scope:** organization (`scoped: false`, requires an orgId and no workspace)
**Surfaces:** none
**Sensitivity:** high
**Default effect:** deny
**Roles:** org Owner, Admin
**Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.slack_channels.list.ts`
Handler: `packages/handlers/src/org.slack_channels.list.ts`
App: the channel picker in Organization settings
Issue: [#4608](https://github.com/macanderson/oxagen/issues/4608)

## Intent

List the channels the picker offers. The handler reads Slack's
`conversations.list` with the stored bot token. It returns every channel that
is not archived, sorted by name. A private channel appears only once the
Oxagen bot is a member of it.

## Input

None.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `channels` | `{ id, name, isPrivate }[]` | A row with a channel id Oxagen does not recognize is dropped. |
| `truncated` | boolean | The workspace has more channels than the handler read. The handler stops after a fixed number of pages. |

## Side effects

None. Read-only, so no audit row.

## Errors

| Code | Reason | When |
| --- | --- | --- |
| `conflict` | `slack_not_connected` | No Slack workspace is connected. |
| `conflict` | `slack_connection_broken` | The stored token will not decrypt, or Slack refused it (`token_revoked`, `invalid_auth`, `missing_scope`, and similar). Reconnect. |

A failure a retry may pass, such as a rate limit or a Slack outage, comes back
as an unclassified error without Slack's code.
