---
# Machine/OAuth Flow Landings

- **Route:** `/cli/authorize`, `/github/setup`
- **Nav location:** none (entered only via external redirect — CLI loopback OAuth or GitHub App post-install callback — never linked from in-app nav)
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
These are landing pages for machine-initiated flows that need a human in a browser to grant consent or resolve a target: the CLI's local OAuth login handshake, and the GitHub App's post-installation redirect back into the correct workspace. Both exist to keep every machine-issued credential and connector event attributable to a specific org/workspace/user, which is what makes CLI- and connector-initiated actions auditable rather than anonymous.

## Primary user & jobs-to-be-done
- **Primary user:** A developer running `oxagen login` from the CLI, or an org admin who just installed the Oxagen GitHub App.
- **JTBD:**
  - Approve (or deny) a CLI login request and pick which org/workspace it should act as.
  - Land somewhere sane after configuring the GitHub App, without manually finding the right workspace.

## Functionality
| Route | Flow | Key checks | Action |
|---|---|---|---|
| `/cli/authorize` | RFC 8252 loopback OAuth + PKCE consent screen | Session required; validates `redirect_uri` and PKCE `challenge` server-side; gates the Approve button on `actorCanManageApiKeys` (owner/admin only) | Org/workspace picker + Approve/Deny; on approve, mints a single-use auth code and redirects to the CLI's local loopback listener |
| `/github/setup` | GitHub App post-configuration landing | Resolves target workspace by joining `sourceConnections` ⋈ `orgUsers` for the installing user | No form — resolves and redirects immediately to the connector's workspace settings page |

Primary action on `/cli/authorize`: Approve / Deny buttons plus an org/workspace selector. `/github/setup` has no user-facing controls — it is a pure redirect resolver, same shape as the root dispatcher but scoped to the GitHub install callback.

## Capabilities invoked
- `api.key.create` (`create_api_key`) — conceptually backs the CLI credential mint on approve (the single-use auth code is exchanged for a token via this capability's issuance path).
- `system.install.instructions` (`get_install_instructions`) — related machine-onboarding capability (CLI/connector install instructions surface elsewhere in developer settings; noted here for completeness of the machine-flow family).

## Data sources
- **Postgres**: `sourceConnections`, `orgUsers`, `organizations`, `workspaces` reads to resolve target scope; API-key/session rows written on CLI approve.
- No direct Neo4j, ClickHouse, or Blob access from these landing pages (connector ingestion itself writes to Neo4j/ClickHouse elsewhere, not here).

## States
- **Empty:** N/A.
- **Loading:** Approve button disabled while minting the auth code; `/github/setup` shows a brief "finishing setup" state before redirect.
- **Error:** Invalid/expired `redirect_uri` or PKCE challenge on `/cli/authorize` renders a hard error (not a retryable form); unresolvable workspace on `/github/setup` falls back to the org root or an explicit "couldn't find your workspace" message.

## Existing implementation
- **Today:** `apps/app/src/app/cli/authorize/page.tsx` (+ `actions.ts`, `consent-form.tsx`) — complete. `apps/app/src/app/github/setup/page.tsx` (+ `resolve-target.ts`) — complete. Both reusable as-is.

## Vision alignment
Governed CLI credential issuance and connector-install attribution are the accountability chain's "identity" link for non-human/automated actors — every CLI or connector action must still trace to a principal. P2: important for trust but not on the primary human-driven revenue loop.
