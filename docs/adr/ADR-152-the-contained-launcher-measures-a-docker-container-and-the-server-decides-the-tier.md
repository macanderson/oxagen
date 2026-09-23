# ADR-152: The contained launcher measures a Docker container, and the server decides the tier

- **Status:** Accepted
- **Date:** 2026-09-23
- **Owners:** platform
- **Related:** ADR-043 (runtime excision), ADR-096 (the contained tier; this
  record makes its Phase 5 build choice), ADR-095 (the tier ladder), ADR-094
  (the gateway), ADR-143 (the gateway brokers the vendor credential), ADR-064
  (the witness runner), #3772 (the server half), #3300 (Phase 5)

## Context

ADR-096 made `contained` the top tier and named three controls a launcher
must attest: gateway-only egress, a filesystem policy, and hook integrity at
launch. It left the OS mechanism to the build. #3772 shipped the server half:
`register_contained_launch` stores an immutable receipt for one session, and
ingest promotes a session to `contained` only when the receipt's genesis hash
matches the verified chain and the session shows gateway traffic. #3772 cites
this record for what the launcher measures and trusts. Nobody had written it.

The launcher itself sat on a branch under `packages/tacho/src/contained/`
with two unfinished boundaries: it posted its receipt to a route the API does
not serve, and the daemon promoted a session to `contained` on its own.

## Decision

### The mechanism

The first contained profile is `oxagen-linux-docker-v1`: a Docker container
on Linux, created by an unprivileged user in the `docker` group. Linux CI
runners come first (ADR-096), and GitHub's hosted runners already provide
exactly that. `tacho run --contained -- <claude|codex> [args]` asks the local
`tachod` to launch one run. `oxagen run -- <agent>` delegates to it, and
`oxagen run export` still parses as a subcommand.

The launcher creates the container with:

- `--network none`. The container has a loopback interface and nothing else.
- `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, private
  IPC and cgroup namespaces, and limits of 512 processes, 4 GB and 2 CPUs.
- `--user` set to the launching user's uid and gid, never root.
- Exactly two mounts. The repository root, read-write, at `/workspace`. A
  per-run session directory, read-only, at `/opt/oxagen/session`.

The one way out is a Unix socket in the session directory. Inside the
container, `entry.mjs` relays `127.0.0.1:43801` to that socket. Outside, the
bridge (`contained/bridge.ts`) serves four routes and refuses every other
path with a recorded `contained_gateway_route` denial:

| Route | Where it goes | Credential |
|---|---|---|
| `/model/v1/...` | The loopback model proxy (ADR-094), one harness's paths only | A fifteen-minute run token from the daemon's custody (ADR-143), set by the bridge |
| `/hook` | The daemon's hook handler, with `session_id` and `cwd` pinned to the launched session | None |
| `/mcp` | The local MCP gateway, then the Oxagen API | The host's gateway credential, held by the daemon |
| `/github/...` | `github.com` smart-HTTP git and `api.github.com/repos/<owner>/<repo>`, for one repository, only when the operator supplied a token | The run's installation token, set by the bridge |

No credential crosses into the container. The harness inside holds a
placeholder key. The bridge replaces every inbound credential header.

### What the launcher measures

Before any agent process runs, the launcher:

1. Refuses a workspace that is not the repository root. It also refuses one
   that contains a nested mount, a symbolic link leaving the checkout, a
   hard-linked file, a socket or device, or a credential file (`.env`,
   `.env.local`, `.aws`, `.ssh`, `.netrc`, `.npmrc` and similar). Committed
   templates (`.env.example`, `.env.sample`, `.env.template`) pass.
2. Refuses harness arguments outside a short allowlist, so a flag cannot
   point the harness at another settings file or another endpoint.
3. Writes the hook configuration into the session directory, mode 0400. The
   image links Claude Code's managed settings and Codex's `requirements.toml`
   to those files, and both set managed hooks only.
4. Runs `docker create`, then `docker inspect`, and checks every setting
   above against what Docker reports. A mismatch stops the launch.
5. Computes the measurement: the profile name, the container id, the image
   digest, a digest over the sorted configuration files, and three flags
   (`gatewayOnlyEgress`, `workspaceOnlyWrites`, `readOnlyHooks`).
6. Posts the measurement with the session's chain genesis hash to
   `POST /v1/tacho/contained-launch`, authenticated by the host's gateway
   credential. The route is the sibling of the enrollment's signed ingest
   endpoint.
7. Runs `docker start` only after the API accepts the receipt.

### What decides the tier

The launcher never labels a run `contained`. The daemon reports `gateway` or
lower, as it does for any wrapped session. The control plane computes
`contained` at ingest from three things it holds: a verified chain, gateway
traffic in that chain, and a receipt whose genesis matches the chain's. A run
started outside the launcher on the same machine has no receipt, so it earns
`gateway` at most.

### When a mandate requires it

An agent definition can declare:

```toml
[containment]
required = true
```

The control plane signs `containment: { required: true }` into the host
bundle for a host that advertises the `containment` bundle feature. A host
that does not advertise it is suspended instead, because the strict bundle
schema would force the server to drop the clause and that host would then run
the agent uncontained. In enforce mode, the hook refuses the start, every
prompt, and every tool call of a session the launcher did not start. Observe
mode records the requirement and refuses nothing, as it does for every rule.

The launcher refuses to start when the environment cannot provide the
profile: not Linux, running as root, no Docker, a Docker daemon that is not
Linux, the image missing, an inspect mismatch, or a refused registration (for
example, before migration `20260923230000` reaches the database). There is no
fallback to an uncontained run.

### GitHub access

The operator may supply one GitHub App installation token and name one
repository. The launcher asks GitHub which repositories the token reaches and
refuses it unless the answer is exactly that one. The token stays in the
daemon. The bridge adds it to git and REST requests for that repository and
records each forwarded request as a `contained_github_route` decision. When
the run ends, or the launcher refuses it at any check, the launcher revokes
the token (`DELETE /installation/token`), so it expires with the run rather
than at GitHub's one-hour ceiling. The
receipt's configuration digest covers the repository name, never the token.

Minting the token from the workspace's own App installation on the server,
the `issue_run_github_token` path in `docs/specs/credential-custody/spec.md`,
is a later change. Today the operator mints it, for example with
`actions/create-github-app-token`.

## What the launcher trusts

- The host's kernel and Docker daemon, to enforce the settings they report.
- `tachod` and the user it runs as, to launch what it measured and to report
  the genesis of the chain it writes.
- The enrollment: the gateway credential authenticates the receipt, and the
  API requires the enrolling operator to hold Owner or Admin now.
- The operator's image. The receipt records its digest. Nothing judges
  whether that digest is a good one.
- GitHub, to scope and revoke the installation token as documented.

## What a hostile host administrator can still do

`contained` is enforced against the agent and every process it starts. It is
not enforced against whoever administers the host. Membership in the
`docker` group is root on that machine. Such a person can:

- Run a modified `tachod` that registers a measurement for a process it never
  confined. The receipt is the launcher's attestation. No hardware or remote
  attestation signs it. The genesis binding stops a receipt from being reused
  for another session, and it does not stop a malicious launcher.
- Change the container after it was measured: `docker network connect`,
  `docker exec`, or a new mount through the daemon. The measurement describes
  the container at creation.
- Read the vendor key from custody, which stays on the machine (ADR-143), and
  the GitHub token while the run is live.
- Build a different image. Its digest lands in the receipt, and nothing
  compares it with a known-good list.
- Stop the daemon or drop events before they ship. The record shows silence,
  not a violation.

Two gaps remain against the agent itself:

- The agent can write anything under `/workspace`, `.git/hooks` included. A
  git command the host later runs in that checkout runs those hooks outside
  the container. The CI example uses a checkout it discards after the run.
- The model and MCP routes are open for the run's life. What the agent sends
  through them is governed and metered by the gateway, not refused by the
  container.

## Consequences

- #3772's receipt now has a writer, and ingest can compute `contained` for a
  run the launcher started.
- `docs/VISION.md` no longer calls the tier unbuilt.
- `.github/workflows/contained.yml` runs the Docker test on every change to
  `packages/tacho`, and its `contained-run` job waits on the repository
  variable `OXAGEN_CONTAINED_ENABLED`, set once the migration is confirmed in
  production.
- The witness runner (ADR-064, item 5 of #3300) is not built here. It can run
  as a workload on this launcher.
- A second profile (gVisor, Firecracker, or a macOS mechanism for managed
  devices) gets a new profile name and a new measurement literal. The contract
  pins `oxagen-linux-docker-v1` today.

## Alternatives considered

**bubblewrap, nsjail or Landlock on the bare runner.** Rejected for the first
profile. Each needs user namespaces or kernel features that hosted runners do
not configure the same way, and none gives a single inspectable record of the
settings in force the way `docker inspect` does.

**gVisor or Firecracker.** They hold against a stronger attacker inside the
sandbox. Neither is on a hosted runner by default, and neither changes what a
host administrator can do. They fit a later profile.

**Let the daemon label the run.** Rejected, and removed from the branch. A
label the host writes is a label the host owner can write. The server
computes the tier from the receipt and the chain.

**Put the GitHub token in the container.** Rejected. A token inside the
sandbox leaves with the first request the agent makes to any route that
echoes it, and the bridge already has to forward the traffic.
