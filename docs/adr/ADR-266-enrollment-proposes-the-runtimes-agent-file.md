# ADR-266: Enrollment proposes the runtime's agent file

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** steering, tacho
- **Builds on:** ADR-265 (every steering PR carries a proposal row)
- **Related:** issue #5149, issue #5122, issue #5139,
  `packages/handlers/src/steering-repo/agent-file.ts`,
  `packages/handlers/src/tacho.enrollment.create.ts`,
  `packages/oxagen/src/steering-repo/agent.ts`,
  `apps/mcp/src/servers/snapshot.ts` (`matchAgent`).

## Context

The MCP gateway serves a workspace's published tools only to a run it can
match to an agent file, `agents/<name>.toml` (agent/v1), in the steering
repository. `matchAgent` matches by the run's runtime, which the host's
gateway key names, and by the session's harness when several agent files
share the runtime. Nothing in Oxagen wrote an agent file for a new workspace.
The only writer was the legacy converter, which runs once when an old
workspace moves to a steering repository. So in a workspace created today,
every served tool call was refused: "Oxagen matched no agent to this run".

Mac decided on 2026-10-02 that enrollment opens the agent file PR. When a
host enrolls through `create_tacho_enrollment`, Oxagen opens a steering PR
that adds the file for the host's runtime, with the operator who enrolled it,
the runtime, and the harness when known. It carries a proposal row, so Oxagen
merges it, and a person still merges it. Enrolling the same runtime again
opens no second PR while one is open or merged. The file carries no secret,
and `toolbelt`, `budget`, and `environment` stay refused.

Two details were left open: how the file names its operator, and which harness
it names for a host that reports several.

## Decisions

### 1. One agent file per runtime, named after the runtime

The file is `agents/<runtime slug>.toml`, and its `name` is the runtime's slug
(`agentNameForRuntime`). A runtime slug is lowercase letters, digits, and
hyphens, so it is a valid agent name. A slug that is not opens no PR, and the
reason is logged.

One file per runtime matches the decision's wording, and it keeps the gateway
able to match without a session. `matchAgent` matches the one agent on a
runtime whatever the run's harness. With two agent files on a runtime it needs
the session header to name a harness. A client that sends no session header,
such as a plain MCP client using the host's gateway key, would then match no
agent.

### 2. The operator is the member's public user id

Oxagen has no member handles. A user row carries an email, a display name, and
a public id. The file names its operator by the enrolling member's public id,
`usr_` and 22 lowercase characters, which fits agent/v1's `operator` pattern.
The public id never changes, names one person, and puts no personal data in
the customer's repository.

The references check resolves an agent file's `operator` against the
organization's members. That list was always empty, so every agent file
failed the check. `readCheckContext` now lists each member of the organization
by public id. Cedar reads `operator` as an attribute. The role a policy
decides on comes from the host's enroller at request time, not from the file,
so the id's form changes no decision.

When Oxagen gains member handles, the check can accept a handle or a public
id, and the files already written stay valid.

### 3. The harness is the first one the host reports that agent/v1 names

A host reports a list of harnesses. agent/v1 names one. The file names the
first harness in the host's own order that agent/v1 knows. Claude Desktop is a
harness a host can report and an agent file cannot name, so a host that
reports only Claude Desktop gets no file.

A host that reports several harnesses gets one file naming the first. Its PR
body says so, and a person can change `harness` before merging. This is an
approximation: a Cedar policy keyed on `principal.harness` sees the named
harness for every run on the runtime.

### 4. When enrollment opens no PR

Before it writes anything, the opener checks, in this order:

1. An `agent_file` proposal on `agents/<name>` that is open or merged. If one
   exists, enrolling the same runtime again opens nothing. A closed one does
   not count, so a later enrollment can open a new PR.
2. The production branch already holds `agents/<name>.toml`.
3. Another agent file on the production branch names this runtime. A second
   file would stop `matchAgent` matching either one without a session.
4. The workspace has no steering repository, or it is not in the steering
   layout.

### 5. Enrollment never fails on the PR's account

The PR opens after the enrollment transaction commits, in the same request.
Any refusal or error is logged as `agent file:` and the enrollment answers as
it always did. A person can still add the file by hand through a steering PR.
The enrollment's output does not change.

The opener runs the steering checks before the PR opens, so a slow steering
host could hold the enrollment's answer. Enrollment waits up to 20 seconds.
Past that it answers, and the PR keeps opening on the server and logs how it
ends. In the usual case the PR is open by the time enrollment answers, which
the MCP Studio live test relies on.

The PR goes through the shared steering PR opener with its own kind,
`AGENT_FILE_PULL_REQUEST`, on an `agents/` branch. It gets the steering check
and the `agent_file` proposal row ADR-265 gives every steering PR, and
`merge_context_pr` lands it through the merge queue.

## Consequences

- A workspace created today can enroll a host, merge the agent file PR from
  Oxagen, and serve its published tools to that host's runs.
- `get_steering_index` now returns the organization's members by public id, so
  `oxagen check` resolves an agent file's operator the same way the server
  does.
- A host that reports several harnesses is served under one agent file. Two
  files on one runtime would need a session header on every request, which
  this decision avoids.
