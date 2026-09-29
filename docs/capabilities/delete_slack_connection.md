# delete_slack_connection

**Domain:** org
**Mode:** sync
**Scope:** organization (`scoped: false`, requires an orgId and no workspace)
**Surfaces:** none
**Sensitivity:** high
**Default effect:** deny
**Roles:** org Owner, Admin
**Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.slack_connection.delete.ts`
Handler: `packages/handlers/src/org.slack_connection.delete.ts`
App: the Slack section of Organization settings
Issue: [#4608](https://github.com/macanderson/oxagen/issues/4608)

## Intent

Disconnect the organization's Slack workspace. Steering repo health notices
stop posting to Slack. The in-app notice and the email continue.

Deleting when nothing is connected is not an error.

## Input

None.

## Output

The connection view with `connected: false`.

## Side effects

1. Deletes the stored token and the channel.
2. Asks Slack to revoke the token. The revoke is best effort: once the row is
   gone, Oxagen cannot post, whatever Slack answers. A failure is logged, and
   the person can remove the app from Slack by hand.
3. Writes a `plugin.credential_revoked` security event with
   `detail.feature: "slack_notices"`, the count of tokens removed, and the
   count Slack revoked, only when a token was removed.

## Errors

| Code | Reason | When |
| --- | --- | --- |
| `forbidden` | `human_authorization_required` | The caller is an API key with no person behind it. |
