# ADR-254: A contained run reaches GitHub through Git custody, and the operator holds no token

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** platform
- **Related:** ADR-151 (Git custody), ADR-152 (amended: its route table and
  its GitHub section), ADR-143 (the gateway brokers the vendor credential),
  #3815, #3813

## Context

ADR-152 let a contained run reach one GitHub repository. The operator minted
an installation token, for example with `actions/create-github-app-token`,
and passed it in `OXAGEN_CONTAINED_GITHUB_TOKEN`. The launcher checked that
the token reached only that repository. The bridge added it to Git smart HTTP
requests and to REST calls under `/repos/<owner>/<repo>`, and the launcher
revoked it when the run ended.

ADR-151's Git custody is stronger. The server mints the token from the
workspace's own GitHub App installation. It narrows the token to the bound
repository's immutable ID with `contents: write` and `metadata: read`. The
daemon holds the token for one request, revokes it, and records a
`token_use` frame with `gateway_brokered` on the session's chain.

The operator path had three problems:

- The operator handled a GitHub token on every run.
- The token carried whatever the operator minted. `create-github-app-token`
  grants every permission the App holds unless the workflow names fewer, and
  the REST route forwarded any path under the repository with it, settings
  and webhooks included.
- The chain recorded a `contained_github_route` allow, not a brokered use.

The bridge could not use ADR-151's lease as it stood. That lease is issued
for the one live session in a working directory, through a credential helper
and a remote rewrite to the daemon's loopback port, and only for a checkout
that `tacho github configure` recorded. Inside the container neither the
working directory nor the port is the host's. A CI checkout has no such
record.

## Decision

### Git route

When a run names a repository, the bridge sends that repository's Git smart
HTTP requests (`/github/git/<owner>/<repo>/...`) to the ADR-151 proxy in the
same daemon. The proxy treats them as it treats a configured checkout's
requests:

1. It checks the signed mandate, as a `git push` or `git fetch` of that
   repository.
2. It asks the server to mint a token for the workspace's binding of the
   repository.
3. It records `token_use` with `gateway_brokered` and the lease ID on the
   launched session's chain.
4. It streams the request to GitHub, revokes the token, and records the HTTP
   status.

### Lease handoff

The lease never enters the container. The bridge already belongs to one
session: the launcher starts it for that session, on a Unix socket in the
run's private session directory. On each Git request the bridge:

1. asks custody for a lease for that session's ID (`issueForSession`),
2. puts the lease in the request's `authorization` header, on the host side,
3. hands the request to the proxy, and
4. drops the lease when the request ends (`release`).

The container sends no credential, and any it sends is discarded, as on every
other bridge route.

`issueForSession` refuses unless the enrollment is active and unexpired, the
repository name is well formed, and the session is live: not sealed, ending,
paused, or cancelled. It does not look the session up by working directory,
and it reads no custody record. The proxy checks the session and the
enrollment again on each request and while a request streams, as it does for
an ADR-151 lease. No HTTP route reaches `issueForSession`. Only the bridge
calls it, inside the daemon.

Issue #3815 proposed writing the lease into the read-only session directory.
The bridge holds it instead, for three reasons:

1. A credential inside the sandbox is one the agent can send elsewhere. That
   is why ADR-152 kept the GitHub token out, and a lease is no different.
2. The launcher hashes the session directory's files into the configuration
   digest the server stores. A lease there would put a new secret into the
   measured configuration on every run.
3. A lease lives 15 minutes, and the launcher writes those files once, before
   the container starts. A longer run would lose Git at minute 15. A lease per
   request has no such limit.

### Custody switch

ADR-151 has two switches. On the host, `tacho github configure` turns on
`github_broker_enabled` for a configured checkout. A contained run opts in by
naming its repository at launch instead, so a lease for the launcher's session
does not need that flag. On the server, the
[`OXAGEN_TACHO_GITHUB_BROKER`](../../packages/config/src/registry.ts) setting
still gates every mint. The server still mints only for a repository bound to
the host's workspace, still refuses the steering repository, and still
requires the key's creator to hold Owner or Admin.

### Push record

ADR-151 (#3788) puts `oxagen.credential_basis` on each recorded `git push`
command. It says `gateway_brokered` only for a push in a checkout that
`tacho github configure` recorded, so a contained run's push read
`harness_held` even when custody carried it. For a session the contained
launcher started with a repository, the daemon now judges the push against
that repository instead. The push is `gateway_brokered` when it ran in the
run's checkout and every push URL Git reports is the run's repository on
`https://github.com/`. Inside the container, Git can reach that URL only
through the bridge and custody. The host reads the same `.git/config` the
container writes, so a remote the agent pointed elsewhere reads
`harness_held`. As before, the basis is client-attested, and the `token_use`
frame is the daemon's own proof.

### Operator token

The daemon no longer accepts a token in a contained run request. The CLI no
longer reads `OXAGEN_CONTAINED_GITHUB_TOKEN`, and it refuses to start while
the variable is set, so a workflow that still mints a token learns that the
token goes unused. Two options were weighed.

- **Keep it for a workspace with no GitHub binding.** The daemon cannot tell
  a bound repository from an unbound one without asking the server to mint.
  The path would stay open for bound repositories too, which is the case
  #3815 closes. Two paths with different credentials, permissions, and
  records would also double the tests and the docs.
- **Remove it.** This is the choice. A workspace that wants a contained run to
  reach GitHub binds the repository and attaches the GitHub App on the
  Repositories page. The record then names a binding too.

### REST route

The bridge no longer forwards `/github/api/...`, and the container no longer
gets `GITHUB_API_URL`. Three options were weighed.

- **Keep it on an operator token.** That needs the path this record removes.
- **Route it through custody in a narrowed form.** Custody mints
  `contents: write` and `metadata: read`. Every repository change that grant
  allows over REST, Git already carries. Pull requests, issues, and comments
  need more permissions, and what the server mints for them is a separate
  decision. A later record can add a REST route with its own permission set
  and its own list of allowed paths, if a contained workload needs one.
- **Remove it.** This is the choice. It also closes the widest part of the old
  route: any path under the repository, with any permission the operator's
  token held.

## Consequences

- A contained run that names a bound repository fetches and pushes with no
  GitHub token in the operator's hands, and its chain carries `token_use` with
  `gateway_brokered`. Its `git push` command frames say `gateway_brokered`
  too.
- When the workspace has not bound the repository, Git shows the server's
  refusal to the agent as `remote:` lines, and nothing reaches GitHub.
- When custody issues no lease, the bridge answers 403 in plain text and
  records a `policy_decision` deny with the reason `contained_github_custody`.
- `contained_github_route` is no longer recorded. The proxy's `token_use` and
  `tool_call` frames carry each request.
- The configuration digest still covers `github.json`, which names the
  repository and holds no credential.
- Mixed versions refuse rather than run with a token. A new daemon refuses a
  request that carries a token, and an older daemon refuses a request that
  carries none.
- ADR-152's host administrator can still read a GitHub token from the daemon,
  but only while one Git request is in flight, because each token is revoked
  when its request ends.

## Verification

- `packages/tacho/src/contained/github.test.ts` runs the bridge against the
  real custody proxy on a host that never ran `tacho github configure`. A push
  reaches GitHub with the minted token, the token is revoked, and the launched
  session's chain carries `token_use` with `gateway_brokered`. A sealed or
  paused session and a suspended enrollment are refused before any mint. A
  double of the proxy shows the rewritten path, the lease in place of the
  container's credential, the release after the request, and the refusal when
  no lease is issued.
- `packages/tacho/src/collector/github-proxy.test.ts` covers
  `issueForSession` and `release`, and shows a configured checkout's lease
  still needs its record.
- `packages/tacho/src/contained/runner.test.ts` shows the bridge gets a lease
  keyed by the launched session, the run calls no GitHub API, and a request
  carrying a token is refused.
- `packages/tacho/src/cli/run.test.ts` shows the CLI sends no token and
  refuses while `OXAGEN_CONTAINED_GITHUB_TOKEN` is set.
- `packages/tacho/src/collector/push-basis.test.ts` covers a contained run's
  push: `gateway_brokered` for the run's repository, `harness_held` for
  another repository, an SSH or local remote, a URL with a token in it, and a
  directory outside the checkout. `hook-handler.test.ts` shows the hook names
  the harness session to the reader.
