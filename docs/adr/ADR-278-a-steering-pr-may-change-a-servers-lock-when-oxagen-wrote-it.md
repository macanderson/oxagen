# ADR-278: A steering PR may change a server's lock when Oxagen wrote it

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** steering, tools
- **Builds on:** ADR-224 (Studio's Review opens a steering PR for one server folder)
- **Related:** issue #5139, `packages/steering-check/src/checks/owned.ts`,
  `packages/steering-check/src/servers/index.ts` (`lockOutcome`),
  `packages/handlers/src/mcp-studio/import/build.ts`,
  `packages/handlers/src/mcp-studio/discovery/sync.ts`.

## Context

`tools/servers/<name>/tools.lock.json` pins each imported tool's upstream
definition. The MCP Studio spec says only Oxagen writes it: Studio writes it
into the steering PR its Review opens, a sync writes it into the sync PR, and
the owned check refuses a hand edit. The steering repo spec marks the owned
check's lock rule Proposed.

The two lanes built it two ways. The owned check refused every steering PR
that added, changed, or removed a lock. Review and sync each write the lock
into the PRs they open. No test ran a Review folder through the real checks,
so nothing caught it. The MCP Studio live test's first run against production
(run 37066794534) opened a Review PR for each sample server, and the "Oxagen
steering" check failed on them. No Review PR and no sync PR could merge.

The checks read two trees, the PR's head and the production branch. They
cannot see who wrote a commit.

## Decision

The owned check accepts a lock a steering PR adds or changes when the lock is
one Oxagen writes for its folder against the production branch. MCP Studio's
lock reader (`SERVER_READERS.lock`, `lockOutcome`) decides that from the two
trees. A lock Oxagen wrote:

1. is in the form `formatJson()` writes, which `parseLock()` reads,
2. records the source type `server.toml` names,
3. holds an entry only for a tool `tools.toml` imports, and
4. gives each tool the production lock's version while its `definition_hash`
   is unchanged, one more when it changed, and 1 when the production lock has
   no entry for it.

The compile check already reports a lock for another server and an
`upstream_hash` that does not match. It reports a `definition_hash` that
`tools.toml` no longer compiles to as a warning, so a person may still edit
`tools.toml` on a Studio PR.

The owned check still refuses a removed lock. A caller that passes no lock
reader, such as `runChecks` on its own, refuses every change to a lock as
before.

## Alternatives

- **The opener tells the check it wrote the lock.** The opener, the merge's
  re-check, the re-check after the merge queue merges the production branch
  in, and `oxagen check` on a clone would each need that record, and a clone
  has none. A person's commit on top of Oxagen's would carry the mark unless
  every caller tracked commits.
- **The lock must equal the lock recomputed from the head's `tools.toml`.**
  That refuses a person's `tools.toml` edit on a Studio PR, which the spec
  allows and the compile check reports only as a warning.

## Consequences

- Review PRs and sync PRs pass the owned check.
- No check without the network can tell an upstream Oxagen read from one a
  person rewrote and hashed the way Oxagen does. The PR shows that change as a
  diff to its reviewer, and discovery compares the server's live tools with
  the lock and opens a sync PR when they differ.
- A lock built against an older production lock can fail the check at merge
  with a version problem. Opening the Review again, or syncing the server,
  writes it against the current production lock.
