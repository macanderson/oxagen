---
description: Triage every open issue labelled `triage`. Assign priority, kind, size, and area, add the descriptive labels, rewrite the title to `P1 Bug S (Area): Statement`, and strip AI attribution from the body.
argument-hint: "[--all | issue numbers...] [--dry-run]"
allowed-tools: Bash, Read, Write, Grep, Glob, Agent
---

# /triage-issues $ARGUMENTS

Give each issue in the queue a priority, a kind, a size, and an area. Then title it so a reader
can understand it from the list without opening it.

**Scope:** `$ARGUMENTS`.
- Blank: every open issue in `macanderson/oxagen` labelled `triage`.
- Issue numbers: those issues only.
- `--all`: every open issue, triaged or not. Use it only for a backlog sweep.
- `--dry-run`: print the plan and write nothing.

## Before you start

1. Run `env -u CLICOLOR_FORCE -u FORCE_COLOR gh api user --jq .login`. It must print
   `macanderson`. `triage-guard.yml` trusts only that login and `triage-bot`. From any other
   login the guard strips every priority label, re-adds `triage`, and posts a comment on
   each issue. If the login is wrong, stop.
2. Prefix every `gh ... --json` call with `env -u CLICOLOR_FORCE -u FORCE_COLOR`. Forced
   colour corrupts the JSON.
3. Skip workflow-owned issues. Their workflows write the title and labels. Leave them alone if
   they carry `deployment-failure`, `main-unverified`, `infra-drift`, or `store-drift`. For an
   issue labelled `agent-escalated`, retitle it but keep that label, because stella's
   backlog loop owns it.

```sh
env -u CLICOLOR_FORCE -u FORCE_COLOR gh issue list --repo macanderson/oxagen --state open \
  --label triage --limit 500 --json number,title,labels,body,url
```

## Title format

```
P<n> <Kind> <Size> (<Area>): <Statement>
```

Examples:

```
P0 Bug XS (CI): Main stays red because the coverage step reads a stale lockfile
P1 Feature L (Steering): Bulk import memories from Markdown files
P2 Feature M (CLI): Import memories in bulk from the command line
P2 Bug S (App shell): The breadcrumb ends on a raw id instead of the record's name (residue #4190)
```

Each part copies a label, so the title and the labels always agree:

| Part | Comes from | Values |
|---|---|---|
| `P<n>` | the priority label | `P0` `P1` `P2` `P3` `P4` |
| `<Kind>` | the `kind:` label | `Bug` (`kind:defect`), `Gap` (`kind:gap`), `Feature` (`kind:feature`), `Debt` (`kind:debt`) |
| `<Size>` | the `size/` label | `XS` `S` `M` `L` `XL` |
| `(<Area>)` | the `area:` label | the title name in the area table below |

Before triage, a creator writes `Queued <Kind> (<Area>): <Statement>` and applies only `triage`.
The kind and area in that title are the creator's guess. Triage replaces `Queued` with the
priority, adds the size, and corrects the kind and area.

A residue issue keeps its trailing `(residue #<PR>)`. List every PR when it carries more than one.

### The statement

The statement is the part a person reads, so most of the work goes here. Read the whole body
before you write it.

- **Bug:** say what goes wrong, as a sentence about the product. "Approving a parked tool call
  never runs it" is right. "Fix approvals" is not.
- **Gap and Feature:** name what a person will be able to do once the work lands. "Bulk import
  memories from Markdown files" is right. "Memory import" is too vague.
- **Debt:** name the cleanup and what it buys. "Remove the unused v1 hook installer" is right.
- **Plain words.** Someone who has never opened the codebase should follow it. Leave out
  function names, file paths, table names, flags, and internal terms such as frames, seal,
  WAL, belt entry, GAU, or trailer. Say what the person sees instead: "a run", "the tool list",
  "usage records". A product name (Fleet, Tacho, MCP, Stripe) is fine.
- **Short.** Aim for 80 characters or fewer, and never go over 100. One claim per title. Put
  the rest in the body.
- **Sentence case, no ending period,** no em dashes, no exclamation points (the `clear-prose` skill).
- **Keep the claim honest.** Do not overstate what the body shows, and do not soften a P0.
- **Do not write "Mission Control"** (ADR-113). Name the page instead.

## Labels

Every triaged issue carries exactly one of each of these:

| Dimension | Labels | How to choose |
|---|---|---|
| Priority | `P0` `P1` `P2` `P3` `P4` | `P0`: an outage, a security or PII leak, a wrong charge, or a blocked core task with no workaround. `P1`: this cycle. `P2`: next cycle. `P3`: backlog. `P4`: someday. |
| Kind | `kind:defect` `kind:gap` `kind:feature` `kind:debt` | Defect: something that exists behaves wrongly. Gap: the spec or mockup shows it and the build lacks it. Feature: new capability with a product reason. Debt: maintenance with no visible change. |
| Size | `size/XS` `size/S` `size/M` `size/L` `size/XL` | Take the largest of effort, risk, and blast radius. XS is under an hour, S half a day, M a day, L several days, XL a week or more. |
| Area | one `area:` label from the table below | Where a person meets the problem. When it spans two, pick the one the fix changes most. |
| Job | `job:govern` `job:ground` `job:explain` `job:meter` `job:rate` | The product job it serves (`docs/VISION.md`). |

Then add these where they apply:

| Label | Apply when |
|---|---|
| `pillar:*` (one or more) | Fixing it moves stability, reliability, maintainability, innovation, efficiency, or performance. Pick the one or two it moves most, not every one that fits. |
| `security` | The issue involves credentials, secrets, tenant isolation, access control, or personal data. |
| `needs:decision` | Only when the body asks the maintainer a specific question and the work is blocked until the answer. Mentioning SCR-004 case 1 is not enough. Remove it from issues that ask nothing. |
| `needs:rig` | The work needs a rig, a credential, or real spend that only the maintainer can supply. |

Adding a priority label from the `macanderson` login makes `triage-guard.yml` remove `triage`.
Do not remove `triage` yourself when you add a priority.

### Areas

| Label | Title name | Covers |
|---|---|---|
| `area:fleet` | Fleet | The workspace home page: live runs, pending approvals, and fleet status |
| `area:runs` | Runs | The Run page and the run record: transcript, evidence, proof, audit trail, and exports |
| `area:mandates` | Mandates | Mandates and policy: access, approvals, decision rules, and enforcement |
| `area:agents` | Agents | Agent registry, identities, roles, enrolled hosts, and runtimes |
| `area:tools` | Tools | Tools, MCP servers, connections, and the tools an agent is given |
| `area:steering` | Steering | Steering, context records, memory, the knowledge graph, and ingestion |
| `area:skills` | Skills | The Skills page, skill publishing, and skill sync |
| `area:spend` | Spend | Spend, metering, budgets, ceilings, and cost attribution |
| `area:billing` | Billing | Plans, Stripe, credits, invoices, and checkout |
| `area:organization` | Organization | Members, roles, invitations, workspaces, API keys, and model funding |
| `area:auth` | Auth | Sign-in, sessions, two-factor, SSO, IAM checks, and tenant isolation |
| `area:onboarding` | Onboarding | Sign-up, first run, and the register-an-agent wizard |
| `area:repositories` | Repositories | Connected GitHub repositories, bindings, and context pull requests |
| `area:stella` | Stella | The in-app assistant: its tools, turns, and history |
| `area:app-shell` | App shell | Navigation, top bar, sidebar, breadcrumbs, layout, and theme |
| `area:tacho` | Tacho | The host recorder: hooks, daemon, enrollment, and what it captures and ships |
| `area:desktop` | Desktop | The desktop app and its installers |
| `area:gateway` | Gateway | The model gateway, provider keys, and model routing |
| `area:api` | API | The HTTP API and SDKs |
| `area:mcp` | MCP | The Oxagen MCP server and its tools |
| `area:cli` | CLI | The `oxagen` command-line tool |
| `area:database` | Database | Postgres, ClickHouse, and Neo4j schema, migrations, queries, and row-level security |
| `area:ci` | CI | GitHub Actions, checks, git hooks, and developer tooling |
| `area:deploy` | Deploy | Infrastructure, production deploys, releases, and operations |
| `area:docs` | Docs | The docs site, the website, READMEs, ADRs, and specs |
| `area:compliance` | Compliance | Audit events, SOC 2 controls, and security evidence |

### Labels that no longer exist

Do not apply these, and remove any you find: `build-time:*`, `model:tier-*`, `schema-change`
(use `migration-required`, which `migration-label.yml` applies to PRs), and the old code-owner
areas `area:app`, `area:data`, `area:evidence`, `area:kernel`, `area:knowledge`, `area:ops`,
`area:platform`, and `area:surfaces`. Size carries effort. The harness picks the model.

## Attribution

Remove AI attribution from the issue body and from any comment the `macanderson` login wrote.
Remove only these:

- a `https://claude.ai/code/session_...` link, and a line that holds nothing else
- `Generated with [Claude Code](...)` and `🤖 Generated with ...` lines
- `Co-Authored-By: Claude ...` lines

Leave mentions of Claude Code as a product or harness, and branch names such as
`claude/<slug>`. Those are facts about the system. Leave a comment from another account as it is.
You cannot edit it.

## Procedure

1. List the scope and skip the workflow-owned issues.
2. For each issue, read the full body and the labels it already has. Decide priority, kind, size,
   area, job, pillars, `security`, and the `needs:` labels. Write the statement.
3. Print the plan as a table: number, old title, new title, labels added, labels removed.
   With `--dry-run`, stop here.
4. Apply each row, one issue at a time, with a one-second pause between writes to stay under
   GitHub's secondary rate limit:

   ```sh
   gh issue edit <n> --repo macanderson/oxagen --title "<new title>" \
     --add-label "P2,kind:defect,size/S,area:runs,job:explain,pillar:reliability" \
     --remove-label "<labels that should go>"
   ```

   For attribution, save the body to a file, delete the attribution lines, show the diff, and
   write it back with `gh issue edit <n> --body-file <file>`. Edit a comment with
   `gh api -X PATCH repos/macanderson/oxagen/issues/comments/<id> -f body=@<file>`.
5. Read each issue back. Its title must match `^P[0-4] (Bug|Gap|Feature|Debt) (XS|S|M|L|XL) \([A-Za-z ]+\): `,
   and it must carry one priority, one kind, one size, one area, and no `triage`. Report
   any issue that failed and the reason.
