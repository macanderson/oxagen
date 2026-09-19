# list_github_installations

The GitHub App installations this workspace could attach, read from the GitHub user token the connect leg stored.

Why it exists. The Workspace settings dialog connects GitHub through the IDENTITY url (`login/oauth/authorize`), because `installations/new` only round-trips a `code` and our signed state on the FIRST install of the App on an account — so reconnecting, and connecting a second workspace to an account that already has the App, both dead-ended at the callback's no-state branch. The identity leg fixed that and introduced its own gap: it always returns a `code` and never an `installation_id`. A person authorizing from a machine whose account already carries the App came back holding a token, with `github.connected` still false and one button to press that would do the same thing again.

The OAuth callback closes most of that itself — it lists the authorizing user's installations and attaches the one, when there is exactly one. What it cannot do is choose: a person who administers two accounts that both carry the App must say which one this workspace acts through. This read is that choice, and `attach_github_installation` is the write that settles it.

The ids in this output are not a handle anyone gains by reading it. Every row comes from `GET /user/installations` answered for this workspace's own stored token — GitHub showing a person their own installations — and the attach re-asks that same list before it persists anything. This is the one place an installation id is spoken out loud, and it is spoken only to the account that owns it. `get_main_repository` still withholds the ATTACHED id for the same reason it always did: nothing on screen needs it.

**Surfaces:** api, mcp

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/repository/installation/candidates` → 200
- MCP: `list_github_installations`. The MCP context carries an API key and no user, so the handler's role check refuses it (`forbidden: no_principal`) — the tool exists for parity and for a session-backed context
- CLI: none
- Authentication: session; org Owner or Admin, checked by the handler (INV-29) — the pair that may attach and bind
- Capability name: `list_github_installations`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

None. The org and workspace come from the capability context; the GitHub authorization comes from the org's stored `oauth_accounts` row.

## Output

| Field | Type | Description |
|---|---|---|
| `installations[].installationId` | string | GitHub's numeric installation id as text — the value `attach_github_installation` takes |
| `installations[].accountLogin` | string | the account the App is installed on, as a person names it |
| `installations[].accountType` | string \| null | `User` or `Organization`; null when GitHub reported none |
| `installations[].avatarUrl` | string \| null | the account's avatar, so two similar logins are tellable apart |
| `installations[].repositorySelection` | string \| null | `all` or `selected` — whether the App reaches every repository on the account |

Installations are sorted by `accountLogin`, so two reads of an unchanged account put the same row in the same place; GitHub's own order is not promised. An installation GitHub reported without an account login is omitted: the picker's whole job is naming what it offers, and it stays reachable for the attach, which matches against the unfiltered list.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
| `conflict` | `github_not_authorized` | the org has no usable GitHub authorization to ask with — nobody has connected GitHub, or the stored token cannot be decrypted |

An empty list is **not** a refusal. It is the honest answer for an account that has authorized Oxagen and installed the App nowhere, and the surface answers it with the install door (`installations/new`, which `get_main_repository` returns as `github.manageUrl`). A GitHub failure surfaces as the upstream error rather than as an empty list: an account with the App installed nowhere and an account GitHub would not answer for are different facts, and only one of them means "install the App".
