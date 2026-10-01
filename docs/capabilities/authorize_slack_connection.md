# authorize_slack_connection

**Domain:** org
**Mode:** sync
**Scope:** organization (`scoped: false`, requires an orgId and no workspace)
**Surfaces:** none
**Sensitivity:** high
**Default effect:** deny
**Roles:** org Owner, Admin
**Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.slack_connection.authorize.ts`
Handler: `packages/handlers/src/org.slack_connection.authorize.ts`
App: `apps/app/src/app/api/slack/oauth/callback/route.ts`
Issue: [#4608](https://github.com/oxageninc/product/issues/4608)

## Intent

Finish connecting Slack with the code Slack returned to the callback route.
The token Slack issues is stored encrypted and never leaves the server.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `state` | string, 43 base64url characters | The nonce `start_slack_connection` issued. |
| `code` | string, 1 to 512 characters | Slack's one-time authorization code. |

## Output

The connection view `get_slack_connection` returns. `channel` is null on a
new connection until an Owner or Admin picks one with `set_slack_channel`.

## Side effects

The order is fixed:

1. Consumes the state. A state that expired, was used, or belongs to another
   organization or person is refused, and the code never reaches Slack.
2. Exchanges the code with `oauth.v2.access`, using the redirect URL stored
   beside the state.
3. Revokes and refuses a token from another Slack app (when `SLACK_APP_ID` is
   set) or one without `chat:write`.
4. Stores the token encrypted, replacing any earlier connection, then asks
   Slack to revoke the replaced token. That revoke is best effort and logged.
5. Writes a `plugin.credential_set` security event with
   `detail.feature: "slack_notices"`, the Slack team id, and the count of
   replaced tokens. The token is never in it.

## Errors

| Code | Reason | When |
| --- | --- | --- |
| `forbidden` | `human_authorization_required` | The caller is an API key with no person behind it. |
| `forbidden` | `slack_oauth_state_expired` | The state is older than ten minutes or was already used. |
| `forbidden` | `slack_oauth_state_invalid` | The stored state does not parse. |
| `forbidden` | `slack_oauth_state_mismatch` | Another organization or person started this connection. |
| `conflict` | `slack_not_configured` | The deployment lacks the Slack app's client id, secret, or `APP_URL`. |
| `conflict` | `slack_oauth_exchange_failed` | Slack refused the code or did not answer. Start again from Organization settings. |
| `conflict` | `slack_app_mismatch` | The token belongs to another Slack app. |
| `conflict` | `slack_scope_missing` | The token cannot post messages. |

Every failed exchange reads as `slack_oauth_exchange_failed`, a network error
included. The state is spent by then and Slack accepts a code once, so a
retry with the same pair cannot pass. The log keeps Slack's own error code.
