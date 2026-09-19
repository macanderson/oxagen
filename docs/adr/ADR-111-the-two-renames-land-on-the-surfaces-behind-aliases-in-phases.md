# ADR-111: The two §2.1 renames land on the surfaces, behind aliases, in phases

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** cli, kernel, app, docs
- **Related:** Mission Control spec §2.1 (the two renames, applied
  everywhere); ADR-025 (verb-first snake_case capability names, with no alias
  fallback); ADR-101 (four first-class harnesses); `docs/specs/tacho/spec.md`
  §5.1 (enrollment); `apps/cli/src/program.ts` (the command tree)
- **Numbering:** 111. This record was written as ADR-103 on 2026-09-19 and
  renumbered the same day: ADR-103 was already the price book recording its own
  initialization, added at 07:50 UTC, and this one landed at 18:21. Two records
  under one number left `packages/database/src/schema/cost.ts` and
  `apps/cli/src/program.ts` citing "ADR-103" for different documents. The
  earlier record keeps the number. A commit message or pull request body from
  before the rename still says ADR-103; this line is the trail. ADR-102 and
  ADR-109 are each taken twice and are not this record's to renumber.
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

   38 + 3 + 26 + 39 + 13 = 119. The file counts are a size, not a work list: a
   capability document has a filename and a `**Surfaces:**` line that stay and
   sentences that change, and `check-capability-docs` compares only that line
   against the contract, so it is not a reason to leave the sentences alone.

   **The directory keeps its path.** `docs/specs/tacho` is referenced 59 times,
   and most of those are comments in source files across
   `packages/database`, `packages/telemetry`, `packages/oxagen`,
   `packages/run-ledger` and `packages/tacho`. Nothing checks those paths, so a
   move breaks them silently, and a repository path nobody outside the tree
   reads is the internal identifier decision 1 leaves alone.

   **The prose keeps naming what exists.** `tachod`, `tacho-hook`, `tacho/1.0`
   and the `tacho` Postgres schema are live until phases 4, 5 and 6 rename
   them. The envelope's live name is `tacho/1.0`, the one literal
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

4. The names an enrolled host carries, each shipping alongside the old one and
   migrating on the next enroll: the runtime names `tachod` to `oxagend` and
   `tacho-hook` to `oxagen-hook`, and the deployed API paths the host calls.
   `apps/api/src/app.ts` mounts `/v1/tacho/enroll` and the credentialed
   `/v1/tacho` group that carries event ingest, bundle fetch and command fetch,
   plus seven organization-scoped paths under `/tacho/` for enrollments,
   enrollment revocation, enrollment tokens, hosts, sessions and incidents. A
   URL compiled into a daemon on a machine we do not control is the most
   customer-facing name in this record, so the routes are mounted under both
   spellings and the old ones answer until the fleet has re-enrolled. Renaming
   them without that alias breaks every enrolled host at the moment of deploy,
   which is the failure this whole record is arranged to avoid. Aliasing them
   is blocked on nothing, so the server may accept both before any host ships
   the new binary name; the route filenames stay as they are under decision 1.
5. The envelope: `oxagen.frame/1.0` accepted alongside the current name, with
   the collector reading both for one release.
6. The database: the `tacho` Postgres schema, by Atlas migration, after the
   runtime no longer writes the old name. It is a schema rename rather than a
   table rename. `packages/database/src/schema/tacho.ts` declares 10 tables on
   `tachoSchema`, and the migrations create them as `"tacho"."sessions"`,
   `"tacho"."hosts"`, `"tacho"."incidents"` and the rest, so the word is in the
   schema that qualifies all 10. `tacho_sessions_runtime_check` is a constraint
   name, not a table, and the `tacho_sessions_*` prefixes on constraints and
   indexes move with it. Earlier drafts of this record and of the corpus README
   named a `tacho_sessions` table, which does not exist.
7. `capability` to `agent tool` on the surfaces: UI strings, error messages,
   CLI output, `docs/capabilities/`, and the two rule files. The registry
   symbol and the contract files keep their names under decision 1.

## Consequences

A reader of §2.1 who expects `git grep tacho` to come back empty will be
disappointed for several releases, and this record is the answer to why.

The fleet keeps working through the rename, which is the point. An operator who
runs `oxagen tacho enroll` from a runbook written last month gets a deprecation
line and an enrollment, not a failure.

Phase 1a is the only phase that is blocked on nothing, which is why it ships first and alone. Phases 3, 4, and 5 are
ordered by what writes the name: the runtime stops writing the old value before
the database forgets how to store it, so no phase leaves a row the next phase
cannot read.

`pnpm check:prose` does not scan `apps/app` message catalogues, so it cannot
hold phase 1 or phase 6. A string that carries a retired word is caught by
review, not by the gate, until that scanner's scope grows.

The two commands that gain an optional argument are governance commands, so
each needs a test for both forms: with the argument, the server-scoped read it
always did, and without it, this machine.
