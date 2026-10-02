# parse_markdown_import

Read Markdown files and propose steering records, Cedar policies, and memories from them
(#4907). It writes nothing. [commit_markdown_import](steering.markdown_import.commit.md) takes
the rows back, opens the steering PR, and stores the memories.

You keep rules in Markdown already: `CLAUDE.md`, `AGENTS.md`, Cursor rules, a docs folder, an
ADR folder. This call reads up to 25 of them and returns one row per statement, with a kind, a
force, the words that justify the force, the line it came from, and any duplicate or conflict
with a record already published.

**Surfaces:** api, mcp, agent, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/import/parse`, returns 200
- MCP: `parse_markdown_import`
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It needs no approval (`riskLevel: low`).
- CLI: `oxagen steering import <paths...>` reads files and the Markdown files under folders, each with the target its text implies or the one `--as` names (`records`, `policies`, or `memories`). `oxagen memory import <files...>` reads every file as `records`. Both print the rows.
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billed: one balanced-tier model call per file it splits, counted as in-app agent spend

## Input

| Field | Type | Description |
|---|---|---|
| `documents` | 1 to 25 of `{ filename, content, target? }` | the files. `content` is at most 100,000 characters. `filename` may be a path, such as `docs/release.md`, and the lineage takes its folders |
| `documents[].target` | `records`, `policies`, `memories`, or `skip`, optional | where the file goes. Omit it to take the target the text implies |

A file with a fenced `cedar` block, or a top-level `permit(` or `forbid(` statement, implies
`policies`. A `README.md` or `index.md`, or a file of headings and links, implies `skip`. Any
other file implies `records`.

## Output

| Field | Type | Description |
|---|---|---|
| `files` | one per file | the target used, the target implied and why, the record, policy, and memory counts, and an `error` when the file yielded nothing |
| `records` | record rows | the proposed steering records, file by file in source order |
| `policies` | policy rows | the proposed Cedar policy files, one per file |
| `memories` | memory rows | the proposed memories, file by file in source order |
| `pullRequestFiles` | `{ count, max, message }` | the files the record and policy rows marked add would put in the steering PR, against the 299 one PR holds. `message` says what to do when the count is over, and is null when it fits. Memories count against no PR |

### Record row

| Field | Description |
|---|---|
| `file`, `line` | where the statement came from |
| `origin` | `frontmatter` for a file that is one steering record already, `split` for a statement the model split out |
| `lineage`, `label` | the record's lineage, such as `a-intel.docs.release.tag-the-release`, and its name of at most 36 characters |
| `statement` | the record's body |
| `kind`, `kindReason` | one of the eight kinds, and one line on why |
| `force`, `forceWords` | the force, and the words in the file that justify it. Empty words mean the kind's default applied |
| `effect` | `require` or `forbid` on a constraint, null on every other kind |
| `tokens` | what the statement adds to a request. A `must` or `should` record adds it to every request |
| `duplicate`, `conflict` | the record the row says again, or the constraint it contradicts, or null |
| `action` | `add` or `skip`. A duplicate defaults to `skip`. A conflict is null until a person chooses |
| `frontmatter` | a frontmatter record's YAML, kept for the commit. Null for a split statement |

### Policy row

| Field | Description |
|---|---|
| `file`, `path` | the Markdown file, and `policy/<file-slug>.cedar` |
| `text` | the policy file: the prose above each block as a comment, then each statement with its `@id` |
| `statements` | each statement's `@id`, line, and effect |
| `issues` | what the early checks found. A policy with an issue cannot be added |
| `duplicate`, `replaces` | the published policy file with the same statements, and whether the commit replaces a different file at `path` |
| `action` | `add` or `skip` |

### Memory row

| Field | Description |
|---|---|
| `file`, `line` | where the statement came from |
| `label` | the memory's name |
| `statement` | the memory's text. A row marked `add` holds at most 2,000 characters |
| `kind`, `force` | always `memory` and `info` |
| `duplicate` | what the row says again, or null: `{ reason, memory, file, line }`. `reason` is `waiting` for a waiting memory with the same statement hash (`memory` names it), `rejected` for a statement a person rejected, or `import` for an earlier row of this import (`file` and `line` name it) |
| `issue` | why the row cannot be stored, such as a statement over 2,000 characters, or null |
| `action` | `add` or `skip`. A row with a `duplicate` or an `issue` defaults to `skip` |

## What parse does

1. A file with `schema: steering-record/v1` frontmatter stays one record and keeps its
   frontmatter.
2. Any other `records` file goes to one model call, which splits it into at most 50
   statements. A numbered list of steps stays one procedure.
3. The model proposes each statement's kind and force. The handler keeps a force only when the
   kind allows it and the justifying words are in the statement or in its own source lines. A
   "must" on another rule's line justifies nothing. Otherwise the kind's default
   applies: `should` for `business-rule`, `code-rule`, `constraint`, `procedure`, and `skill`,
   `may` for a `preference`, and `info` for a `fact` or a `memory`. A preference never carries
   `must` or `should`, and a fact or a memory carries only `info`.
4. A constraint always gets an effect. When the model gives none, a statement with "never",
   "do not", "must not", or "avoid" is `forbid`, and any other is `require`.
5. Each `policies` file's Cedar becomes `policy/<file-slug>.cedar`. A statement keeps its own
   `@id`. A statement with none takes the file slug, then `-2`, `-3`, skipping any id another
   policy file already uses. A block fenced in another language is an example and makes no
   policy.
6. The early checks read each statement's shape: annotations each named once, then `permit` or
   `forbid`, a scope that names `principal`, `action`, and `resource`, balanced `when` and
   `unless` clauses, and a closing semicolon. A failure names the statement's number, its
   `@id`, and its line, such as "Statement 1 (staging.deploys) has permitt where permit or
   forbid belongs."
7. Each record row is compared with the published records and with the import's other rows
   by the steering check's own `conflicts` test: the same words, or a word-set overlap of 0.9
   or more when both statements have at least 8 distinct words. A row and the steering PR's
   check therefore agree.
8. A `memories` file is split as a `records` file is, and a file with `steering-record/v1`
   frontmatter is one memory of its body. Each statement becomes a memory row with kind
   `memory` and force `info`, whatever the model proposed. Each row's statement hash is
   checked against the workspace's waiting memories, the statements a person rejected
   (`memory_rejections`), and the rows before it. A row that matches is marked `skip` and names
   the match. Parse reads the memory store only when a file is imported as `memories`.

## Errors

| Code | Reason | When |
|---|---|---|
| 403 | `forbidden` | the caller holds none of the roles above |
| 404 | `workspace_not_found` | the workspace is not in the organization |

A file the model fails on is reported in `files[].error`, and the other files still parse.
