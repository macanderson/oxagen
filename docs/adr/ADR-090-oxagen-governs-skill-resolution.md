# ADR-090: Oxagen governs skill resolution, and the 2026-09-15 narrowing is reversed

- **Status:** Accepted; amended 2026-09-18 by ADR-097 and ADR-093 (Skills is a tab under Steering; delivery is by sync)
- **Date:** 2026-09-18
- **Owners:** app, kernel, evidence
- **Supersedes:** the 2026-09-15 narrowing recorded in `apps/app/ARCHITECTURE.md`
  (the §0 Skills entry, the §1.2 `/{org}/{ws}/skills` row, the §8 lane note,
  the 2026-09-15 decision-log entry, and the W13 bullet at "W13 'In the loop'
  is out of this release")
- **Related:** ADR-043 (Oxagen governs agents; it does not run them),
  ADR-072 (`.oxagen/tools/` paths), #3098 (the Skills lane), #3241 (the repository
  binding this config is read through), Mission Control spec §2, §7.5, §14, §19,
  App. E, App. F,
  `docs/w13-in-the-loop-scenario.md` and `mockups/pages/skills.md`,
  `skills-off.md`, `skill-source.md`, `run-interjection.md` in
  `macanderson/tmp-oxagen-mockups`

## Context

On 2026-09-15 Skills was narrowed to what was already recorded: `/{org}/{ws}/skills`
lists the skill names wrapped harness sessions reported at session start, read by
`list_skills` over `tacho.sessions.skills_available`. Everything else the mockup
draws — the catalog with versions and digests, the `search_skills` console, the
interjection seat, reflection, and the config's version history — was to render
nothing. The W13 bullet put the whole scenario out of the release, on the reasoning
that `CLAUDE.md` states there is no skill system in this repo, spec §2 states Oxagen
has no skills engine, and a scenario file is not the place to reverse either.

That reasoning was right about the mechanism and wrong about the conclusion. It read
"no skills engine" as "no skills surface", and those are different claims. Running a
skill and resolving one are separate acts, and only the first is what ADR-043 cut.

What the narrowing left is a page that answers one question — which skill names a
harness happened to report — with no version, no digest, no source, no cost and no
decision. That is an inventory, not a control. An operator cannot tell from it which
skills an agent was allowed to find, which were held back, or why, because Oxagen
never decided any of it.

The mockup's Skills page (`pSkills()` in `mockups/src/engine.js`, specified in
`mockups/pages/skills.md`) is the full control: five tabs (Catalog · Search ·
In the loop · Reflection · Versions), four dialogs (`skenable`, `skcfg`, `skill`,
`skadd`) and the creation wizard. W13 "In the loop" is the scenario it is built
from. Maintainer decision of 2026-09-18: build that, in full.

## Decision

**Oxagen governs skill resolution. It still never runs a skill.** ADR-043 stands
unchanged, and spec §2 keeps its "no skills engine" line; §2 gains one sentence
distinguishing running from resolving. Resolution is the same shape as the toolbelt:
Oxagen holds no credential and runs no tool, and still decides every call.

1. **`.oxagen/skills.toml` is the config of record.** It lives in the workspace's
   main repository on its production branch, is read through the repository binding
   (#3241), and changes only by pull request. Its absence means skills are off, and
   a workspace is created with `skills.enabled` false — the off state is the value a
   workspace is born with, not one somebody set.

2. **Resolution is the governed act.** The config decides which skills an agent may
   find, which it may load, what that load cost, and what was withheld. A skill is
   `id@version` with a digest.

3. **Withholding happens before ranking.** A skill that is out of scope, or whose
   digest changed since a person approved it, is dropped before ranking — it is not
   a low-scoring result, it is not a result. The agent is told the count withheld and
   the reason class, never the name. A withholding that names what it withholds has
   not withheld it.

4. **Turning skills on adds exactly one tool,** `search_skills`, to every belt in the
   workspace. No tool is granted, no tier changes, no budget moves. The switch is
   rendered as the outcome; the pull request is the control, and the person who
   opened it is on the receipt.

5. **A run pins its config version at start,** and replay resolves that pinned
   version rather than today's config. A resolution that changed under a replay would
   make the recorder a liar.

6. **An unbound repository with skills on stops the loop before the first model
   call.** `unbound_repo = "ask"` is the policy; it times out to `deny` at 30 minutes.
   There is no `allow` — a config that could silently proceed without a repository to
   resolve against would make the whole control optional.

7. **Reflection is research-only and quarantined.** `use = "research"` is the only
   accepted value. A capture is taken out of band after the seal, is a post-seal record rather than a frame (rule 9),
   is excluded from the
   sealed chain, is not replayed on a fork, is billed as overhead rather than
   productive spend, is readable only under an organization-level `research.read`
   grant, and expires. It never enters a context frame, is never promoted to steering,
   and is not evidence about a person.

8. **New stores**, defined in Appendix A (§A.10 `skills`), because that appendix is the
   definitive table list and says a table not listed does not exist: `skills.config_versions`,
   `skills.resolutions`, and `skills.reflections` behind the quarantine. Its fence is **not**
   §5.2, which is tenant isolation and would let an ordinary workspace read reach the rows.
   It is four things the #3098 lane builds: a dedicated read capability, a new org-scoped
   `research.read` IAM permission (absent from the catalogue today), an RLS predicate that denies
   without it — which needs a signal the database can see, because §5.2 exposes only
   `app.current_org_id` and `app.current_workspace_id` and an IAM permission is application
   state Postgres cannot read, so `withTenantDb` sets a third transaction-local setting
   `app.research_read` after the IAM check passes and the predicate requires it **in addition
   to** the ordinary `org_id`/`workspace_id` checks rather than in place of them, since a
   research flag that replaced tenant isolation would cross organizations — and a job that deletes rows
   past `retain_until` — an expiry nothing enforces is a comment. Config history is git history, not a table; a config version
   carries the `commit_sha` it was read at as its provenance.

9. **Eight new frame kinds** (added to the gateway-kind table in §7.5, beside
   `control.command` and `control.steer`; Appendix C is a single envelope example and
   enumerates nothing): `skills.searched`, `skills.resolved`, `skills.loaded`,
   `control.interject`, `control.answer`, `repo.unknown`, `repo.bound`, `workspace.created`.

   **A reflection is not among them, and is not a frame at all.** W13 and an earlier revision
   of this ADR called it `reflection.captured`. That cannot hold: §8.2 requires every frame to
   carry a dense `seq` with `prev_hash` and `hash`, and §8.3 seals a signed frame count and
   Merkle root over every frame — so a frame appended after the seal would invalidate the
   attestation, while a frame excluded from the chain has no valid sequence to belong to.
   Rule 7 already puts the capture outside the sealed chain, so it is a **post-seal record**
   in `skills.reflections`. The mockup draws it dashed for exactly this reason.

10. **`list_skills` keeps its job and its name.** The observed-inventory read is not
    replaced by resolution; it answers a different question — what the harness
    actually had — and the page keeps that section beside the resolved catalog. Its
    contract comment stops citing §2 as authority for "does not resolve".

## Consequences

- Spec §2 gains the run-versus-resolve sentence and keeps "no skills engine". §14's
  page count and screen table, §7.5's gateway-kind table (all eight frame kinds),
  Appendix E's tool set (the eleven Skills tools —
  `search_skills` and the nine reads and writes the five tabs need — and its totals), Appendix A's new §A.10 `skills` schema and its table count,
  App. E's `dispatch_command` entry and §19's page-coverage table all gain Skills and W13. Appendix F's route map is
  left alone: `ARCHITECTURE.md` records it as already drifted on other grounds (Ontology
  cut, Audit rescoped) and wins over it, so reconciling it is not this ADR's job.
- `apps/app/ARCHITECTURE.md` loses the narrowing in all five places and gains this
  decision in its log.
- #3098 grows from one section to the mockup's five tabs and its backend, and gains a
  dependency on #3241: the config is read through the repository binding, so the
  binding lands first.
- Build order is load-bearing: the resolution store and config versioning first, then
  the off state, then the page. Shipping the off state before the page is what makes
  the default path right from the first commit rather than retrofitted onto a surface
  that assumed the opposite.
- The e2e rule is untouched. The page is proven by component and action tests;
  `apps/app/e2e` stays `login`, `pay` and `page-load`.

## What this does not decide

It does not put a skills engine in this repo. Oxagen runs no skill, holds no sandbox
and executes no harness. It does not reopen ADR-043. It does not make reflection
evidence: the quarantine is a fence, not a staging area, and any later proposal to
read a reflection into the record is a new ADR, not an extension of this one.

## Alternatives rejected

- **Keep the narrowing and ship the inventory.** Rejected: it presents as a control
  something that decides nothing, which is the failure this product exists to remove.
- **Adopt resolution but skip the interjection seat.** Rejected: the seat is what makes
  resolution answerable to a person when the config cannot resolve. Without it, an
  unbound repository either proceeds blind or fails silently.
- **Put the config in Postgres with a UI editor.** Rejected: a definition of record
  that a person can change without a reviewable commit is not a record. Git history is
  the version history, and the pull request is the control.

## Amendment 2026-09-18: Skills is a tab under Steering, and delivery is by sync

Maintainer decision of 2026-09-18, recorded in ADR-097 §5 and ADR-093 §6, made
the same day as this ADR and after it. The two agree on everything this ADR
decides about resolution. They differ in two places, and this amendment settles
both.

**Where the page lives.** This ADR builds "the mockup's Skills page" at
`/{org}/{ws}/skills` with five tabs. The decision in force: **Skills and
Ontology have no top-level nav entry of their own any more.** Steering is the
hub, and its tabs are Records, Skills, Memory, Ontology, Policy, Proposals,
Preview. The five views this ADR names (Catalog, Search, In the loop,
Reflection, Versions) become sections of the Skills tab. The `/skills` route
redirects there. `list_skills` keeps its job (decision 10).

**How a skill reaches the agent.** This ADR decides what an agent may find and
load through `search_skills`. It does not say how the skill's files arrive.
The decision in force: **skills are steering, and they are files. Governed like
a record through a pull request, delivered by sync (materializing files in the
checkout), loaded by the harness's own progressive disclosure. The skill's
description line competes in the assembler like any other item.**

What stands unchanged: `.oxagen/skills.toml` as the config of record, skills
off by default, withholding before ranking, the pinned config version, the
unbound-repository stop, the reflection quarantine, the new stores and the eight
frame kinds. A withheld skill is withheld from both paths: its files are not
synced and its description line is not rendered.

ADR-091 §6 freezes new governance ceremony until a merged record is seen in a
real run. This ADR's lane (#3098) is build work on a decided surface, and any
new check, mode or review step it would add waits for that freeze to lift.
