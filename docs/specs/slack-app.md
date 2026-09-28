# Oxagen Slack app

**Status:** Current
**Date:** 2026-09-28
**Related:** `infra/slack/manifest.json`, #4608 (Slack notices for steering health), lane C8 in `oxagen-roadmap:agent-work-plan.html` (Slack channel collector)

Use this page when you build a feature on the Oxagen Slack app, change the app's settings, or rotate its credentials.

## The app

| Field | Value |
|---|---|
| Name | Oxagen |
| App ID | `A0C52G85DS6` |
| Client ID | `11714154126610.12172552183890` |
| Development workspace | `oxagenworkspace` (`T0BM04J3QHY`) |
| Settings page | https://api.slack.com/apps/A0C52G85DS6 |
| Manifest | `infra/slack/manifest.json` |

One app serves every Oxagen feature that talks to Slack: the organization notices in #4608 first, and the C8 channel collector if it ships. The agent that created the app chose one app over two on 2026-09-28. Mac has not ruled on that choice.

## Credentials

SSM holds the same four values under `/oxagen/production/` and `/oxagen/staging/`, as `SecureString`.

| SSM name | Holds |
|---|---|
| `SLACK_APP_ID` | The app ID |
| `SLACK_APP_CLIENT_ID` | The OAuth client ID |
| `SLACK_APP_CLIENT_SECRET` | The OAuth client secret |
| `SLACK_APP_SIGNING_SECRET` | The secret Slack signs each request with |

No code reads these names yet, so they are a proposal. The change that first reads them (#4608) adds them to `packages/config/src/registry.ts` and `.env.example`. Do not reuse `SLACK_DATA_*`. Those names belong to the de-registered Slack data connector.

To rotate the client secret or the signing secret, regenerate it on the settings page under Basic Information, then write the new value to both SSM paths.

## Redirect URLs

The app accepts three OAuth redirect URLs:

```
https://app.oxagen.sh/api/slack/oauth/callback
https://app.staging.oxagen.sh/api/slack/oauth/callback
https://preview-app.oxagen.sh/api/slack/oauth/callback
```

No route serves that path yet. Build the callback at `apps/app/src/app/api/slack/oauth/callback/route.ts` so its path matches. To use a different path, change the manifest first.

## Scopes

The bot asks for four scopes:

| Scope | Why |
|---|---|
| `chat:write` | Post a notice |
| `chat:write.public` | Post in a public channel the bot has not joined |
| `channels:read` | List public channels for the channel picker |
| `groups:read` | List the private channels the bot has joined |

A feature that needs more scopes adds them to the manifest in the same PR.

## Settings left off

- **Events and interactivity.** Slack sends a `url_verification` challenge to an events request URL, and nothing at `api.oxagen.sh` answers it. `apps/api/src/routes/v1/webhook.ts` takes one URL per connection and checks a secret per connection. A Slack app has one events URL and one signing secret. Build an app-level endpoint that verifies `SLACK_APP_SIGNING_SECRET` and routes each event by `team_id`, then add `event_subscriptions` to the manifest.
- **Token rotation.** Off. Slack cannot turn rotation off once it is on, and no code refreshes this app's bot tokens.
- **Org-wide install** (`org_deploy_enabled`). Off. An Enterprise Grid org install returns a token for the whole org with no team, and the callback has to handle that first.
- **`is_mcp_enabled`.** Off. Slack added this field to the app's settings, and the manifest carries it so `slack manifest sync` finds no difference.

## Change a setting

Edit `infra/slack/manifest.json`, then run from `infra/slack`:

```sh
slack manifest validate -w T0BM04J3QHY
slack manifest sync -w T0BM04J3QHY --manifest-source local
```

`.slack/hooks.json` prints the manifest for the Slack CLI. `.slack/apps.json` links the project to `A0C52G85DS6` in `oxagenworkspace`. The app is installed in `oxagenworkspace` because the CLI refuses to diff or sync an app with no install.

## Before a customer can install

Public distribution is off, so only `oxagenworkspace` can install the app. On the settings page, open Manage Distribution, complete the checklist, and activate public distribution. The manifest cannot set this.

## Slack's history rate limit

Since 2025-05-29, a commercially distributed app outside the Slack Marketplace may call `conversations.history` and `conversations.replies` once per minute, for at most 15 objects per call ([Slack changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)). The limit does not touch posting a notice. The C8 collector's plan fetches threads with `conversations.replies`, so plan C8 around the limit: get Marketplace approval, or read thread replies from the message events as they arrive.
