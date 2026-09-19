# ADR-103: The two §2.1 renames land on the surfaces, behind aliases, in phases

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** cli, kernel, app, docs
- **Related:** Mission Control spec §2.1 (the two renames, applied
  everywhere); ADR-025 (verb-first snake_case capability names, with no alias
  fallback); ADR-101 (four first-class harnesses); `docs/specs/tacho/spec.md`
  §5.1 (enrollment); `apps/cli/src/program.ts` (the command tree)
- **Numbering:** 103. ADR-102 is taken twice, by the mandate row lock and by
  the marketing ebook lead gate
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
administrator has already distributed. Renaming them without a migration
un-enrolls those machines. `oxagen.frame/1.0` is the envelope on the wire
between the hook, the collector, and the server, so its name is a protocol
term, not a label.

On the other side, ADR-025 retired the dotted capability form **with no alias
fallback**, and MCP tool names are the wire contract that a customer's agent
calls. A rename that reaches those names breaks callers with no fallback by
that ADR's own design.

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
3. The docs. Measured on `756469151`, 119 files under `docs/` carry the word,
   and the count is the wrong unit of work. Four categories are excluded, for
   reasons decision 1 already gives:

   | Where | Files | Why it is excluded |
   | --- | --- | --- |
   | `docs/capabilities/schemas/` | 16 | Generated from the contracts. The name follows the contract, which keeps it under decision 1. |
   | `docs/capabilities/*.md` | 26 | Filename and `**Surfaces:**` track the registered name, and `check-capability-docs` enforces the match. |
   | `docs/adr/` | 33 | A dated record of what was decided. Two carry the word in the filename. Rewriting one is rewriting the record. |
   | `docs/audits/` | 2 | Dated records, same reason. |

   That leaves the 17 files of `docs/specs/tacho/`, which are the canonical
   description, and the current-tense product prose in about 20 other files,
   which is where a reader meets the word.

   **The directory keeps its path.** `docs/specs/tacho` is referenced 59 times,
   and most of those are comments in source files across `packages/database`,
   `packages/telemetry`, `packages/oxagen`, `packages/run-ledger` and
   `packages/tacho`. Nothing checks those paths, so a move breaks them
   silently. A repository path nobody outside the tree reads is an internal
   identifier, and decision 1 says those change when their file is being
   changed for another reason, not as a campaign.

   **The prose keeps naming what exists.** `tachod`, `tacho-hook`,
   `oxagen.frame`, `tacho_sessions` and `ingest_tacho_events` are live until
   phases 4 through 6 rename them. A doc that calls them something else is a
   doc that is wrong, so each one keeps its name and says which phase moves it.
   The word goes from the concept, which has no product name: doing it is
   wrapping an agent.
4. The runtime names: `tachod` to `oxagend`, `tacho-hook` to `oxagen-hook`,
   each shipping the new name alongside the old and migrating on the next
   enroll.
5. The envelope: `oxagen.frame/1.0` accepted alongside the current name, with
   the collector reading both for one release.
6. The database: the `tacho_sessions` table and the
   `tacho_sessions_runtime_check` constraint, by Atlas migration, after the
   runtime no longer writes the old name.
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
