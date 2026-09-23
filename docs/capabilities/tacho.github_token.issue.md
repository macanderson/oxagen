# create_github_token

Mint a GitHub App installation token for one repository bound to the calling host's workspace. The enrolled daemon uses this endpoint for its local Git smart HTTP proxy. Git receives a local session lease and does not receive the installation token.

**Surfaces:** api

**Input:** `host_enrollment_id`, repository `owner` and `name`, and `run_token_id`.

**Output:** `token`, `expires_at`, and the repository's `owner`, `name`, `full_name`, and binding `role`.

The deployment must set `OXAGEN_TACHO_GITHUB_BROKER=1`. The host API key must own the named active enrollment, and its creator must still hold the organization Owner or Admin role. The handler resolves the GitHub installation from the workspace connection and narrows the token to the current binding's immutable repository ID with `contents: write` and `metadata: read`. Unbound repositories, invalid IDs, missing connections, and GitHub refusals fail without returning a broader credential.

Enable a local repository with `tacho github configure --repository owner/name --harness claude-code`. Choose `codex`, `cursor`, or `stella` for another enrolled harness. The proxy requires exactly one live session in that directory. Remove the configuration with the same command plus `--remove`.

The credential exists only in the server response and daemon memory. The daemon revokes it after each Git request. Personal credentials and requests outside the configured transport remain outside this custody path. See [ADR-151](../adr/ADR-151-git-custody-keeps-installation-tokens-in-the-host-proxy.md).
