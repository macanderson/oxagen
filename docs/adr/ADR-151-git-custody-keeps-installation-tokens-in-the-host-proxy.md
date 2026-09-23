# ADR-151: Git custody keeps installation tokens in the host proxy

Status: Accepted

## Context

A wrapped harness can push with its operator's personal GitHub credential. Model credential custody does not govern that credential. Returning a GitHub installation token from a Git credential helper would still place the vendor token inside the harness's Git process.

## Inventory

Before this record, `tacho enroll` wrote nothing that touches Git. Each harness pushed with whatever its operator's account already held. The table lists what a wrapped session could push with on 2026-09-23.

| Source | Claude Code | Codex | Cursor | Stella |
|---|---|---|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN` in the environment | inherited from the launching shell | inherited from the launching shell | inherited from the IDE or `cursor-agent` shell | stripped from tool subprocesses |
| `~/.config/gh/hosts.yml` through `gh` and `gh auth git-credential` | readable | readable | readable | readable |
| Git credential helpers (`~/.gitconfig`, the system gitconfig, such as Homebrew's `osxkeychain`) | used | used | used | used |
| `~/.netrc` | used by Git over HTTPS | used by Git over HTTPS | used by Git over HTTPS | used by Git over HTTPS |
| SSH keys and `ssh-agent` | used for `git@github.com:` remotes | used | used | used, though `GIT_SSH_COMMAND` is stripped |
| What `tacho enroll` writes | `settings.json` hooks and `apiKeyHelper` | `hooks.json` | `~/.cursor/hooks.json` | hooks only |

Stella's subprocess filter drops every variable ending in `_TOKEN` and the `GIT_CONFIG_*` family (`stella-tool-facts/src/subprocess_env.rs`). So a Stella tool call cannot see `GH_TOKEN` or a redirected global Git config. It can still reach every file-based credential in the other rows. The only Git control the other three harnesses had was a policy rule such as `Bash(git push*)`, which denies the push outright (`packages/tacho/src/host/bundle.ts`).

Custody is a repository-local remote rewrite, so it works the same way in all four harnesses. Stella's filter does not reach `.git/config`.

## Decision

An operator opts a local repository into custody with `tacho github configure --repository owner/name --harness claude-code`. Codex, Cursor, and Stella use the same command with their harness name. The deployment also sets `OXAGEN_TACHO_GITHUB_BROKER=1`.

The command replaces exact repository-local remote URLs for that repository's HTTPS and SSH remotes. It saves their original values in the host file. A similarly named repository does not match. The replacement URL reaches the loopback daemon's Git smart HTTP proxy. A proxy-specific credential helper clears inherited helpers for that URL and obtains a random local lease. Personal GitHub credentials and unrelated remotes stay in their existing configuration.

The lease expires after at most 15 minutes. It names one repository and one live session belonging to the chosen harness in that working directory. Zero sessions or multiple sessions refuse the mint. Each request rechecks enrollment status, session state, lease expiry, and the signed mandate. Pause, cancel, sealing, and enrollment expiry refuse later requests. The proxy also aborts an in-flight request when those local states change.

The server resolves the host's immutable tenant scope and live workspace repository binding. The key creator must still hold the organization Owner or Admin role. It chooses the installation from that workspace's GitHub connection. It mints an uncached installation token with `repository_ids` containing only the binding's immutable repository ID and permissions `contents: write` and `metadata: read`. Neither the caller nor a stale repository name can select a broader installation grant.

The daemon keeps that token in memory, replaces the local lease with GitHub authentication, and streams the request. It accepts only discovery and upload/receive pack routes for the leased repository. It refuses redirects, caps request bodies at 128 MiB, and revokes the installation token after each request. A failed revocation is logged without credential content. GitHub's expiry remains the final ceiling if revocation cannot reach GitHub.

Before forwarding, the daemon records a `token_use` event on the session chain with `gateway_brokered`, the run token ID, and the repository. Completion records the HTTP status. HTTP success does not claim that GitHub accepted the ref update. Git's protocol response carries that result.

The host records the Git settings it owns. `tacho github configure --remove` removes them for one repository. Unenrollment removes recorded proxy settings before stopping the daemon. If a helper changed or a repository cannot be reached, unenrollment stops and names the directory that needs repair.

## Personal tokens

A personal token the operator already holds stays where it is. Tacho neither takes it into custody nor refuses to enroll because of it. A push that reaches GitHub without the proxy is harness-held. Three options were weighed.

- **Take it into custody.** Model custody can hold the vendor key because the gateway proxies every model call. The gateway does not proxy the GitHub API, and the same token serves `gh`, other editors, and the operator's own terminal. Moving it out of `hosts.yml`, the keychain, or `.netrc` would break each of those and still leave SSH keys in place. Custody of the model key worked because Oxagen could serve every use of it. Oxagen cannot serve every use of a GitHub token.
- **Refuse to enroll.** Nearly every developer machine carries `gh` authentication or a keychain entry for GitHub. Refusing would stop rollout on the first machine and prove nothing, because the operator could log back in after enrolling.
- **Leave it in place.** This is the choice. A configured repository's remote points at the proxy, so a plain `git push` in the harness goes through custody. The run then shows a `token_use` frame with `gateway_brokered` beside the `git_push` command. A push that bypasses the proxy shows the `git_push` command with no brokered `token_use` frame. Examples include a URL with an embedded token, a new remote, `gh` calls to the API, and an SSH remote the operator adds back. The `git_push` command frame carries `oxagen.credential_basis` too (#3788). It says `gateway_brokered` when the push ran in a configured directory and every push URL Git reports for its remote is the proxy URL. Otherwise it says `harness_held`. The daemon decides this from the hook's command line, the custody receipt, and `git remote get-url --push --all` (`packages/tacho/src/collector/push-basis.ts`). Like every hook record it is client-attested (ADR-040 section 4). The `token_use` frame is the daemon's own proof that the proxy carried the push, and the record claims no more than those two frames show.

To make a bypass impossible rather than visible, pair custody with a policy that denies the paths the proxy does not cover, and remove the personal credential from the machine the agent runs on.

## Boundary

This is an opt-in transport path. A process with the operator's filesystem access can read personal credentials, alter Git configuration, or call another remote outside this path. Such a push remains harness-held and has no brokered-custody claim. The proxy does not revoke the operator's personal token. A daemon crash discards local leases, and a vendor token minted just before that crash remains valid until GitHub expires it.

The local lease proves which live session the configured helper selected. It does not isolate mutually untrusted processes running under the same operating-system account. For this reason the helper refuses an ambiguous working directory rather than guessing an agent.

## Verification

Proxy tests use a real loopback HTTP listener and session registry. They assert streamed Git bytes, daemon-only vendor authentication, revocation, repository/protocol refusal, signed-policy refusal, expiry, stopped-session checks, and redirect refusal. CLI tests use an isolated real Git repository and show that only the selected remote is rewritten, personal helpers survive, configuration is idempotent, and removal restores routing. Server tests check host authorization, current tenant bindings, immutable repository IDs, feature flags, input validation, and the kernel adapter.

References: [Git smart HTTP protocol](https://git-scm.com/docs/http-protocol), [GitHub installation token revocation](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token), and ADR-143.

Git custody requires a standalone checkout. A linked worktree shares Git configuration with its siblings, so configure and lease issuance refuse a repository with multiple worktrees. Remove custody before adding worktrees, or use a separate clone. Token minting uses a separate rate-limit bucket from pause and cancel polling. Valid custody receipts survive a malformed host file so unenrollment can restore repository URLs before stopping the daemon.
