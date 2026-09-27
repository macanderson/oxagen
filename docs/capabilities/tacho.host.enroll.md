# enroll_host

`enroll_host` (MC spec App. E: "device key, host agent, bundle, hooks"; §14.1 `oxagen agent enroll`; #2967): a machine becomes a registered agent's host by presenting the single-use enrollment token `create_enrollment_token` minted.

The token is the credential: the call carries no session and no API key, so the capability is unscoped and the handler resolves the tenant from the token, then does what `create_tacho_enrollment` does for an operator — the host's scoped API key (`tacho_host_v1`), the HMAC-signed enrollment the collector verifies offline, the initial signed policy bundle — with the host bound to the token's agent and its principal, so the sessions it reports are that agent's runs. The token is consumed in the same transaction under a row lock, so two machines presenting it at once cannot both enrol. The git remote the installer ran in is recorded on the gate as `detectedRepository` while the gate is open, for the "Repository detected" offer.

## Mode

**sync**

## Surface

- API: `POST /v1/tacho/enroll` → 201, public (mounted before the auth-gated `/v1` groups; the token in the body is the boundary). Its own pre-auth ceilings answer 429: 5 presentations of one token and 120 from one client address a minute. That address is the one the deployment's own edge named — `X-Oxagen-Client-Ip` from Caddy on AWS (read only while `TRUST_EDGE_CLIENT_IP_HEADER` is `true`, which an operator sets after that Caddy config is deployed), `x-vercel-forwarded-for` on Vercel, or the `x-forwarded-for` walk over the proxies named in `TRUSTED_PROXY_CIDRS`, which stops at the first entry that is not one of them and returns it only if a named proxy stood to its right. Never a caller-supplied leftmost entry and never `x-real-ip` (ADR-083). The per-address ceiling is enforced **only where one of those names the caller**; otherwise the per-address counter is skipped for the request — it neither counts nor denies — and the per-token ceiling still applies. That is deliberate rather than a gap: this mount runs before any credential exists, so a bucket every caller shares is not a ceiling but a way for any one of them to deny enrollment to all the others. Counting hops was the previous design and is gone rather than deprecated — a caller controls the header's length, so a count that was too high let it pad until the arithmetic landed on a value it chose. It does not share the `/v1/tacho/*` credential bucket that calls with no `Authorization` header fall into.
- CLI: `oxagen agent enroll --token <token> [--harness …]`
- No MCP tool and no agent surface
- Capability name: `enroll_host`
- Unscoped (`scoped: false`); not billed (`noBillingGate: true`); IAM default-allow (no principal exists on the call; the token decides); high sensitivity

## Input

`create_tacho_enrollment`'s host facts (`hostname`, `osUser`, `platform`, `devicePublicKey`, `harnesses`, the version facts, `managed`, `validityDays`) plus:

| Field | Type | Required | Constraint |
|---|---|---|---|
| `token` | string | yes | `oxe_1time_` + 26 Crockford characters |
| `repositoryRemote` | string | no | the git remote of the directory the installer ran in; recorded when it names a GitHub repository |

## Output

`create_tacho_enrollment`'s document (`hostEnrollmentId`, `agentKey`, `apiKeyPublicId`, `apiKey` shown once, `enrollment`, `policyBundle`, `bundlePublicKeyPem`, `expiresAt`) plus:

| Field | Type | Description |
|---|---|---|
| `agentId` | string | `agt_…`, the agent the host reports as |
| `orgSlug`, `workspaceSlug` | string | the tenant the token named, which the host did not know before the call |

## Refusals

| Code | Reason | When |
|---|---|---|
| `not_found` | `token_unknown` | no token matches the digest |
| `conflict` | `token_used` | the token was presented before, including by a concurrent presentation that won the row lock (counted on the row) |
| `conflict` | `token_expired` | past `expiresAt` (counted on the row) |
| `conflict` | `agent_retired` | the token's agent was deleted or retired after the token was issued. The transaction rolls back and leaves the token unused |
| `forbidden` | `agent_managed_read_only` | the token names the built-in assistant stella acts as, which runs on no host (#4350). The transaction rolls back and leaves the token unused |
| `conflict` | `agent_has_host` | a live host is already enrolled as that agent key; a revoked host gives its key up, so revoke it and present a new token |

## Honesty

As `create_tacho_enrollment`: records from a Tacho host are `client_attested` evidence, and hook-based denial is enforcement at the harness. The agent appears on Fleet only when its first frame arrives; enrolling writes the host, never a run.
