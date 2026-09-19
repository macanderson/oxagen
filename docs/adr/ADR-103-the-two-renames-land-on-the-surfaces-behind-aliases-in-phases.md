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
- **Delivered by:** this record, and the phase order it sets. No code changes
  with it.

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

**3. The three colliding CLI names resolve by argument, not by renaming either
side.** `oxagen agent status` with no argument reports this machine.
`oxagen agent status <agent>` reports that agent. The same split applies to
`unenroll`. `oxagen agent enroll` takes `--token` when it has an enrollment
token and falls back to the logged-in session when it does not, which is the
only difference between the two enrollment paths today.

This changes two existing commands: `status <agent>` and `unenroll <agent>`
take an optional argument where the argument was required. That is additive for
every caller that passes one. It is chosen over `oxagen agent host status`
because the spec names the three commands directly, and over renaming the
server-scoped commands because those names are the ones an operator already
knows.

**4. The phases ship in this order, each on its own branch and its own pull
request.**

1. The CLI surface: `oxagen agent` gains the seven wrapping subcommands,
   `oxagen tacho` becomes a hidden forwarder, and the three user-visible
   strings point at the new command. One phase, because a string that names a
   command the reader cannot run is worse than the old word.
2. The docs: `docs/specs/tacho/` and the 115 files that reference it.
3. The runtime names: `tachod` to `oxagend`, `tacho-hook` to `oxagen-hook`,
   each shipping the new name alongside the old and migrating on the next
   enroll.
4. The envelope: `oxagen.frame/1.0` accepted alongside the current name, with
   the collector reading both for one release.
5. The database: the `tacho_sessions` table and the
   `tacho_sessions_runtime_check` constraint, by Atlas migration, after the
   runtime no longer writes the old name.
6. `capability` to `agent tool` on the surfaces: UI strings, error messages,
   CLI output, `docs/capabilities/`, and the two rule files. The registry
   symbol and the contract files keep their names under decision 1.

## Consequences

A reader of §2.1 who expects `git grep tacho` to come back empty will be
disappointed for several releases, and this record is the answer to why.

The fleet keeps working through the rename, which is the point. An operator who
runs `oxagen tacho enroll` from a runbook written last month gets a deprecation
line and an enrollment, not a failure.

Phase 1 is the only phase that is blocked on nothing. Phases 3, 4, and 5 are
ordered by what writes the name: the runtime stops writing the old value before
the database forgets how to store it, so no phase leaves a row the next phase
cannot read.

`pnpm check:prose` does not scan `apps/app` message catalogues, so it cannot
hold phase 1 or phase 6. A string that carries a retired word is caught by
review, not by the gate, until that scanner's scope grows.

The two commands that gain an optional argument are governance commands, so
each needs a test for both forms: with the argument, the server-scoped read it
always did, and without it, this machine.
