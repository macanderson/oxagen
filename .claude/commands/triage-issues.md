---
description: Complete every open issue that has no priority label. Assign priority, tier, size, kind, and area, add the signal labels, set the issue type and the filing fields, rewrite the title to `P1 T2 S Bug (Area): Statement`, and strip AI attribution from the body.
argument-hint: "[--all | issue numbers...] [--dry-run]"
allowed-tools: Bash, Read, Write, Grep, Glob, Agent
---

# /triage-issues $ARGUMENTS

Give each issue in scope a priority, a model tier, a size, a kind, and an area. Then title it
so a reader can understand it from the list without opening it.

Since 2026-10-02 a creator files each issue complete, with no `TRIAGE` label (CLAUDE.md under
Issues and labels). Two kinds of issue still arrive without a priority: an issue a workflow
filed, and an older issue that still carries `TRIAGE`. This command completes both.

**Scope:** `$ARGUMENTS`.
- Blank: every open issue in `oxageninc/product` that has no priority label.
- Issue numbers: those issues only.
- `--all`: every open issue, with a priority or without. Use it only for a backlog sweep.
- `--dry-run`: print the plan and write nothing.

Mac set this scheme on 2026-09-30 for oxagen and stella. Every label name is uppercase.

## Before you start

1. Prefix every `gh ... --json` call with `env -u CLICOLOR_FORCE -u FORCE_COLOR`. Forced
   colour corrupts the JSON.
2. Do not retitle a workflow-owned issue, one that carries `DEPLOYMENT-FAILURE`,
   `MAIN-UNVERIFIED`, `INFRA-DRIFT`, or `STORE-DRIFT`. Its workflow writes the title, and the
   title already names a priority, tier, size, kind, and area. Add whichever of those five
   labels the issue lacks, so its labels agree with its title and it leaves the scope. If an
   older issue's title has no prefix, copy the title its workflow writes today. A
   `DEPLOYMENT-FAILURE` issue gets `P0` from its workflow, so only an `--all` sweep reaches it.
   The other three arrive with no priority, so a blank scope picks them up. For an issue
   labelled `AGENT-ESCALATED`, retitle it but keep that label, because stella's backlog loop
   owns it.

```sh
env -u CLICOLOR_FORCE -u FORCE_COLOR gh issue list --repo oxageninc/product --state open \
  --search "-label:P0 -label:P1 -label:P2 -label:P3 -label:P4" --limit 500 \
  --json number,title,labels,body,url
```

## Title format

```
<Priority> <Tier> <Size> <Kind> (<Area>): <Statement>
```

Examples:

```
P0 T3 XS Bug (CI): Main stays red because the coverage step reads a stale lockfile
P1 T3 XS Bug (Runs): The run header shows no logo for the agent harness
P1 T3 L Feature (Steering): Bulk import memories from Markdown files
P2 T2 M Improvement (CLI): Import memories in bulk from the command line
P2 T2 S Bug (App shell): The breadcrumb ends on a raw id instead of the record's name (residue #4190)
P1 T3 L Feature (Repositories): [C2] Turn GitHub issues in the repos a collector names into work items
```

Each part copies a label, so the title and the labels always agree:

| Part | Comes from | Values |
|---|---|---|
| `<Priority>` | the priority label | `P0` `P1` `P2` `P3` `P4` |
| `<Tier>` | the `MODEL:` label | `T1` `T2` `T3` `T4` |
| `<Size>` | the `SIZE:` label | `XS` `S` `M` `L` `XL` |
| `<Kind>` | the `KIND:` label | `Bug` `Feature` `Improvement` `Chore` `Documentation` `DevOps` |
| `(<Area>)` | the `AREA:` label | the title name in the area table below |

A creator writes the full title when filing the issue. An older issue, or one a workflow filed,
may still carry `Queued <Kind> (<Area>): <Statement>`. The kind and area in that title are a
guess. Replace `Queued` with the priority, the tier, and the size, and correct the kind and area.

A lane tag such as `[C0]` goes at the start of the statement, after the colon. A residue issue
keeps its trailing `(residue #<PR>)`. List every PR when it carries more than one.

### The statement

The statement is the part a person reads, so most of the work goes here. Read the whole body
before you write it.

- **Bug:** say what goes wrong, as a sentence about the product. "Approving a parked tool call
  never runs it" is right. "Fix approvals" is not.
- **Feature and Improvement:** name what a person will be able to do once the work lands. "Bulk
  import memories from Markdown files" is right. "Memory import" is too vague.
- **Chore:** name the cleanup and what it buys. "Remove the unused v1 hook installer" is right.
- **Documentation:** name the document and what its reader learns. "Explain how a workspace
  connects its steering repo" is right.
- **DevOps:** name the change to CI, deploys, or tooling and what it fixes. "Stop the nightly
  build from retrying a failed deploy" is right.
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

Every complete issue carries exactly one of each of these:

| Dimension | Labels | How to choose |
|---|---|---|
| Priority | `P0` `P1` `P2` `P3` `P4` | `P0`: drop everything for an outage, a security or data leak, a wrong charge, or a blocked core task with no workaround. `P1`: this cycle. `P2`: next cycle. `P3`: backlog. `P4`: someday, speculative. |
| Tier | `MODEL:T1` `MODEL:T2` `MODEL:T3` `MODEL:T4` | The model the work needs. See the tier table below. |
| Size | `SIZE:EXTRA-SMALL` `SIZE:SMALL` `SIZE:MEDIUM` `SIZE:LARGE` `SIZE:EXTRA-LARGE` | Agent minutes to a merge-ready pull request. See the size table below. |
| Kind | `KIND:BUG` `KIND:FEATURE` `KIND:IMPROVEMENT` `KIND:CHORE` `KIND:DOCUMENTATION` `KIND:DEVOPS` | See the kind table below. |
| Area | one `AREA:` label from the table below | Where a person meets the problem. When it spans two, pick the one the fix changes most. |

Then add these where they apply:

| Label | Apply when |
|---|---|
| `JOB:GOVERN` `JOB:GROUND` `JOB:EXPLAIN` `JOB:METER` `JOB:RATE` | The product job the work serves (`docs/VISION.md`). Most issues serve one. |
| `PILLAR:*` (one or more) | Fixing it moves stability, reliability, maintainability, innovation, efficiency, or performance. Pick the one or two it moves most, not every one that fits. |
| `SECURITY` | The issue involves credentials, secrets, tenant isolation, access control, or personal data. |
| `NEEDS:DECISION` | Only when the body asks the maintainer a specific question and the work is blocked until the answer. Mentioning SCR-004 case 1 is not enough. Remove it from issues that ask nothing. |
| `NEEDS:RIG` | The work needs a rig, a credential, or real spend that only the maintainer can supply. |
| `BLOCKED` | The work is correct but must not start yet. The body names what it waits on. |

Remove `TRIAGE` in the same edit when the issue carries it. No new issue gets it after
2026-10-02.

### Issue type and fields

Set the issue type to the kind: Bug, Feature, Improvement, Chore, Documentation, or DevOps.
Then set the four fields CLAUDE.md marks for filing under Oxagen issue fields:

| Field | Value |
|---|---|
| Priority | The `P` label |
| Model Tier | Lite for `MODEL:T1`, Standard for T2, Pro for T3, Ultra for T4 |
| Estimated Minutes | Agent minutes, a whole number inside the size band |
| Area(s) | The `AREA:` label's title name, plus any other area the work changes |

Leave Actual Minutes and the reflection fields to the agent that does the work. Set Blocked to
Yes, with Blocked Reason as the question, only when you apply `NEEDS:DECISION`.

### Tiers

Mac reinstated the model-tier labels on 2026-09-30. This supersedes the 2026-09-25 rule that
retired `model:tier-*` and left the choice of model to the harness.

| Tier | Label | Model | Choose it when |
|---|---|---|---|
| T1 | `MODEL:T1` | Haiku | The work is mechanical and fully specified: a rename, a copy fix, a regenerated file. |
| T2 | `MODEL:T2` | Sonnet | The work is routine implementation from a clear spec. |
| T3 | `MODEL:T3` | Opus | The work needs judgment across packages, invariants, security, or migrations. |
| T4 | `MODEL:T4` | Fable | The work is architecture-critical or a novel design. |

### Sizes

Size counts the agent minutes from the start of the work to a merge-ready pull request. Move up
one size when the change carries high risk or a wide blast radius.

| Size | Label | Agent minutes |
|---|---|---|
| XS | `SIZE:EXTRA-SMALL` | 30 or fewer |
| S | `SIZE:SMALL` | 31 to 90 |
| M | `SIZE:MEDIUM` | 91 to 240 |
| L | `SIZE:LARGE` | 241 to 480 |
| XL | `SIZE:EXTRA-LARGE` | More than 480, a lane that spans several sessions |

### Kinds

| Label | Title word | Use it when |
|---|---|---|
| `KIND:BUG` | Bug | Something that exists behaves wrongly. |
| `KIND:FEATURE` | Feature | The work adds a capability a person can use, and none of it exists yet. |
| `KIND:IMPROVEMENT` | Improvement | The work makes an existing capability better: polish, speed, a missing option, or a gap where the spec or mockup shows more than the build has. |
| `KIND:CHORE` | Chore | The work is maintenance with no visible change: a refactor, a dependency, dead code, or test hygiene. |
| `KIND:DOCUMENTATION` | Documentation | Docs, READMEs, ADRs, specs, or help text are the main deliverable. |
| `KIND:DEVOPS` | DevOps | The work changes CI, workflows, deploys, infrastructure, releases, or developer tooling. |

The old kinds map this way: `kind:defect` is `KIND:BUG`, `kind:feature` is `KIND:FEATURE`, and
`kind:debt` is `KIND:CHORE`. A `kind:gap` issue becomes `KIND:FEATURE` when nothing of it is
built and `KIND:IMPROVEMENT` when part of it is.

### Areas

| Label | Title name | Covers |
|---|---|---|
| `AREA:FLEET` | Fleet | The workspace home page, live runs, pending approvals, and fleet status |
| `AREA:RUNS` | Runs | The Run page and the run record, transcript, evidence, proof, audit trail, and exports |
| `AREA:MANDATES` | Mandates | Access, approvals, decision rules, and enforcement |
| `AREA:AGENTS` | Agents | Registry, identities, roles, enrolled hosts, and runtimes |
| `AREA:TOOLS` | Tools | MCP servers, connections, and the tools an agent is given |
| `AREA:STEERING` | Steering | Steering records, memory, the knowledge graph, and ingestion |
| `AREA:SKILLS` | Skills | The Skills page, skill publishing, and skill sync |
| `AREA:SPEND` | Spend | Metering, budgets, ceilings, and cost attribution |
| `AREA:BILLING` | Billing | Plans, Stripe, credits, invoices, and checkout |
| `AREA:ORGANIZATION` | Organization | Members, roles, invitations, workspaces, API keys, and model funding |
| `AREA:AUTH` | Auth | Sign-in, sessions, two-factor, SSO, IAM checks, and tenant isolation |
| `AREA:ONBOARDING` | Onboarding | Sign-up, first run, and the register-an-agent wizard |
| `AREA:REPOSITORIES` | Repositories | Connected GitHub repositories, bindings, and context pull requests |
| `AREA:STELLA` | Stella | The in-app assistant, its tools, turns, and history |
| `AREA:APP-SHELL` | App shell | Navigation, top bar, sidebar, breadcrumbs, layout, and theme |
| `AREA:TACHO` | Tacho | The host recorder, hooks, daemon, enrollment, and what it captures and ships |
| `AREA:DESKTOP` | Desktop | The desktop app and its installers |
| `AREA:GATEWAY` | Gateway | The model gateway, provider keys, and model routing |
| `AREA:API` | API | The HTTP API and SDKs |
| `AREA:MCP` | MCP | The Oxagen MCP server and its tools |
| `AREA:CLI` | CLI | The `oxagen` command-line tool |
| `AREA:DATABASE` | Database | Postgres, ClickHouse, and Neo4j schema, migrations, queries, and row-level security |
| `AREA:CI` | CI | GitHub Actions, checks, git hooks, and developer tooling |
| `AREA:DEPLOY` | Deploy | Infrastructure, production deploys, releases, and operations |
| `AREA:DOCS` | Docs | The docs site, the website, READMEs, ADRs, and specs |
| `AREA:COMPLIANCE` | Compliance | Audit events, SOC 2 controls, and security evidence |

### Labels that no longer exist

Do not apply these, and remove any you find:

- **`TRIAGE`, in either spelling.** Creators stopped applying it on 2026-10-02.
- **Every lowercase label.** The 2026-09-30 scheme renames each one to its uppercase name:
  `area:runs` is `AREA:RUNS`, and `size/S` is `SIZE:SMALL`. GitHub matches a label
  name without regard to case when you add one, so a lowercase name still adds the uppercase
  label. Write the uppercase name anyway.
- **`kind:gap`.** Use `KIND:FEATURE` or `KIND:IMPROVEMENT`, as the kind table says.
- **`build-time:*`.** Size carries effort.
- **`schema-change`.** Pull requests use `MIGRATION-REQUIRED`, which `migration-label.yml`
  applies.
- **The old code-owner areas** `area:app`, `area:data`, `area:evidence`, `area:kernel`,
  `area:knowledge`, `area:ops`, `area:platform`, and `area:surfaces`. They have no uppercase
  successor.

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

1. List the scope. Handle each workflow-owned issue as step 2 of Before you start says.
2. For each issue, read the full body and the labels it already has. Decide priority, tier,
   size, kind, area, job, pillars, `SECURITY`, `BLOCKED`, and the `NEEDS:` labels, and the
   estimated minutes. Write the statement.
3. Print the plan as a table: number, old title, new title, labels added, labels removed,
   issue type, and field values. With `--dry-run`, stop here.
4. Apply each row, one issue at a time, with a one-second pause between writes to stay under
   GitHub's secondary rate limit. Set the fields with the commands in CLAUDE.md under Oxagen
   issue fields:

   ```sh
   gh issue edit <n> --repo oxageninc/product --title "<new title>" --type Bug \
     --add-label "P2,MODEL:T2,SIZE:SMALL,KIND:BUG,AREA:RUNS,JOB:EXPLAIN,PILLAR:RELIABILITY" \
     --remove-label "<labels that should go, TRIAGE among them when present>"
   ```

   For attribution, save the body to a file, delete the attribution lines, show the diff, and
   write it back with `gh issue edit <n> --body-file <file>`. Edit a comment with
   `gh api -X PATCH repos/oxageninc/product/issues/comments/<id> -F body=@<file>`. Use `-F`,
   which reads the file. `-f` would send the literal text `@<file>`.
5. Read each issue back. Its title must match
   `^P[0-4] T[1-4] (XS|S|M|L|XL) (Bug|Feature|Improvement|Chore|Documentation|DevOps) \([A-Za-z ]+\): `,
   and it must carry one priority, one `MODEL:`, one `SIZE:`, one `KIND:`, one `AREA:`, and no
   `TRIAGE`. Its issue type must match its `KIND:` label, and its four filing fields must be
   set. Compare label names without regard to case. Report any issue that failed and the
   reason.
