# GitHub Event → Graph Mapping

Archived spec & plan — status: not started (audited 2026-07-03).

> **Superseded for launch (2026-07-21).** This archived document is retained as
> historical design context, not as an implementation plan. The exact live code
> graph stays local; Oxagen keeps GitHub provider, repository, ref, commit,
> pull-request, workflow-run, and changed-file metadata. References below to central
> `SourceFile`/`SourceSymbol` indexing, source embeddings, automatic intent-to-code
> edges, or confidence-based materialization are historical. Canonical topology from
> configured protected/default refs and a typed evidence ledger are explicit
> follow-ups, and every semantic candidate requires governed approval.

> **Status: Not started** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The spec is a comprehensive design document (Status: Design / requirements) specifying how GitHub webhook events should map to knowledge-graph nodes and edges across 50+ event types. All 6 implementation checklist items remain unchecked. The GitHub connector's parseWebhookEvent currently handles only 8 events and explicitly excludes all Tier 2-3 events. No new node labels, relationship types, inferred-edge jobs, or capability documentation have been implemented.

**Implementation evidence**

- docs/specs/github-event-graph-mapping/spec.md — 6 unchecked implementation checklist items confirming spec remains unimplemented
- packages/ingestion/src/connectors/github/index.ts parseWebhookEvent (lines 352-414) — handles only 8 events; comment states 'create, delete, fork, star, check_run have no ingestable data record'
- Zero commits to packages/ingestion/src/connectors/github/index.ts since spec added 2026-06-27; no extension of event parsing
- No codebase references to new node labels (:Branch, :Tag, :CheckSuite, :CheckRun, :Deployment, :Discussion, :Team, :Label, :Milestone, :SecurityAlert, :Advisory, :BranchProtectionRule, :Ruleset, :Project, :ProjectItem)
- No codebase references to new relationship types (MODIFIES, REVIEWED_BY, CLOSES, ON_BRANCH, CHECKED_BY, DEPLOYED, DEPLOYED_TO, RELEASED_FROM, AFFECTS, PROTECTS, BLOCKS, TAGGED)
- No evidence of inferred-edge Inngest jobs (ownership inference, intent→code, deploy provenance)

**Known gaps at time of archive**

- Tier 1-3 event parsing: extend parseWebhookEvent to handle create, delete, check_run, check_suite, status, workflow_run, workflow_job, deployment, deployment_status, label, milestone, discussion, code_scanning_alert, secret_scanning_alert, secret_scanning_alert_location, secret_scanning_scan, dependabot_alert, repository_advisory, branch_protection_rule, repository_ruleset, custom_property, deploy_key, and 30+ more
- Node label registration: Branch, Tag, CheckSuite, CheckRun, Deployment, DeploymentStatus, Discussion, DiscussionComment, Team, Label, Milestone, SecurityAlert, CodeScanningAlert, SecretScanningAlert, DependabotAlert, Advisory, BranchProtectionRule, Ruleset, Project, ProjectItem
- Relationship type registration: MODIFIES, REVIEWED_BY, CLOSES, ON_BRANCH, CHECKED_BY, DEPLOYED, DEPLOYED_TO, RELEASED_FROM, AFFECTS, PROTECTS, BLOCKS, DEPENDS_ON, TAGGED
- Upsert handlers and identity resolution (login → User/Person) for new entity types
- Post-ingestion Inngest jobs: ownership inference, intent→code edge derivation, deploy provenance tracing
- docs/capabilities/ documentation for GitHub webhook event coverage

**Source documents** (archived verbatim below)

- `docs/specs/github-event-graph-mapping/spec.md`

## Spec — `spec.md`

## GitHub Webhook Events → Knowledge-Graph Mapping

**Status:** Design / requirements
**Owner:** Knowledge graph + connectors
**Related:** [ADR-012 Connector dual-write](../../adr/ADR-012-connector-dual-write-pattern.md) · [Workspace schema registry](../workspace-schema-registry/spec.md) · webhook handler `apps/api/src/routes/v1/github-webhook.ts` · GitHub connector `packages/ingestion/src/connectors/github/index.ts`

### Purpose

This document defines, **per GitHub webhook event**, how the Oxagen knowledge graph should react. The north star: **every event should leave an agent knowing more about the code, the people, the process state, and the risk surface than it did before — and able to act on that knowledge with fewer round-trips.** A webhook is not a notification; it is a fact about the world that belongs in the graph.

We design for the agent first. For each event we ask: *what could an agent now answer that it couldn't a second ago?* If the answer is "nothing useful," we don't subscribe.

---

### Graph model primer (read this before the tables)

The mappings below use Oxagen's existing conventions. Do not invent parallel ones.

#### Node labels

GitHub-ingested nodes are **customer-scoped** (`is_system: false`) and carry the `:GraphNode` anchor label plus a first-class **domain label** (e.g. `:PullRequest`). During the transition off `:EntityNode {entityType}` (see [registry spec §3.3](../workspace-schema-registry/spec.md)), the resolver in `upsert-entity.ts` may still fall back to `:EntityNode` — the *target* labels below are the contract.

| Domain label | Source record type | Already modeled? |
|---|---|---|
| `:Repository` | `repository` | ✅ (`source_repository`) |
| `:Branch` | `branch` | ➕ new |
| `:Tag` | `tag` | ➕ new |
| `:Commit` | `commit` | ✅ |
| `:SourceFile` | `source` | ✅ (`SourceFile`) |
| `:SourceSymbol` | — (derived) | ✅ |
| `:PullRequest` | `pull_request` | ✅ |
| `:Issue` | `issue` | ✅ |
| `:Review` | `code_review` | ✅ |
| `:Comment` | `comment` | ✅ |
| `:Discussion` / `:DiscussionComment` | `discussion` | ➕ new |
| `:CheckSuite` / `:CheckRun` | `check` | ➕ new |
| `:WorkflowRun` / `:WorkflowJob` | `workflow_run` | ✅ (`WorkflowRun` for agent runs — reuse label, namespace by `provider:"github_actions"`) |
| `:Deployment` / `:DeploymentStatus` | `deployment` | ➕ new |
| `:Release` | `release` | ✅ |
| `:Package` | `package` | ➕ new |
| `:Person` | `user` | reuse `:User` when the GitHub login maps to a known Oxagen user; otherwise `:Person` (external contributor) |
| `:Team` | `team` | ➕ new |
| `:Label` | `label` | ➕ new |
| `:Milestone` | `milestone` | ➕ new |
| `:SecurityAlert` (`:CodeScanningAlert` / `:SecretScanningAlert` / `:DependabotAlert`) | `security_alert` | ➕ new |
| `:Advisory` | `advisory` | ➕ new |
| `:BranchProtectionRule` / `:Ruleset` | `policy` | ➕ new |
| `:Project` / `:ProjectItem` | `project` | ➕ new |

#### Relationship types

Reuse the registered types where they fit; the ones marked ➕ must be added to the workspace schema registry (it is the allow-list — unregistered types are rejected by `assertValidLabel`).

Existing: `AUTHORED_BY`, `ASSIGNED_TO`, `CONTAINS`, `PART_OF`, `IMPLEMENTS`, `REFERENCES`, `APPROVED_BY`, `MEMBER_OF`, `OWNS`, `TRIGGERED`, `TRIGGERED_BY`, `DERIVED_FROM`, `SOURCED_FROM`, `BRANCHED_FROM`, `REPLIES_TO`.

New (➕): `MODIFIES` (commit→file), `REVIEWED_BY` (PR→person), `CLOSES` (PR→issue), `ON_BRANCH` (commit/PR→branch), `CHECKED_BY` (commit→check), `DEPLOYED` (deployment→commit), `DEPLOYED_TO` (deployment→environment), `RELEASED_FROM` (release→commit/tag), `AFFECTS` (alert→file/package/repo), `PROTECTS` (rule→branch), `BLOCKS` / `BLOCKED_BY` (issue dependencies), `DEPENDS_ON` (package→package), `TAGGED` (tag→commit).

#### Required properties (every GitHub node)

Carried on every ingested node, per the dual-write pipeline:

- `externalId`, `externalUrl`, `naturalKey` = `{connectorId}:{connectionId}:{externalId}` (dedup key)
- `displayName` — the **only** thing the UI shows as the primary identifier (never the UUID — see [citation rule](../../adr/) / `NodeRef`)
- `connectionId`, `workspaceId`, `orgId` — tenant scope; `is_system: false`
- `label` = domain entityType; `properties` = full normalized JSON blob
- `createdAt`, `updatedAt`, `syncedAt`
- `embedding` (1536-dim) on nodes with meaningful text (PR/issue/commit/discussion/release/comment) for semantic retrieval

#### Cross-cutting rules

1. **Upsert, never duplicate.** Key on `naturalKey`. Re-deliveries (GitHub retries, `edited` actions) must converge, not fan out.
2. **Dual-write ordering.** Postgres cursor write is the ACID source of truth; the Neo4j write is async/retryable via Inngest. If the graph write fails, the cursor does **not** advance.
3. **Identity resolution.** Resolve a GitHub `login` to a known `:User` when possible (org membership map); otherwise materialize a lightweight `:Person`. Never create two nodes for the same human.
4. **Soft-delete, don't hard-delete.** `deleted`/`removed` actions set `deletedAt` + detach hot edges; they don't `DETACH DELETE` history an agent may need for "what changed and when."
5. **Tombstone unmaterialized targets.** An edge to a not-yet-ingested node (e.g. a referenced issue we haven't synced) gets `id: null` + a described candidate, per the `knowledgeNodeRef` shape — never a bare UUID.
6. **Every event stamps `provenance`** = `{deliveryId, eventName, action, deliveredAt, sender}` so an agent can explain *why* a node looks the way it does and de-dupe on `deliveryId`.

---

### Subscription tiers (which events to actually enable)

Don't "send me everything" — noise costs ingestion budget and dilutes the graph. Subscribe in tiers:

- **Tier 1 — Code & collaboration spine (always on):** Pushes, Pull requests, Pull request reviews, Pull request review comments, Issues, Issue comments, Branch/tag creation & deletion, Releases, Repositories.
- **Tier 2 — Process & quality signal (on for any repo with CI):** Check runs, Check suites, Statuses, Workflow runs, Workflow jobs, Deployments, Deployment statuses, Labels, Milestones, Sub-issues, Issue dependencies.
- **Tier 3 — Risk & governance (on for any repo we secure):** Code scanning alerts, Secret scanning alerts (+ locations, + scans), Dependabot alerts, Repository vulnerability alerts, Repository advisories, Branch protection rules/configurations, Repository rulesets, Security & analyses, all dismissal/bypass request events.
- **Tier 4 — Org & social (sample or skip):** Stars, Watches, Forks, Memberships, Teams, Org blocks, Page builds, Wiki, Visibility changes. Mostly low graph value; ingest as metadata, not first-class nodes, unless a customer asks.

---

### Event → graph update tables

> **Reading the "Graph update" column:** it lists the node(s) upserted, the edge(s) created/updated, the key properties set, and — in *italics* — the **agent value** (what an agent can now do/answer).

#### Code: pushes, branches, tags

| GitHub event | Graph update |
|---|---|
| **Pushes** (`push`) | Upsert one `:Commit` per commit in the payload, keyed on `sha`. `(:Commit)-[:ON_BRANCH]->(:Branch)`, `(:Commit)-[:AUTHORED_BY]->(:Person)`, and `(:Commit)-[:MODIFIES {changeType: added\|modified\|removed}]->(:SourceFile)` for each `added/modified/removed` path. Set `message`, `committedAt`, `parents[]`, `verified` (signature). Advance the repo's `defaultBranchHeadSha` when the push targets the default branch. Queue `ingestion/github.parse-file` for changed source files so `:SourceSymbol` nodes re-index. *Agent value: answers "what changed in file X and who touched it last," powers blast-radius ("who else imports the symbol this commit changed"), and keeps the code graph current without a full re-clone.* |
| **Branch or tag creation** (`create`) | Upsert `:Branch` or `:Tag` keyed on `repo:ref`; `(:Repository)-[:CONTAINS]->(:Branch/:Tag)` and `(:Branch)-[:BRANCHED_FROM]->(:Commit)` (base sha). For tags, `(:Tag)-[:TAGGED]->(:Commit)`. Set `protected`, `createdBy`. *Agent value: lets an agent reason about active lines of work ("what feature branches are open off main") and resolve a tag to its commit for release tracing.* |
| **Branch or tag deletion** (`delete`) | Soft-delete the `:Branch`/`:Tag` (`deletedAt`), detach `CONTAINS`, keep `:Commit` history intact (commits may be reachable from other refs). *Agent value: prevents an agent from suggesting work on a dead branch; preserves archaeology of merged/abandoned lines.* |

#### Pull requests & reviews

| GitHub event | Graph update |
|---|---|
| **Pull requests** (`pull_request`) | Upsert `:PullRequest` keyed on `repo:number`. Edges: `(:PullRequest)-[:AUTHORED_BY]->(:Person)`, `-[:ON_BRANCH]->(:Branch)` (head), `-[:TARGETS]->(:Branch)` (base), `-[:ASSIGNED_TO]->(:Person)` per assignee, `-[:HAS_LABEL]->(:Label)`, and on body/title parse `-[:CLOSES]->(:Issue)` for `closes #N` / `fixes #N`. On `synchronize`, relink head commits via `(:Commit)-[:PART_OF]->(:PullRequest)`. Set `state`, `draft`, `merged`, `mergedAt`, `mergedBy`, `additions/deletions/changedFiles`, `reviewDecision`. On merge, infer `(:PullRequest)-[:IMPLEMENTS]->(:Feature)` if linked. Re-embed on title/body change. *Agent value: the central unit of work — an agent can answer "what's in flight, who owns it, what does it close, is it merge-ready," and trace a shipped line of code back to the PR and issue that justified it.* |
| **Pull request reviews** (`pull_request_review`) | Upsert `:Review` keyed on review id; `(:Review)-[:REVIEWS]->(:PullRequest)`, `(:Review)-[:AUTHORED_BY]->(:Person)`. On `submitted` with state `approved`, also `(:PullRequest)-[:APPROVED_BY]->(:Person)`. Maintain a derived `reviewDecision` on the PR. *Agent value: an agent can tell whether a PR is blocked on review, who the reviewers are, and who has domain authority over a path (frequent approver of files under X).* |
| **Pull request review comments** (`pull_request_review_comment`) | Upsert `:Comment {kind:"review"}` keyed on comment id; `(:Comment)-[:ON]->(:PullRequest)`, `-[:AUTHORED_BY]->(:Person)`, and anchor `-[:ANNOTATES]->(:SourceFile {path, line})`. Thread via `(:Comment)-[:REPLIES_TO]->(:Comment)`. *Agent value: turns inline review discussion into queryable, line-anchored knowledge — "what concerns were raised about this function," "is this thread resolved" — so an agent can address feedback instead of re-deriving it.* |
| **Pull request review threads** (`pull_request_review_thread`) | Set `resolved: true\|false` + `resolvedBy` on the thread root `:Comment` and roll up an `unresolvedThreadCount` onto the `:PullRequest`. *Agent value: lets an agent know exactly what's left to address before a PR can merge.* |

#### Issues, labels, milestones, dependencies

| GitHub event | Graph update |
|---|---|
| **Issues** (`issues`) | Upsert `:Issue` keyed on `repo:number`. Edges: `-[:AUTHORED_BY]->(:Person)`, `-[:ASSIGNED_TO]->(:Person)`, `-[:HAS_LABEL]->(:Label)`, `-[:PART_OF]->(:Milestone)`. Parse body for `-[:REFERENCES]->(:Issue/:PullRequest)`. Set `state`, `stateReason`, `closedAt`, `type`. Re-embed on edit. *Agent value: the unit of intent — an agent can prioritize ("open P1 bugs assigned to nobody"), connect intent→implementation→commit, and surface duplicates via embedding similarity.* |
| **Issue comments** (`issue_comment`) | Upsert `:Comment {kind:"issue"}`; `-[:ON]->(:Issue\|:PullRequest)`, `-[:AUTHORED_BY]->(:Person)`. Extract `@mentions` → `-[:MENTIONS]->(:Person)` and `#refs` → `-[:REFERENCES]->`. *Agent value: captures the decision trail and action items that live in comments; an agent can summarize "what was decided" and who's on the hook.* |
| **Labels** (`label`) | Upsert/rename/soft-delete `:Label` keyed on `repo:name`. On `edited` rename, update in place (don't fork). *Agent value: labels are a taxonomy; keeping them canonical lets an agent filter and route ("all `security`-labeled open issues").* |
| **Milestones** (`milestone`) | Upsert `:Milestone`; set `state`, `dueOn`, `closedAt`. *Agent value: time-boxing — "what's due this milestone and what's still open."* |
| **Sub issues** (`sub_issue`) | Maintain `(:Issue)-[:PART_OF]->(:Issue)` parent/child edges on add/remove. *Agent value: hierarchical decomposition an agent can walk to roll up progress on an epic.* |
| **Issue dependencies** (`issue_dependencies`) | Maintain `(:Issue)-[:BLOCKS]->(:Issue)` / `-[:BLOCKED_BY]->`. *Agent value: critical-path reasoning — "what must land before issue X is unblocked."* |

#### CI/CD: checks, statuses, workflows, deployments

| GitHub event | Graph update |
|---|---|
| **Check suites** (`check_suite`) | Upsert `:CheckSuite` keyed on suite id; `(:CheckSuite)-[:FOR]->(:Commit)`. Set `status`, `conclusion`. *Agent value: rolled-up CI health for a commit/PR.* |
| **Check runs** (`check_run`) | Upsert `:CheckRun` keyed on run id; `-[:PART_OF]->(:CheckSuite)`, `(:Commit)-[:CHECKED_BY]->(:CheckRun)`. Store `name`, `conclusion`, `detailsUrl`, and **failure annotations** (path+line+message) as `-[:ANNOTATES]->(:SourceFile)`. *Agent value: an agent can answer "why is CI red on this PR" with the exact failing check and file/line, and propose a fix instead of asking the human to paste logs.* |
| **Statuses** (`status`) | Upsert/merge a commit-status onto `:Commit` (`statuses[]` with context/state/targetUrl). *Agent value: covers legacy/3rd-party status checks (Vercel, etc.) so deploy/preview state is on the commit.* |
| **Workflow runs** (`workflow_run`) | Upsert `:WorkflowRun {provider:"github_actions"}` keyed on run id; `-[:TRIGGERED_BY]->(:Commit\|:PullRequest)`, `-[:RAN]->(:Workflow)`. Set `status`, `conclusion`, `runAttempt`, `event`. *Agent value: links a CI outcome to the change that caused it; powers "is main green," flaky-run detection across attempts.* |
| **Workflow jobs** (`workflow_job`) | Upsert `:WorkflowJob` keyed on job id; `-[:PART_OF]->(:WorkflowRun)`. Store `steps[]`, `conclusion`, `runnerName`, `startedAt/completedAt`. *Agent value: job-level granularity for "which step failed and how long it took" — duration trends feed CI-cost/perf reasoning.* |
| **Deployments** (`deployment`) | Upsert `:Deployment` keyed on id; `(:Deployment)-[:DEPLOYED]->(:Commit)`, `-[:DEPLOYED_TO]->(:Environment {name})`. *Agent value: "what's running in prod" resolves to an exact commit, enabling "is my fix deployed yet."* |
| **Deployment statuses** (`deployment_status`) | Update the `:Deployment` state (`success\|failure\|in_progress`) + `environmentUrl`, append to a status history. *Agent value: closes the loop on deploy verification — an agent can confirm a release actually went live before claiming done.* |

#### Releases & packages

| GitHub event | Graph update |
|---|---|
| **Releases** (`release`) | Upsert `:Release` keyed on `repo:tag`; `(:Release)-[:RELEASED_FROM]->(:Tag)->(:Commit)`. Set `name`, `body` (embedded), `draft`, `prerelease`, `publishedAt`, `assets[]`. *Agent value: maps a version to its commit and changelog; an agent can answer "what shipped in v2.3" and diff releases.* |
| **Packages** / **Registry packages** (`package` / `registry_package`) | Upsert `:Package` keyed on `ecosystem:name:version`; `(:Repository)-[:PUBLISHES]->(:Package)`, `(:Package)-[:BUILT_FROM]->(:Commit)`. *Agent value: connects source to published artifact for supply-chain and "which version contains commit X" queries.* |

#### Security & risk

| GitHub event | Graph update |
|---|---|
| **Code scanning alerts** (`code_scanning_alert`) | Upsert `:CodeScanningAlert` keyed on alert number; `-[:AFFECTS]->(:SourceFile {path,line})`, `-[:DETECTED_BY]->(:Tool {name})`. Set `rule`, `severity`, `state`, `dismissedReason`. *Agent value: a live map of where the static-analysis risk is, anchored to exact code an agent can open and fix.* |
| **Secret scanning alerts** (`secret_scanning_alert`) | Upsert `:SecretScanningAlert`; `-[:AFFECTS]->(:Repository)`. Set `secretType`, `state`, `validity`, `publiclyLeaked`. **Never store the secret value.** *Agent value: lets an agent flag and triage credential exposure and confirm remediation — high-priority risk signal.* |
| **Secret scanning alert locations** (`secret_scanning_alert_location`) | Add `-[:AFFECTS]->(:SourceFile {path,line,commitSha})` location edges to the existing alert. *Agent value: pinpoints every place a leaked secret appears for full cleanup.* |
| **Secret scanning scans** (`secret_scanning_scan`) | Stamp `lastScannedAt`/`scanType` on `:Repository`. *Agent value: freshness signal — an agent knows how current the scan coverage is.* |
| **Dependabot alerts** (`dependabot_alert`) | Upsert `:DependabotAlert`; `-[:AFFECTS]->(:Package)`, `(:Package)-[:DEPENDS_ON]->` graph. Set `severity` (CVSS), `ghsaId`, `state`, `autoDismissed`. *Agent value: dependency-risk graph — "which of our packages pull in the vulnerable version, and is a safe upgrade available."* |
| **Repository vulnerability alerts** (`repository_vulnerability_alert`) | Same target as Dependabot (legacy event); upsert/merge into `:DependabotAlert` to avoid a duplicate node. *Agent value: dedup so the risk view is single-source.* |
| **Repository advisories** (`repository_advisory`) | Upsert `:Advisory` keyed on ghsaId; `-[:AFFECTS]->(:Package\|:Repository)`. Set `severity`, `cve`, `summary` (embedded). *Agent value: first-party advisory context for the supply-chain risk graph.* |
| **Security and analyses** (`security_and_analysis`) | Set feature-enablement flags (`secretScanning`, `pushProtection`, etc.) on `:Repository`. *Agent value: posture metadata — an agent can flag repos missing protections.* |
| **Dependabot / code-scanning / secret-scanning dismissal requests** (`*_alert_dismissal_request`) | Attach a `:Request {kind, state, requestedBy, reason}` node to the target alert via `-[:REQUESTS_DISMISSAL_OF]->`. *Agent value: governance trail — who tried to dismiss what risk, and was it approved.* |
| **Bypass requests for push rulesets / secret-scanning push protection** (`*_bypass_request`) | `:Request {kind:"bypass"}` → `-[:BYPASSES]->(:Ruleset\|:Repository)` with state. *Agent value: surfaces policy-bypass attempts for audit/SOC-2 evidence.* |

#### Governance & policy

| GitHub event | Graph update |
|---|---|
| **Branch protection rules** (`branch_protection_rule`) | Upsert `:BranchProtectionRule`; `-[:PROTECTS]->(:Branch pattern)`. Store required reviews, status checks, signed-commits. *Agent value: an agent knows the merge rules before proposing a workflow ("main needs 2 approvals + green CI").* |
| **Branch protection configurations** (`branch_protection_configuration`) | Set a repo-level `branchProtectionEnabled` flag. *Agent value: coarse posture signal.* |
| **Repository rulesets** (`repository_ruleset`) | Upsert `:Ruleset`; `-[:GOVERNS]->(:Repository)`. Store enforcement + rules JSON. *Agent value: modern ruleset equivalent of protection rules for the same reasoning.* |
| **Custom properties** / **Custom property values** (`custom_property*`) | Store as `properties` on the `:Repository` (values) or a workspace-level `:CustomProperty` definition node. *Agent value: org taxonomy (e.g. `tier=critical`, `team=billing`) an agent can filter and route on.* |
| **Deploy keys** (`deploy_key`) | `:DeployKey` → `-[:GRANTS_ACCESS_TO]->(:Repository)`; soft-delete on removal. Store fingerprint, `readOnly`. **Never store the key.** *Agent value: access-surface inventory for security review.* |
| **Repository rulesets / branch protection** bypasses | (see Security table — bypass requests). |

#### Repository, org, collaborators, teams

| GitHub event | Graph update |
|---|---|
| **Repositories** (`repository`) | Upsert `:Repository` keyed on `owner/name`. Handle `renamed` (update `fullName`, keep node), `transferred` (re-parent OWNS), `archived`/`deleted` (soft-delete + pause `sourceConnection`). Set `language`, `topics[]`, `defaultBranch`, `visibility`, `size`. *Agent value: the root of the code graph — rename/transfer handled in place so links don't break.* |
| **Collaborator add/remove/changed** (`member`) | `(:Person)-[:HAS_ACCESS {permission}]->(:Repository)`; update permission on change, detach on remove. Resolve to `:User` when internal. *Agent value: "who can touch this repo and at what level" for ownership and security reasoning.* |
| **Memberships** (`membership`) | `(:Person)-[:MEMBER_OF]->(:Team)`; add/remove. *Agent value: org structure for routing and code-owner inference.* |
| **Teams** (`team`) | Upsert `:Team`; `(:Team)-[:HAS_ACCESS]->(:Repository)` on add/remove. *Agent value: team→repo authority map.* |
| **Team adds** (`team_add`) | Create the `(:Team)-[:HAS_ACCESS]->(:Repository)` edge. *Agent value: same as above (granular event).* |
| **Organizations** (`organization`) | Update org-level node; handle member invited/added/removed → `:Person` lifecycle. *Agent value: keeps the people graph current.* |
| **Org blocks** (`org_block`) | Flag `:Person {blocked:true\|false}`. *Agent value: trust signal — suppress a blocked actor's contributions.* |
| **Personal access token requests** (`personal_access_token_request`) | `:Request {kind:"pat"}` with state. *Agent value: access-governance audit trail.* |
| **Visibility changes** (`public`) | Set `visibility:"public"` on `:Repository` + stamp `wentPublicAt`. *Agent value: high-signal security event — public exposure of formerly-private code.* |

#### Discussions, projects, wiki, social

| GitHub event | Graph update |
|---|---|
| **Discussions** (`discussion`) | Upsert `:Discussion` (embedded body); `-[:IN_CATEGORY]->(:DiscussionCategory)`, `-[:AUTHORED_BY]->(:Person)`. Mark `answered` + `-[:ANSWERED_BY]->(:DiscussionComment)`. *Agent value: long-form decisions/Q&A become semantically retrievable knowledge — an agent can answer "how do we do X" from a resolved discussion.* |
| **Discussion comments** (`discussion_comment`) | `:DiscussionComment` → `-[:ON]->(:Discussion)`, threaded via `REPLIES_TO`. *Agent value: captures the accepted answer and reasoning.* |
| **Commit comments** (`commit_comment`) | `:Comment {kind:"commit"}` → `-[:ON]->(:Commit)`, optionally line-anchored to `:SourceFile`. *Agent value: rationale attached directly to a commit.* |
| **Projects v2 / items / status updates** (`projects_v2*`) | Upsert `:Project` / `:ProjectItem`; `(:ProjectItem)-[:TRACKS]->(:Issue\|:PullRequest)`, status field → `status` property. *Agent value: planning board state — an agent can answer "what's in `In Progress`" and roll up project health.* |
| **Wiki** (`gollum`) | Upsert `:WikiPage` (embedded) keyed on `repo:slug`; store revision. *Agent value: docs-as-knowledge, semantically searchable.* |
| **Forks** (`fork`) | `(:Repository)-[:FORKED_FROM]->(:Repository)`. *Agent value: provenance/lineage of derived repos.* |
| **Stars** (`star`) / **Watches** (`watch`) | Increment a counter property on `:Repository`; **do not** create a node per star. *Agent value: low — popularity metadata only; keep it cheap.* |
| **Page builds** (`page_build`) | Stamp `pagesLastBuilt` + status on `:Repository`. *Agent value: minor deploy-of-docs signal.* |
| **Repository imports** (`repository_import`) | Stamp import status on `:Repository`. *Agent value: ingestion-readiness signal — don't index until import succeeds.* |

#### Lifecycle / infrastructure (handled, not graphed as domain nodes)

| GitHub event | Graph update |
|---|---|
| **Meta** (`meta`, hook deleted) | No graph node. Mark the `sourceConnection` `error`/`paused` in Postgres and alert — the pipe is gone. *Agent value: operational — prevents silent staleness.* |
| **Merge groups** (`merge_group`) | Optional: attach a transient `mergeQueue` status to PRs in the group. *Agent value: low unless merge-queue reasoning is needed; default skip.* |
| **Check suites/runs requested** (request-only actions) | Acknowledge; only persist on `completed` to avoid churn. *Agent value: avoids writing half-states.* |
| **Installation / installation_repositories** (App lifecycle) | Already handled in `github-webhook.ts`: create/pause/resume/delete the `sourceConnection` rows and queue graph cleanup tagged by `connectionId`. Not domain nodes. *Agent value: connection lifecycle correctness.* |

---

### Derived / inferred edges (the real leverage)

The raw events above are the substrate. The agent-multiplying value comes from **second-order edges** the ingestion pipeline infers once the primitives exist:

1. **Intent → code:** `(:Issue)<-[:CLOSES]-(:PullRequest)-[:PART_OF]-(:Commit)-[:MODIFIES]->(:SourceFile)` lets an agent walk from "the bug" to "the exact lines that fixed it."
2. **Ownership inference:** frequent `AUTHORED_BY`/`APPROVED_BY` over files under a path → a derived `(:Person)-[:OWNS]->(:SourceFile dir)` so an agent knows who to ask / who to tag.
3. **Risk → fix readiness:** `(:SecurityAlert)-[:AFFECTS]->(:SourceFile)<-[:MODIFIES]-(:Commit)` tells an agent whether an alert's file has been touched since.
4. **Deploy provenance:** `(:Deployment)-[:DEPLOYED]->(:Commit)-[:PART_OF]->(:PullRequest)-[:CLOSES]->(:Issue)` answers "is the fix for issue N actually in prod."
5. **Flakiness:** repeated `:WorkflowRun {runAttempt>1, conclusion:"success"}` on the same commit → mark the failing `:CheckRun` flaky.

These are computed in the ingestion functions, not pushed by GitHub — but every one depends on the primitive nodes/edges being modeled correctly above. **That is why we subscribe broadly within Tiers 1–3 and model first-class labels rather than dumping everything into `:EntityNode`.**

---

### Implementation checklist

- [ ] Register the ➕ node labels and relationship types in the workspace schema registry (allow-list gate).
- [ ] Extend `packages/ingestion/src/connectors/github/index.ts` `parseWebhookEvent` to map the Tier 1–3 events to `sourceRecordType`s (today it covers `pull_request`, `issues`, `issue_comment`, `pull_request_review_comment`, `pull_request_review`, `release`, `repository`, `push`).
- [ ] Add upsert handlers for the new entity types in the entity-received pipeline, including identity resolution (login → `:User`/`:Person`).
- [ ] Add the inferred-edge jobs (ownership, intent→code, deploy provenance) as post-ingestion Inngest steps.
- [ ] Verify no secret material (secret-scanning values, deploy keys, PAT contents) is ever persisted to Postgres or Neo4j.
- [ ] Add the GitHub event coverage to `docs/capabilities/` and confirm UI cites every node via `NodeRef` (`displayName` + `label`, never the UUID).
