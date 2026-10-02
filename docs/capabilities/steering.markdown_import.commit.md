# commit_markdown_import

Open one steering PR with the Markdown import's rows (#4907). Pass the rows
[parse_markdown_import](steering.markdown_import.parse.md) returned, as you edited them.
Nothing in the PR steers an agent until it merges.

**Surfaces:** api, mcp, agent, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/import/commit`, returns 201
- MCP: `commit_markdown_import`
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: medium`).
- CLI: `oxagen memory import <files...> --yes`
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Not billed (`noBillingGate: true`), IAM default-deny, high sensitivity

## Input

| Field | Type | Description |
|---|---|---|
| `records` | record rows, default `[]` | the record rows from parse. The schema refuses a force the row's kind does not allow, a constraint with no effect, and an effect on any other kind |
| `policies` | policy rows, default `[]` | the policy rows from parse |

The schema also refuses rows that mark more than 299 records and policies add, because one
steering PR holds at most 299 files. The issue's message, in the `details` of a `validation_error`,
says how many to mark skip.

## Output

| Field | Type | Description |
|---|---|---|
| `pullRequest` | `{ number, url, branch, headSha }` | the steering PR, and the commit the "Oxagen steering" check ran on |
| `paths` | string array | every path the PR adds or replaces, in path order |
| `records`, `policies` | number | the records and policy files the PR holds |
| `skipped` | number | rows marked `skip`, left out |

## What commit does

1. Refuses a row whose conflict nobody chose for, a policy whose early checks failed, two rows
   with one lineage, and two files at one path.
2. Writes each record row marked `add`:
   - a new record at `steering/<kind folder>/<lineage>.md`: `business-rules`, `code-rules`,
     `constraints`, `procedures`, `facts`, or `preferences`;
   - a skill at `steering/skills/<lineage>/SKILL.md`, with a `name` and a `description`;
   - a memory at `steering/memory/workspace/general/<lineage>.md`;
   - a record whose lineage is already published at the path it holds now, so the import
     revises it.

   A split statement's frontmatter carries `scope: workspace`, `status: active`,
   `origin: user`, and `provenance.source: import`, with a `uri` of
   `oxagen:import/<file>#L<line>`. A frontmatter record keeps its own fields, with the ones the
   row owns set from the row. No file carries an `id` or a `hash`: Oxagen writes both when the
   PR merges.
3. Writes each policy row marked `add` at its `policy/<file-slug>.cedar`.
4. Takes the first free branch of the day: `steering/import-<YYYY-MM-DD>`, then `-2`, `-3`, and
   so on. That branch may change steering records, skills, and Cedar policy files in one PR,
   and nothing else.
5. Opens the PR through the steering PR opener the tools PRs use, which commits every file at
   once, runs the steering checks on the new head, and reports them as the "Oxagen steering"
   check.

## Errors

| Code | Reason | When |
|---|---|---|
| 403 | `forbidden` | the caller holds none of the roles above |
| 409 | `conflict_unresolved` | a row's `action` is null: it conflicts, and nobody chose add or skip |
| 409 | `policy_invalid` | a policy row marked `add` has issues |
| 409 | `nothing_to_import` | every row is marked `skip` |
| 409 | `duplicate_lineage`, `duplicate_path` | two rows share a lineage, or two files share a path |
| 409 | `record_unreadable` | a row does not make a steering record the schema accepts |
| 409 | `import_branches_exhausted` | the steering repo already has 50 import branches for the day |
| 409 | `steering_repo_required` | the workspace's repository has no `steering/governance.toml` |
| 400 | `validation_error` | the rows mark more than 299 records and policy files add. Mark some skip, or import the files in smaller sets |
