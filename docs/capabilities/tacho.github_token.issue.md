# create_github_token

Mint a GitHub App installation token for one repository bound to the calling host's workspace. The enrolled daemon uses this endpoint for its local Git smart HTTP proxy. Git receives a local session lease and does not receive the installation token.

**Surfaces:** api

**Input:** `host_enrollment_id`, repository `owner` and `name`, and `run_token_id`.

**Output:** `token`, `expires_at`, and the repository's `owner`, `name`, `full_name`, and binding `role`.

The deployment must set `OXAGEN_TACHO_GITHUB_BROKER=1`. The host API key must own the named active enrollment, and its creator must still hold the organization Owner or Admin role. The handler resolves the GitHub installation from the workspace connection and narrows the token to the current binding's immutable repository ID with `contents: write` and `metadata: read`. Unbound repositories, invalid IDs, missing connections, and GitHub refusals fail without returning a broader credential.

The workspace's steering repository takes changes through a steering PR. Its token comes only from the workspace's own GitHub App installation. This capability never issues an Oxagen Steering app token, because that app holds the only bypass on the merge ruleset. When the workspace has no installation, or its installation does not cover the steering repository, the call fails with `conflict: steering_repo_propose_only`. Propose the change through a steering PR instead, or push a branch from a clone with a credential that can write to the repository.

Enable a local repository with `tacho github configure --repository owner/name --harness claude-code`. Choose `codex`, `cursor`, or `stella` for another enrolled harness. The proxy requires exactly one live session in that directory. Remove the configuration with the same command plus `--remove`.

The credential exists only in the server response and daemon memory. The daemon revokes it after each Git request. Personal credentials and requests outside the configured transport remain outside this custody path. See [ADR-151](../adr/ADR-151-git-custody-keeps-installation-tokens-in-the-host-proxy.md).

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `github_broker_disabled` | the deployment does not set `OXAGEN_TACHO_GITHUB_BROKER=1` |
| `forbidden` | `host_inactive` | the host enrollment is not active |
| `not_found` | `repository_not_governed` | no head in the host's workspace points at that repository |
| `conflict` | `repository_id_invalid` | the binding's repository ID is not a number |
| `conflict` | `github_not_connected` | the workspace has no GitHub App installation |
| `conflict` | `steering_repo_propose_only` | the repository is the steering repository, and the workspace installation is missing or does not cover it |
| `conflict` | `github_refused` | GitHub refused the mint |
