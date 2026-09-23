# ADR-151: Git custody keeps installation tokens in the host proxy

Status: Accepted

## Context

A wrapped harness can push with its operator's personal GitHub credential. Model credential custody does not govern that credential. Returning a GitHub installation token from a Git credential helper would still place the vendor token inside the harness's Git process.

## Decision

An operator opts a local repository into custody with `tacho github configure --repository owner/name --harness claude-code`. Codex, Cursor, and Stella use the same command with their harness name. The deployment also sets `OXAGEN_TACHO_GITHUB_BROKER=1`.

The command replaces exact repository-local remote URLs for that repository's HTTPS and SSH remotes. It saves their original values in the host file. A similarly named repository does not match. The replacement URL reaches the loopback daemon's Git smart HTTP proxy. A proxy-specific credential helper clears inherited helpers for that URL and obtains a random local lease. Personal GitHub credentials and unrelated remotes stay in their existing configuration.

The lease expires after at most 15 minutes. It names one repository and one live session belonging to the chosen harness in that working directory. Zero sessions or multiple sessions refuse the mint. Each request rechecks enrollment status, session state, lease expiry, and the signed mandate. Pause, cancel, sealing, and enrollment expiry refuse later requests. The proxy also aborts an in-flight request when those local states change.

The server resolves the host's immutable tenant scope and live workspace repository binding. It chooses the installation from that workspace's GitHub connection. It mints an uncached installation token with `repository_ids` containing only the binding's immutable repository ID and permissions `contents: write` and `metadata: read`. Neither the caller nor a stale repository name can select a broader installation grant.

The daemon keeps that token in memory, replaces the local lease with GitHub authentication, and streams the request. It accepts only discovery and upload/receive pack routes for the leased repository. It refuses redirects, caps request bodies at 128 MiB, and revokes the installation token after each request. A failed revocation is logged without credential content. GitHub's expiry remains the final ceiling if revocation cannot reach GitHub.

Before forwarding, the daemon records a `token_use` event on the session chain with `gateway_brokered`, the run token ID, and the repository. Completion records the HTTP status. HTTP success does not claim that GitHub accepted the ref update. Git's protocol response carries that result.

The host records the Git settings it owns. `tacho github configure --remove` removes them for one repository. Unenrollment removes recorded proxy settings before stopping the daemon. If a helper changed or a repository cannot be reached, unenrollment stops and names the directory that needs repair.

## Boundary

This is an opt-in transport path. A process with the operator's filesystem access can read personal credentials, alter Git configuration, or call another remote outside this path. Such a push remains harness-held and has no brokered-custody claim. The proxy does not revoke the operator's personal token. A daemon crash discards local leases, and a vendor token minted just before that crash remains valid until GitHub expires it.

The local lease proves which live session the configured helper selected. It does not isolate mutually untrusted processes running under the same operating-system account. For this reason the helper refuses an ambiguous working directory rather than guessing an agent.

## Verification

Proxy tests use a real loopback HTTP listener and session registry. They assert streamed Git bytes, daemon-only vendor authentication, revocation, repository/protocol refusal, signed-policy refusal, expiry, stopped-session checks, and redirect refusal. CLI tests use an isolated real Git repository and show that only the selected remote is rewritten, personal helpers survive, configuration is idempotent, and removal restores routing. Server tests check host authorization, current tenant bindings, immutable repository IDs, feature flags, input validation, and the kernel adapter.

References: [Git smart HTTP protocol](https://git-scm.com/docs/http-protocol), [GitHub installation token revocation](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token), and ADR-143.
