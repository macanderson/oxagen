# ADR-112: The two §2.1 renames land on the surfaces, behind aliases, in phases

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** cli, kernel, app, docs
- **Related:** Mission Control spec §2.1 (the two renames, applied
  everywhere); ADR-025 (verb-first snake_case capability names, with no alias
  fallback); ADR-101 (four first-class harnesses); `docs/specs/tacho/spec.md`
  §5.1 (enrollment); `apps/cli/src/program.ts` (the command tree)
- **Numbering:** 112, after two collisions in one day, both resolved in favour
  of the other record. It was written as ADR-103 at 18:21 UTC on 2026-09-19;
  ADR-103 was already the price book recording its own initialization, added at
  07:50, which left `packages/database/src/schema/cost.ts` and
  `apps/cli/src/program.ts` citing one number for two documents. It became
  ADR-111, and while it was in review another session merged its own ADR-111 to
  `main`, on refusing an `amount` measure's unit at declaration. That one is
  merged and heavily cited across `packages/oxagen`, `packages/handlers`,
  `packages/rules` and `apps/app`, so it keeps the number and this record moved
  again. A commit message or pull request body from earlier today says ADR-103 or
  ADR-111 for this document; this line is the trail. ADR-102 and ADR-109 are each
  taken twice and are not this record's to renumber.

  Three numbers for one record in a day is not carelessness, it is what an
  unsynchronised counter does when a dozen sessions write ADRs against the same
  tree: the number is picked from the local tree and validated at merge, so two
  branches cut an hour apart pick the same one and neither is wrong until one
  merges. Nothing in the repository allocates ADR numbers, and `check:contracts`
  does not look at them. A registry, or numbering by merge order rather than by
  authoring order, is the fix; it is a maintainer decision about a shared counter
  rather than something a session can settle from inside one branch.
- **Delivered by:** this record and the phase order it sets; phase 1a, the
  hidden `tacho` group in `apps/cli/src/program.ts`; and phase 1b, the seven
  wrapping commands on `oxagen agent` with the three collisions resolved and
  the three empty-state strings pointed at `oxagen agent enroll`

## Context

Spec §2.1 puts two renames in scope for v1. The word *capability*, used for a
registered contract with schemas, IAM defaults, and a handler, becomes **agent
tool**. The word *tacho*, used for recording and gating an agent Oxagen does
not run, becomes nothing at all: the thing has no product name, and doing it is
**wrapping an agent**. The spec sets the bar in one sentence. Neither old word
appears in the product, the API, the UI, or the docs.

Neither rename has happened. This records why, and what makes them safe to do.

### What the words actually touch

Measured on `1e4c197aa`, excluding `node_modules`:

| Word | Files | Notable |
| --- | --- | --- |
| `capabilit*` | 2,814 | 327 contracts call `registerCapability` |
| `tacho` | 627 | 130 in `packages/tacho`, 115 in `docs`, 42 in `packages/database` |

Three user-visible strings tell an operator to run `oxagen tacho enroll`:
`agents.detail.enrollment.empty.command`, `fleet.runs.empty.command`, and
`skills.empty.hint`.

### The part that makes this not a text sweep

Both words cross a boundary that is already deployed.

`oxagen tacho enroll` installs a user service, writes a device key, and writes
the hook binary's path into the harness settings on the machine it runs on. It
also prints a managed settings document that MDM pushes to a fleet. So
`tachod` and `tacho-hook` are not identifiers. They are a service name and a
binary path recorded on every enrolled machine, and in documents an
administrator has already distributed. The same is true of the URLs that
machine calls: `apps/api/src/app.ts` mounts `/v1/tacho/enroll`, the credentialed
`/v1/tacho` group and seven organization-scoped `/tacho/` paths, and a daemon
already running holds those paths, not a name we can edit. Renaming any of them
without a migration un-enrolls those machines. `tacho/1.0` is the envelope version on the wire
between the hook, the collector, and the server, so its name is a protocol
term, not a label: `TACHO_ENVELOPE_VERSION` in `packages/tacho/src/envelope.ts`
accepts that literal and no other, and phase 5 is what adds `oxagen.frame/1.0`
beside it. This sentence named the replacement as though it were current until
2026-09-19, and the corpus README inherited the error from here.

On the other side, ADR-025 retired the dotted capability form **with no alias
fallback**, and a registered capability name is the wire contract its callers
hold: the API request body, and for the one `tacho`-carrying name that is also
on MCP, `list_tacho_hosts`, the tool a customer's agent calls. A rename that
reaches those names breaks callers with no fallback by that ADR's own design.
The route paths above are a separate surface from the names dispatched over
them, which is why phase 4 aliases the paths while decision 1 leaves the names
alone.

### The collision the spec does not resolve

§2.1 names the wrapping surface `oxagen agent enroll | status | unenroll`. All
three names are taken, by operations with a different scope:

| Spec name | Exists today as | Scope |
| --- | --- | --- |
| `agent enroll` | `agent enroll --token oxe_1time_…` | this machine, via a one-time enrollment token |
| `agent status` | `agent status <agent>` | one agent's identity, credentials, and hosts |
| `agent unenroll` | `agent unenroll <agent>` | revoke an agent's live host enrollments |

The host-scoped equivalents live under the old word: `tacho enroll` wraps this
machine using the logged-in session, `tacho status` reports this machine's
daemon, hooks, and spool, and `tacho unenroll` removes the hooks and the
service here. `program.ts` already records that `agent enroll` and
`tacho enroll` run the same `@oxagen/tacho/cli` routine and differ only in the
credential they present.

So the two sets are not duplicates to merge. They are server-scoped and
host-scoped operations that the spec's wording collapses onto one name.

## Decision

**1. The bar is the surfaces, and the identifiers are not the bar.** §2.1 says
the product, the API, the UI, and the docs. A sweep of `registerCapability`
across 327 contracts, or of the `@oxagen/tacho` package name, buys nothing the
spec asked for and guarantees conflicts on a tree several sessions push to.
Internal identifiers change when the file they live in is being changed for
another reason, and not as a campaign. Anyone reading §2.1 as a mandate to
rename every symbol should read this paragraph first.

**2. Nothing that an enrolled machine records changes without an alias and a
deprecation window.** That covers the CLI command, the service name, the hook
binary path, and the envelope. The new name is what the product prints and
documents. The old name keeps working, stays out of `--help`, and prints one
line on use naming its replacement. It is removed in a later release, once the
fleet has rolled.

The notice says "moving to" rather than "moved to" while a phase is outstanding.
A line that names a command the reader cannot yet run the same way is worse than
no line, and naming the replacement is not decoration: hiding the old spelling
from `--help` removes the operator's other way of finding the new one, so the
notice is the migration guidance. `printDeprecatedNotice` in
`apps/cli/src/commands/retired.js` is the one place that sentence lives, and it
leaves the exit code alone, unlike the ADR-043 retirement notice beside it,
because a deprecated command still does its work.

**3. The three colliding CLI names resolve by argument, not by renaming either
side.** `oxagen agent status` with no argument reports this machine.
`oxagen agent status <agent>` reports that agent. The same split applies to
`unenroll`.

`enroll` is the one that does not resolve by presence, which only became clear
while implementing it. Both commands already take `--token`, and it means two
different things: `agent enroll --token` wants the single-use enrollment token
shown once at registration (`oxe_1time_…`, handled by `handleAgentEnroll`),
while `tacho enroll --token` wants a platform API token and falls back to the
logged-in session (`handleTachoEnroll`). So the merged command dispatches on the
token's prefix, not on whether a token was given: `oxe_1time_` goes to the
enrollment-token path, anything else and no token at all go to the session path.
An operator pastes whichever token they hold, which is better than asking them
to know which command matches their credential.

This changes two existing commands: `status <agent>` and `unenroll <agent>`
take an optional argument where the argument was required. That is additive for
every caller that passes one. It is chosen over `oxagen agent host status`
because the spec names the three commands directly, and over renaming the
server-scoped commands because those names are the ones an operator already
knows.

**4. The phases ship in this order, each on its own branch and its own pull
request.**

1. **1a.** `oxagen tacho` leaves `--help` and prints one deprecation line, with
   all seven subcommands unchanged underneath. Nothing moves, so nothing can
   break, and the word is out of the product's help.
2. **1b.** The seven move onto `oxagen agent`, the three collisions resolve as
   decision 3 says, and only then do the three user-visible strings point at
   `oxagen agent enroll`. The strings wait for the move because a string naming
   a command the reader cannot run is worse than the old word, and until the
   merge lands `oxagen agent enroll` demands a one-time token the reader of an
   empty state does not have. This phase changes two governance command
   signatures, so it reviews on its own.

   The move copies rather than forwards. `oxagen tacho` keeps its own seven
   definitions, in the host-only shape every enrolled machine was enrolled
   with, and the four names that collide with nothing come from one
   `addHostWrapCommands` so the two groups cannot drift. Forwarding was the
   first design and it is wrong: a forwarded `tacho enroll` would be re-parsed
   by a command with different flags and a prefix rule, which is a behaviour
   change dressed as compatibility.

   Each merged command refuses the flags belonging to the scope it did not
   take, rather than dropping them. `--purge` against an agent handle means
   nothing this CLI does, and an operator who passes it and reads a success
   line has been told a local spool was deleted when nothing went near it.
3. The docs. Measured on `756469151`, the merge base this work was cut from,
   which is on `main` and therefore still reachable after the squash merge that
   lands this record (ADR-110). A branch commit is not: citing one would make
   the measurement unreproducible the moment it merged.

   One predicate, `grep -ril tacho`, finds 119 files under `docs/`. Case
   matters: a case-sensitive scan misses `Tacho`. Count
   `docs/capabilities/*.md` non-recursively, because a git pathspec's `*`
   crosses `/` and pulls in `schemas/README.md` for 29.

   **`docs/` is not the documentation surface. `apps/docs` is.** The first four
   drafts of this measurement scanned `docs/` alone, which is the internal
   corpus. The site a customer reads is `apps/docs`, and it carries the word in
   7 more files across 84 occurrences on 63 matching lines:
   `content/docs/cli/wrap-an-agent.mdx` (34 lines), `cli/desktop.mdx` (21),
   `getting-started.mdx` (3), `cli/commands.mdx` (2), `index.mdx`,
   `architecture.mdx`, and `src/app/(home)/page.tsx`. All 7 carry prose, so the
   scope is 45 prose files of 126, not 38 of 119. The per-file figures are
   matching lines, from `git grep -ic`; the 84 is occurrences, from
   `git grep -io ... | wc -l`. A record whose whole point is that the occurrence
   is the unit of work should not quote a line count as an occurrence count,
   which an earlier draft did.

   Those 7 are the most urgent files in the whole phase, and not because of the
   noun. `getting-started.mdx` and `wrap-an-agent.mdx` instruct a reader to run
   `oxagen tacho enroll` and `oxagen tacho status`, which phase 1a and 1b moved
   to `oxagen agent`. The old spelling still works and prints one deprecation
   line, by design, so nothing is broken; but the published quickstart now
   teaches the deprecated form, which is a defect the rename created and this
   record did not see because it was measuring the wrong tree. Sweep `apps/docs`
   first. `pnpm check:prose` scans it, unlike `docs/`, so that sweep has a
   scanner the rest of phase 3 does not.

   **The unit of work is the occurrence, not the file.** Three drafts of this
   table classified files by the directory they sit in, and each draft was
   wrong in the same way, because most of these files carry more than one kind
   of occurrence. What decides whether an occurrence changes is what it is:

   | The occurrence is | What phase 3 does | Where |
   | --- | --- | --- |
   | An identifier | Nothing. Decision 1 keeps it: a registered capability name, a contract file stem, a package name, a schema or table name, an SDK symbol, the envelope literal. | Everywhere, including 13 capability documents whose only occurrences are these |
   | Generated output | Nothing by hand. It says what its source says, so it changes when the source does. 26 files: the 16 capability schemas, `docs/CODEMAPS/architecture.md`, `docs/mission-control/TOOL-MATRIX.md` and `TRACEABILITY.md`, four JSON matrices, and three `.html` siblings of `.md` specs |
   | A dated record | Nothing. It says what was decided and when. 39 files: `docs/adr/` (33), `docs/audits/` (3), and `design/adr-0003` through `adr-0005`, accepted 2026-08-31. Living outside `docs/adr/` does not make a decision record rewritable |
   | Prose a reader reads | Rewritten. 38 files: 11 in `docs/specs/tacho/`, 15 capability documents that say `Tacho` in sentences, and 12 elsewhere including `docs/VISION.md`, `README.md` and `ONBOARDING.md` |
   | A code comment | Rewritten; the code around it is identifiers. 3 files, the examples under `design/examples/` |

   38 + 3 + 26 + 39 + 13 = 119 under `docs/`, plus 7 prose files under
   `apps/docs` for 126 and 45 prose. The file counts are a size, not a work list: a
   capability document has a filename and a `**Surfaces:**` line that stay and
   sentences that change, and `check-capability-docs` compares only that line
   against the contract, so it is not a reason to leave the sentences alone.

   **The directory keeps its path.** `docs/specs/tacho` is referenced 59 times,
   and most of those are comments in source files across
   `packages/database`, `packages/telemetry`, `packages/oxagen`,
   `packages/run-ledger` and `packages/tacho`. Nothing checks those paths, so a
   move breaks them silently, and a repository path nobody outside the tree
   reads is the internal identifier decision 1 leaves alone.

   **The prose keeps naming what exists.** `tachod`, `tacho-hook`, the deployed
   `/tacho/` paths and `tacho/1.0` are live until phases 4 and 5 rename them,
   and the `tacho` Postgres schema is live for good. The envelope's live name is `tacho/1.0`, the one literal
   `TACHO_ENVELOPE_VERSION` accepts; `oxagen.frame/1.0` is what phase 5 adds
   beside it. Naming a replacement as though it were current would tell a
   producer to send a version the collector rejects, which is the failure this
   paragraph exists to prevent. `@oxagen/tacho` and the seven registered
   capability names that carry the word are not renamed by any phase: decision 1
   keeps the package name, and ADR-025 retired the dotted form of a capability
   name with no alias fallback, so renaming one breaks every caller at once.
   Exactly one of the seven reaches a customer's agent as an MCP tool,
   `list_tacho_hosts`, whose contract is the only one of them declaring
   `surfaces: ["api", "mcp"]`. `ingest_tacho_events` is not that one: it
   declares `surfaces: ["api"]`, omits the `mcp` layer, and no tool binds it.
   An earlier draft of this record and of the corpus README called it an MCP
   tool a customer's agent calls, which is the deployed API route below.

**What the unshipped phases below are, and are not.** Phases 4, 5 and 6 have not
been built. What binds is the decision: nothing an already-deployed name records
moves without an alias, and each alias retires on the clock of whoever holds the
old name. The file paths, line numbers, path lists and counts in those phases are
this record's reading of the tree on 2026-09-19, and eight rounds of review on
this pull request found nineteen errors in exactly that kind of detail: a table
that did not exist, an MCP tool that was an API-only capability, five capability
documents that were seven, a retirement clock borrowed from the wrong caller, a
sequencing order that no deploy could satisfy. Every one was a claim about code
the record was not changing. So each phase's own pull request re-derives its
detail from the tree and treats a disagreement with this record as this record
being stale, not as a reason to make the code match it. A decision ages well; an
inventory does not.

4. The names an enrolled host carries, each shipping alongside the old one and
   migrating on the next enroll: the runtime names `tachod` to `oxagend` and
   `tacho-hook` to `oxagen-hook`, and the deployed API paths the host calls.
   `apps/api/src/app.ts` mounts `/v1/tacho/enroll` and the credentialed
   `/v1/tacho` group that carries event ingest, bundle fetch and command fetch,
   plus seven organization-scoped paths under `/tacho/` for enrollments,
   enrollment revocation, enrollment tokens, hosts, sessions and incidents. A
   URL compiled into a daemon on a machine we do not control is the most
   customer-facing name in this record, so the routes are mounted under both
   spellings. Renaming them without that alias breaks every enrolled host at
   the moment of deploy, which is the failure this whole record is arranged to
   avoid. No other phase blocks the aliasing, so the server may accept both
   before any host ships the new binary name; the route filenames stay as they
   are under decision 1.

   **Two retirement clocks, not one.** An earlier draft retired every old path
   "once the fleet has re-enrolled", which is right for the paths a host calls
   and wrong for the rest. Re-enrolling a host does nothing for an independent
   API consumer, and five of these paths are published API surface in their own
   right: `docs/capabilities/tacho.host.list.md`, `tacho.session.list.md`,
   `tacho.session.get.md`, `tacho.enrollment.create.md` and
   `tacho.enrollment.revoke.md` each document the full
   `POST /v1/:org_slug/:workspace_slug/tacho/...` form, and two of them also
   publish an MCP tool and a CLI command against it. A script, a dashboard or a
   customer integration calls those directly and learns nothing from a fleet
   rollout, so retiring them on the fleet's clock would break a caller that did
   everything right.

   | Paths | Who calls them | When the old spelling stops answering |
   | --- | --- | --- |
   | `/v1/tacho/enroll` and the `/v1/tacho` group | The host daemon only | Once the fleet has re-enrolled, which the host records make observable |
   | The seven organization-scoped `/tacho/` paths | Operators, scripts and integrations, through the published `/v1/:org_slug/:workspace_slug/` form | Only after an announced API deprecation window closes, independent of the fleet |

   **The replacement paths, named.** This rename removes a word rather than
   substituting one, so "both spellings" is not derivable and an implementer
   would have to guess between `/v1/agent`, an unprefixed capability route and
   something else. The target is `agent`, the word phase 1a already shipped on
   the commands, and every one of these nine paths is free today:

   The first two are written as `app.ts` mounts them. The other seven are
   mount-relative and reach a caller with `/v1/:org_slug/:workspace_slug/` in
   front, which is the form `docs/capabilities/` publishes and the form an
   external client holds.

   | Today | Phase 4 adds |
   | --- | --- |
   | `/v1/tacho/enroll` | `/v1/agent/enroll` |
   | `/v1/tacho` (events, bundle, commands) | `/v1/agent` |
   | `/tacho/enrollments` | `/agent/enrollments` |
   | `/tacho/enrollments/revoke` | `/agent/enrollments/revoke` |
   | `/tacho/enrollment-tokens` | `/agent/enrollment-tokens` |
   | `/tacho/hosts` | `/agent/hosts` |
   | `/tacho/sessions` | `/agent/sessions` |
   | `/tacho/sessions/get` | `/agent/sessions/get` |
   | `/tacho/incidents` | `/agent/incidents` |

   All seven have a capability document, and each one's `## Surface` block moves
   in the same phase or the published path and the served path disagree. An
   earlier draft of this paragraph said five, missing
   `tacho.enrollment_token.create.md`, which publishes
   `/tacho/enrollment-tokens`, and `tacho.incident.list.md`, which publishes
   `/tacho/incidents` in a third spelling again,
   `POST /api/v1/{org}/{ws}/tacho/incidents`. Two documents left behind would
   keep directing clients at a path the phase is retiring.

   **Mounting the aliases migrates nobody. The callers move in the same phase.**
   Our own code holds the old paths in three different ways, and only one of them
   is a string in a request:

   - **Request paths compiled into clients.** `packages/tacho/src/cli/enroll.ts`
     posts to `/v1/:org/:ws/tacho/enrollments` and `/v1/tacho/enroll`,
     `cli/unenroll.ts` to `/v1/:org/:ws/tacho/enrollments/revoke`, and
     `apps/cli/src/commands/agent.ts` and `tacho.ts` to `tacho/enrollments/revoke`
     and `tacho/hosts`.
   - **The endpoint the server hands the host.**
     `packages/handlers/src/lib/tacho-host-enroll.ts` sets
     `DEFAULT_ENDPOINT = "https://api.oxagen.sh/v1/tacho"`, and the bundle written
     at enrollment carries `ingest_endpoint`, `bundle_endpoint` and
     `commands_endpoint` built from it.
   - **Endpoint triples already written into host config**, which only change when
     a host takes a new bundle.

   The second one breaks the clock this phase retires on. A host does not choose
   its endpoint; the server issues it at enrollment. So if `DEFAULT_ENDPOINT` still
   names the old path when a host re-enrolls, that host re-enrolls straight back
   onto the old path, and "the fleet has re-enrolled" stops being evidence that
   anyone left it. The condition is therefore two-part and in this order: the
   bundle issues the new endpoints, **and then** hosts have re-enrolled since,
   observable from what each host reports it is calling. Re-enrollment before the
   bundle moves proves nothing.

   So phase 4 ships the alias mounts, the client rewrites, the `DEFAULT_ENDPOINT`
   change, and route tests that assert a client reaches the new path, as one
   change. Aliases plus updated capability documents, with the callers left alone,
   is the version that passes review and breaks the fleet on the day the alias
   closes.

   **One name in that file is not a path and needs its own decision.**
   `tacho-host-enroll.ts` also sets `AUDIENCE = "tacho-collector"`, the audience
   claim on the token the host presents. It is the only occurrence in the tree, and
   it is validated on both sides, so changing it invalidates every live host token
   at once. It is not in any phase and this record does not move it: if it ever
   moves, it needs the same two-sided alias as the envelope, with the verifier
   accepting both audiences before any issuer emits the new one. Treat it as an
   identifier under decision 1 until someone writes that down.

   **The aliases carry the pre-auth ceilings or they are a hole.** This is the
   part of phase 4 that is not a rename. `apps/api/src/app.ts` registers two
   credential-stuffing ceilings, `tacho-preauth-ip` and
   `tacho-preauth-credential`, whose matchers are the literal `/v1/tacho/*`, and
   the comment above them says why they sit where they sit: registered below the
   mount they run after authentication, so every bad credential is rejected by
   auth first and counted against nothing. Mounting `/v1/agent/*` without
   equivalent matchers, in the same position relative to the mount, gives an
   attacker an unmetered door to the same authentication path. The unauthenticated
   `/v1/tacho/enroll` route depends on its own registration order for the same
   reason. So phase 4 ships the matchers and the ordering with the aliases, and a
   route test that asserts an invalid credential on a new path counts against both
   buckets. An alias that answers but does not count is worse than no alias.

   The organization-scoped group already carries `/agent/tools`,
   `/agent/memory/*`, `/agent/roles/*` and more, so these join a namespace that
   exists rather than opening one. Check each target for a collision before
   mounting it anyway: the `status` and `unenroll` collision that phase 1b hit
   was the same mistake one layer up.
5. The envelope: `oxagen.frame/1.0` accepted alongside `tacho/1.0`. **The old
   literal is not retired on a release count, and may never be retired.** An
   earlier draft said "for one release", which this codebase has already learned
   is the wrong shape. `packages/tacho/src/envelope.ts` carries the finding, about
   the legacy `user_email` member: the wire version gives an installed collector
   no signal to upgrade on, the schema is `.strict()` inside a request validator
   that rejects the WHOLE batch, so one event from an un-upgraded host takes its
   batch-mates down with it, and a sealed WAL entry already carrying the old value
   can never be rewritten or sent. That member is therefore still accepted and
   discarded rather than removed. An envelope version is the same problem with a
   wider blast radius, because every event carries it. So the collector reads both
   indefinitely, and dropping `tacho/1.0` needs host telemetry showing no enrolled
   host still sends it, not a release counter. Retiring it on a fixed schedule
   would silently discard the runs of every host that missed the window, which is
   evidence a customer cannot reconstruct.
6. `capability` to `agent tool` on the surfaces: UI strings, error messages,
   CLI output, `docs/capabilities/`, and the two rule files. The registry
   symbol and the contract files keep their names under decision 1.

**The `tacho` Postgres schema does not move, and this record said it would.**
Drafts through 2026-09-19 carried a sixth phase renaming it by Atlas migration
"after the runtime stops writing the old name". That instruction cannot be
carried out, and the schema does not meet this record's own test for a surface.

It cannot be carried out because `packages/database/src/schema/_schemas.ts:36`
is `pgSchema("tacho")`, a compile-time constant. Every reader and writer emits
schema-qualified SQL from it, and `ALTER SCHEMA ... RENAME` is atomic and total:
the old name stops resolving the instant it commits. So the runtime cannot stop
writing the old name before the migration, and cannot survive the migration
before the deploy. The expand-and-contract that normally bridges this, leaving a
compatibility schema of auto-updatable views behind, is ruled out here:
`packages/handlers/src/tacho.events.ingest.ts` uses `ON CONFLICT` at four sites
(1394, 1774, 1981, 2153), and its inference specification resolves against a
table's indexes, not a view's. The bridge would break the hottest write path in
the feature. `agent`, the obvious target name, is also already a schema, and
`_schemas.ts` records why these tables were kept out of it: so the
evidence-adjacent ones can carry append-only grants without a per-table
convention inside it.

It is not a surface because no customer reaches it. A Postgres schema name is
not in the product, the CLI output, a URL or the wire; it is reached by the code
and by an operator writing SQL. That is the identifier decision 1 keeps, by the
same reasoning this record uses to leave `docs/specs/tacho` where it is. The
one way it could leak is a constraint violation surfacing `"tacho"."sessions"`
in an operator-visible error, and the fix for that is to shape the message, not
to rename ten tables.

So the ledger is: a migration across 10 tables, needing either downtime or a
dual-write on the ingest path, to remove a word nobody outside the operators
sees. Dropping the phase is the durable call (SCR-002), not the cheap one, and
naming why here is what stops it being revived as an obvious tidy-up. What
stays true from that draft: it would have been a schema rename and not a table
rename, `tacho_sessions_runtime_check` is a constraint name, and no
`tacho_sessions` table exists, which earlier drafts of this record and of the
corpus README both claimed.

## Consequences

A reader of §2.1 who expects `git grep tacho` to come back empty will be
disappointed for several releases, and this record is the answer to why.

The fleet keeps working through the rename, which is the point. An operator who
runs `oxagen tacho enroll` from a runbook written last month gets a deprecation
line and an enrollment, not a failure.

Phase 1a is the only phase blocked on nothing, which is why it ships first and
alone. Phases 4 and 5 each ship the new name beside the old, and **no phase
retires an old name on a release count.** Every retirement here waits on evidence
about who still holds the old name, because that is the only thing that makes the
retirement safe:

| The old name | Stops answering when |
| --- | --- |
| `tachod`, `tacho-hook`, `/v1/tacho/enroll` and the `/v1/tacho` group | The bundle issues the new endpoints, and the host records then show the fleet re-enrolled since. Re-enrolling before `DEFAULT_ENDPOINT` moves puts a host back on the old path, so that order is the condition. |
| The seven organization-scoped `/tacho/` paths | An announced API deprecation window closes, independent of the fleet, because a host re-enrolling does not update a caller's script |
| `tacho/1.0` | Host telemetry shows no enrolled host still sends it, which a sealed WAL entry may make never |

So no phase leaves a host, a producer or a caller that the next phase cannot
read. An earlier draft of this paragraph said phases 4 and 5 retire the old name
"a release later", which contradicted both of those phases after review corrected
them, and following the summary instead of the phase would have reintroduced the
run-loss the envelope fix removed. Nothing depends on the database forgetting the
old name either: the schema is not renamed, and removing that phase removed the
constraint this paragraph used to be ordered around.

`pnpm check:prose` scans `apps/web` and `apps/docs`, so the `apps/docs` sweep
is the one part of phase 3 with a gate behind it. It does not scan `docs/` or
`apps/app`'s message catalogues, so neither the internal corpus nor phase 6's UI
strings are held by anything but review until that scanner's scope grows.

The two commands that gain an optional argument are governance commands, so
each needs a test for both forms: with the argument, the server-scoped read it
always did, and without it, this machine.
