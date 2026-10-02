# ADR-253: Code repository findings are stored when the check runs

- **Status:** Accepted. The agent building lane S7 chose this under SCR-002.
  Mac has not ruled on it.
- **Date:** 2026-10-02
- **Owners:** steering
- **Related:** issue #4518 (lane S7, with the boxes it absorbed from #4529),
  #5058 and #5112 (lane S2b, the Oxagen check on linked code repositories),
  `docs/specs/repository-binding/README.md` §3.5, ADR-061, ADR-212.

## Context

Since #5112, every pull request in a code repository that a workspace links
gets the `Oxagen` check. The check reads the instruction files the pull
request changes (AGENTS.md, CLAUDE.md, `.cursor/rules/`, and the rest in
`code-repo-check/instruction-files.ts`), keeps the statements the head adds,
and compares them with the workspace's active steering records. A statement
that says the same thing as a record is a repeat. A statement that says the
opposite is a contradiction. The check posts its findings on the pull request
and keeps nothing.

The Repositories page lists these findings, with Promote to steering beside
each one, through `list_code_repository_findings`. That read needs the
findings from somewhere. There are two ways to get them:

1. **Compute on read.** Each call reads every linked repository's instruction
   files from GitHub or GitLab and compares them again.
2. **Store at check time.** The check writes what it found to Postgres, and
   the read answers from there.

Three facts decide it.

- **The read has no credential.** The check reads a repository with the
  GitHub App installation token or the GitLab project token that the webhook
  delivery names (`code-repo-check/deps.ts`). A page view, an MCP call, or a
  CLI call has no delivery, so it has no token for a linked repository.
- **The check already holds the diff.** The check knows which lines a pull
  request adds. A read of the default branch would see every line in every
  file and flag lines that no pull request touched, which is a different
  check from the one people see on their pull requests.
- **Host reads are slow and rationed.** A read that walks each linked
  repository's files spends the installation's hourly API budget on every
  page view, and an outage at the host empties the page.

## Decision

1. **The check stores its findings.** Each run writes the statements it
   flagged to `agent.code_repository_findings`, one row per statement, in the
   workspace's tenant scope. A row holds the facts only the host can give: the
   repository, the pull request, the commit the check read, the file, the
   line, and the statement's text.

2. **The read compares again, against today's records.** The row does not
   store which record a statement repeats or contradicts.
   `list_code_repository_findings` runs the check's own comparison
   (`compareStatements`) over the stored statements and the workspace's
   active records on every call. That comparison runs no model and reads no
   host. A record revised or retired after the check ran changes the answer
   at once, and a statement that no longer matches any record drops out.

3. **A row follows its pull request.**
   - Each run of the check on an open pull request replaces that pull
     request's rows. A row whose file and statement the new run finds again
     keeps its id and the proposal Promote opened from it.
   - A pull request closed without merging deletes its rows.
   - A merged pull request keeps its rows, marked merged, because the lines
     are now on the default branch. The merge also checks every merged row
     that other pull requests left on the files this one changed. It reads
     each file at the merge commit and deletes the rows whose statement the
     file no longer holds. A later pull request that removes a line therefore
     removes its finding when it merges.

   The `closed` webhook delivery reaches the same `code-repo/check` job as a
   check, so one job at a time touches a pull request's rows.

4. **The read lists linked repositories only.** It joins each row to the
   workspace's `linked` binding head for the repository. Unlinking a
   repository hides its findings, and the repository's binding id
   (`rpb_…`) names it on every surface.

5. **Promote opens a proposal from a contradiction.**
   `promote_instruction_to_steering` takes a finding's id, compares the
   statement again, and proposes a new version of the record it contradicts,
   with the statement as the record's text. It opens the proposal's steering
   PR, which runs the six checks. Nothing steers until that PR merges. A
   repeat is refused, because the line is in steering already.

## Consequences

- A schema change: `agent.code_repository_findings`, with the standard tenant
  policy. The migration is 20261002133000_code_repository_findings.sql.
- A finding appears on the page after the check runs on the pull request,
  not before. A repository linked before #5112 shows nothing until its next
  pull request.
- The page shows lines that pull requests add. A contradicting line that sat
  on the default branch before the repository was linked is never shown. A
  full scan of a repository's files is a separate feature, and it would need
  a stored credential for the read.
- Each row keeps a statement of up to 4,000 characters from a customer's
  repository. Deleting the workspace deletes the rows with it.
- To reverse: drop the table, stop the check's write, and return
  `not_backed` from the app's read. Nothing else reads the rows.
