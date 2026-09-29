# ADR-224: Studio keeps a draft, and Review opens a steering PR for one server folder

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** platform, tools
- **Related:** issue #4686 (lane M11), PR #4688 (merged as 9372813da), PR
  #4721 (the tests, this record, and five fixes from #4688's review),
  ADR-217 (a search-mode server ranks its tools), ADR-219 (the steering
  import), M10's sync (#4711), M3's gRPC import (#4689), M5's tool checks, and
  M8's credential rule.

## Context

Studio imports a server's tools, sorts them, and shapes them. Before this
change, those edits lived in one browser tab. A closed tab lost them, and
nothing wrote `tools/servers/<name>/` to the steering repo, so a reviewer
never saw them.

M10's sync and M13's server folder writer change the same folder. Each needs
to write many files in one commit and open a steering PR. Three writers with
three write paths would drift apart on branch rules, file limits, labels, and
the required check.

M8's rule holds for everything Studio writes: a credential never reaches a
steering PR, a draft row, a log line, or a PR body.

## Decision

1. **Oxagen keeps one draft per server folder.** The draft is one live row in
   `mcp.studio_drafts` (migration 20260928160000), with row-level security and
   the `msd` public id prefix. It holds the ops a person staged, `server.toml`,
   and the source the ops import from. `save_studio_draft` writes it,
   `get_studio_draft` reads it, and `open_studio_review` turns it into a
   steering PR. A draft holds at most 2,000 edits in 8 MiB, a 256 KiB
   `server.toml`, and a 25 MiB source. Each size counts UTF-8 bytes, the unit
   the table's `octet_length` check counts. The API refuses a save body over
   36 MiB before it parses it.
2. **A save names the revision it builds on.** Revision 0 starts a draft and
   never overwrites one. Revision N saves only when the live draft is at N,
   and otherwise answers `conflict` (`draft_revision_stale`). A save with no
   revision saves over whatever is stored. A soft-deleted draft does not
   count as live. Each save raises the revision by one, and recording the PR
   does not.
3. **The draft holds no credential.** The save refuses a test whose request
   carries an `authorization`, `proxy-authorization`, or `cookie` header.
   `server.toml` names a credential by reference only
   (`oxagen:credential/<name>`). A saved test keeps the request as Studio
   built it, before the gateway added a credential. Every check runs before
   the write, so a refused save stores nothing.
4. **Review builds the folder from inputs.** Review reads the draft and
   refuses when there is none or its revision is stale. It resolves the
   production branch to one commit, reads the folder's files at that commit,
   and imports the draft's source again. gRPC
   uses M3's `importGrpc` from `@oxagen/mcp-studio`. The build writes
   `server.toml`, `tools.toml`, `tools.lock.json`, the vendored definition
   (`openapi.yaml`, `schema.graphql`, or `proto/`), and `tests/calls.jsonl`.
5. **Review refuses an unclassified tool.** The build refuses while an
   imported tool has no `risk`, `side_effect`, or `egress`, and while the
   folder does not compile or lock. The steering PR never carries a tool a
   reviewer cannot judge.
6. **One branch per server folder.** Review writes to `tools/<server>`. When a
   steering PR is already open on that branch, Review adds a commit to it
   instead of opening a second PR. The commit holds only the files that
   differ from the branch, which Review reads at one commit. When that
   branch moves before the write, Review answers `conflict`
   (`tools_branch_moved`). When nothing differs, Review answers `conflict`
   (`draft_unchanged`). When the recorded PR is gone, Review opens a new one.
   Review records the PR on the draft.
7. **The PR body shows what a reviewer judges.** It lists the imported,
   removed, and reclassified tools, the changed descriptions, and the saved
   tests. It gives the definition's token total against the budget and M5's
   findings, errors first, then warnings, then info. Each list shows at most
   200 tools. A body over 60,000 characters falls back to shorter lists, and
   then stops with a line that points to the `Oxagen steering` check.
8. **Every tools steering PR goes through one opener.**
   `packages/handlers/src/tools.pr.open.ts` writes Studio's Review, M10's sync
   (`ToolsPullRequestOpener`), and M13's writer (`createSteeringPrOpener`). It
   refuses a branch outside `tools/`, a path outside the branch's folder, more
   than 299 files, and a repository without `steering/governance.toml`. It
   creates a new branch at the commit the caller built the files against
   (`at`), or at the production head when the caller names none. It refuses
   a branch that already exists, so two writers never share one. It commits
   every file in one commit and labels the PR with `OXAGEN_PR_LABELS`. When
   the create call fails, it looks for an open PR on the branch first,
   because the host can open the PR and still fail the call. It adopts a PR
   it finds. It deletes the branch only when no PR exists, so a retry can
   create it again. When the lookup fails too, it keeps the branch. It
   reports the `Oxagen steering` check on the new head.
   When that report fails, it logs the failure and still answers the open
   PR. It works on GitHub and GitLab through the steering host.

## Consequences

- A person can close the tab and come back to the same edits. Two tabs that
  save the same draft conflict on the revision, and the second tab reads the
  draft again.
- `mcp.studio_drafts` holds edits Oxagen has not reviewed. The steering repo
  stays the record of what production runs.
- A Review after the steering PR merges finds nothing new to commit. The build
  does not add a recorded call that production already holds.
- A source that only an unbuilt importer reads makes Review answer
  `importer_not_built`.
- A new writer of `tools/servers/<name>/` calls the shared opener. It does not
  open a steering PR by itself.
- A merge that lands on production during a Review stays in the steering PR's
  base, and the PR never undoes it. The PR can start behind production, and
  the host shows it as out of date.
- A steering PR whose check report failed has no `Oxagen steering` check, so
  it cannot merge. A push to its branch reports the check again.
