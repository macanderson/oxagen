# agent.sandbox.start

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** yes (riskLevel: high)

## Intent

Provision or reconnect to a **durable** code-agent sandbox that persists
filesystem and process state across multiple agent turns. Unlike the one-shot
`agent.code.execute`, a durable sandbox survives between calls — the agent can
clone a repository in one exec, install dependencies in a second, build a
feature in a third, and open a PR, all without losing the working tree.

**Session reuse:** pass a stable `sessionKey` (e.g. the conversation or
agent-run id) and repeated `agent.sandbox.start` calls return the same warm
sandbox (`reused: true`). If the backing sandbox was reaped while idle but a
filesystem snapshot exists, it is restored transparently. Omit `sessionKey` to
always provision a fresh session.

## Input

| Field                | Type                                          | Default   | Notes                                                                                                                                  |
| -------------------- | --------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `image`              | `"node" \| "python" \| "shell" \| "agent"`    | `"agent"` | Base image. `"agent"` = Debian + git + curl (default for repo workflows); others are language bases, all with git pre-installed.      |
| `sessionKey`         | `string?`                                     | undefined | Stable key to reuse a warm (or snapshot-restored) sandbox across turns. Omit to always create a fresh session.                        |
| `memoryMb`           | `integer`                                     | `2048`    | Memory limit in MiB (256–8192). Durable build sandboxes default higher than the one-shot executor.                                    |
| `ttlSeconds`         | `integer`                                     | `86400`   | Hard ceiling on total session lifetime in seconds (300–86400, max 24h).                                                               |
| `idleTimeoutSeconds` | `integer`                                     | `1200`    | Reap the sandbox after this many seconds of inactivity (60–86400). Primary cost control — a reaped session restores from its last snapshot on next exec. |
| `network`            | `"allow" \| "deny"`                           | `"allow"` | Network policy. Durable build sandboxes default to `"allow"` so they can clone repos and install dependencies.                        |
| `setupCmd`           | `string?`                                     | undefined | Optional shell command run once at create time (e.g. `git clone … && pnpm i`). Skipped on warm reuse. Runs with the session's trusted env injected (see notes). |
| `repos`              | `Array<{ owner, repo, branch? }>?`            | undefined | Up to 8 GitHub repos to clone into `/workspace` at provision time using the workspace's GitHub connection. Full clone into `/workspace/<repo>` (a name collision gets an `-<owner>` suffix); `branch` pins with `--branch --single-branch`. The generated clone script is prepended to `setupCmd`; a failed clone fails provisioning. See notes. |

## Output

| Field       | Type                                         | Notes                                                                     |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `sessionId` | `string`                                     | Opaque durable-session id (`sbx_…`); pass to `agent.sandbox.exec`.       |
| `status`    | `string`                                     | Current session status (e.g. `"running"`, `"starting"`).                 |
| `image`     | `"node" \| "python" \| "shell" \| "agent"`  | Base image in use.                                                        |
| `createdAt` | `string`                                     | ISO 8601 creation timestamp.                                              |
| `reused`    | `boolean`                                    | `true` when an existing warm or snapshot-restored session was returned.   |

## Side effects

- Provisions a long-lived container on the configured sandbox driver (Modal).
- Charges against the org's sandbox compute budget while the session is alive.
- Runs `setupCmd` once at create time when a fresh session is provisioned.
- Clones any `repos` into `/workspace` at create time (script prepended to `setupCmd`).

## API

```
POST /v1/{org}/{workspace}/agent/sandbox/start
Content-Type: application/json

{
  "image": "agent",
  "sessionKey": "conv_abc123",
  "memoryMb": 4096,
  "network": "allow",
  "setupCmd": "git clone https://github.com/example/repo /workspace && cd /workspace && pnpm i"
}
```

Response:

```json
{
  "sessionId": "sbx_01abc...",
  "status": "running",
  "image": "agent",
  "createdAt": "2026-06-28T12:00:00Z",
  "reused": false
}
```

## MCP

Tool name: `agent.sandbox.start`

## Notes

- Requires `SANDBOX_ENABLED=true` and a session-capable driver (`SANDBOX_DRIVER=modal`).
- The `idleTimeoutSeconds` is the primary cost control — set it tightly for
  short-lived workflows and loosely for multi-hour builds.
- Pair with `agent.sandbox.snapshot` at meaningful milestones (repo cloned,
  deps installed) so idle reaps do not lose work.
- Explicit `agent.sandbox.stop` when done is preferred over relying on idle reap.

### Cloning private repositories in `setupCmd`

`setupCmd` runs with the same **trusted env** every later `agent.sandbox.exec`
sees: the bound environment's vault secrets plus a sandbox template's literal
env (lowest precedence). To clone a private repo at create time, store a token
(e.g. `GITHUB_TOKEN`) in the workspace environment's vault, bind the
environment via `environmentId` (or a template), and reference it:

```sh
git clone https://x-access-token:$GITHUB_TOKEN@github.com/org/repo /workspace/repo
```

Git terminal prompts are disabled during setup (`GIT_TERMINAL_PROMPT=0`), so an
unauthenticated clone of a private repo fails immediately with
`terminal prompts disabled` — surfaced as HTTP 422 from the runner (a caller
command failure, not runner ill-health) — instead of dying with the cryptic
`could not read Username for 'https://github.com': No such device or address`.
For agent-driven repo workflows, prefer the managed `repos` path (below) over
hand-rolling tokens in `setupCmd`.

### Cloning repositories at provision time (`repos`)

Pass up to 8 GitHub repositories as `repos` (each `{ owner, repo, branch? }`) and
provisioning composes a deterministic clone script server-side, prepended (via
`&&`) to any `setupCmd`:

- **Managed credential.** The workspace's GitHub connection token (App
  installation → per-workspace OAuth → dev PAT, per ADR-020) is resolved
  server-side and handed to the clone over the trusted `setup_env` channel as
  `$GITHUB_TOKEN`. It is **never** written into the setup script text and **never**
  persisted on the session. When no connection resolves, public repos still clone
  anonymously (a private repo then fails fast → HTTP 422).
- **Opinionated layout.** Each repo is cloned with full history into
  `/workspace/<repo>`; a name collision is disambiguated with an `-<owner>`
  suffix. A `branch` clones with `--branch <branch> --single-branch` (work can
  still be pushed).
- **No credential on disk.** After each clone the `origin` remote is rewritten to
  a token-free `https://github.com/<owner>/<repo>.git`, so no token lingers in
  `.git/config`.
- **Fail loud, not half-provisioned.** The clone chain is joined with `&&`, so a
  failed clone short-circuits and exits non-zero — provisioning returns the
  runner's 422 rather than a half-provisioned sandbox.
- **Listed.** The requested repos (owner/repo/branch only) are recorded on the
  session and surfaced per row by `list_sandboxes`.

Owner and repo are restricted to `[A-Za-z0-9_.-]` (and may not be `.`/`..`);
branch names may not contain whitespace, shell metacharacters, or a leading `-`.

```json
{
  "image": "agent",
  "repos": [
    { "owner": "acme", "repo": "api", "branch": "main" },
    { "owner": "acme", "repo": "web" }
  ],
  "setupCmd": "cd /workspace/api && pnpm i"
}
```
