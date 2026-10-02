# set_slack_channel

**Domain:** org
**Mode:** sync
**Scope:** organization (`scoped: false`, requires an orgId and no workspace)
**Surfaces:** none
**Sensitivity:** high
**Default effect:** deny
**Roles:** org Owner, Admin
**Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.slack_channel.set.ts`
Handler: `packages/handlers/src/org.slack_channel.set.ts`
App: the channel picker in Organization settings
Issue: [#4608](https://github.com/oxageninc/product/issues/4608)

## Intent

Pick the channel steering repo health notices go to. The handler asks Slack
for the channel with `conversations.info` rather than trusting a name from the
browser.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `channelId` | string | A Slack channel id starting with `C` or `G`. |

## Output

The connection view `get_slack_connection` returns, with the new channel and
`lastFailure: null`.

## Side effects

1. Stores the channel id, name, and privacy with the connection, and clears
   the failure on record, because a new channel fixes most of them.

No audit row. The channel changes where notices go, not who holds access, and
the token is untouched. A private channel needs the Oxagen bot invited
(`/invite @Oxagen`) before a post can land.

## Errors

| Code | Reason | When |
| --- | --- | --- |
| `conflict` | `slack_not_connected` | No Slack workspace is connected. |
| `not_found` | `slack_channel_not_found` | Slack cannot find the channel, or the bot cannot see it. |
| `conflict` | `slack_channel_archived` | The channel is archived. |
| `conflict` | `slack_connection_broken` | The stored token will not decrypt, or Slack refused it. Reconnect. |
| `conflict` | `slack_connection_changed` | Someone disconnected or reconnected Slack during the call. Reload and pick again. |
