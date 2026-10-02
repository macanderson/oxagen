# start_slack_connection

**Domain:** org
**Mode:** sync
**Scope:** organization (`scoped: false`, requires an orgId and no workspace)
**Surfaces:** none
**Sensitivity:** high
**Default effect:** deny
**Roles:** org Owner, Admin
**Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.slack_connection.start.ts`
Handler: `packages/handlers/src/org.slack_connection.start.ts`
App: the Slack section of Organization settings
Issue: [#4608](https://github.com/oxageninc/product/issues/4608)

## Intent

Begin connecting the organization's Slack workspace, so steering repo health
changes post to a channel an Owner or Admin picks. The call stores a
single-use state nonce and returns the Slack URL that asks the workspace to
install the Oxagen bot. The browser goes there next.

## Input

None.

## Output

`{ authorizeUrl }`: the `https://slack.com/oauth/v2/authorize` URL with the
app's client id, the bot scopes, the redirect URL
(`<APP_URL>/api/slack/oauth/callback`), and the state.

## Side effects

1. Stores the state in `auth.verifications` for ten minutes, bound to the
   organization and the person who started it, with the redirect URL beside
   it. `authorize_slack_connection` consumes it once.

No audit row. The nonce grants nothing on its own.
`authorize_slack_connection` writes `plugin.credential_set` when a token is
stored.

## Errors

| Code | Reason | When |
| --- | --- | --- |
| `forbidden` | `human_authorization_required` | The caller is an API key with no person behind it. |
| `conflict` | `slack_not_configured` | The deployment lacks `SLACK_APP_CLIENT_ID`, `SLACK_APP_CLIENT_SECRET`, or `APP_URL`. |

A caller who is not an Owner or Admin is refused before the nonce is stored.
