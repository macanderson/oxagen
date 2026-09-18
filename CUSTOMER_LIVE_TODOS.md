# Customer-live to-dos

The register of every decision Oxagen made because it has no customers yet, and
has to revisit before it does.

A choice on this list is not a defect and not debt in the usual sense. Each one
was correct when it was made: with nobody live in production, tracing an outage
to a single merge, keeping a staging account in sync, or serializing a merge
queue buys nothing and costs speed. Each one stops being correct the day real
traffic arrives. This file is where those choices wait so the day does not
arrive first.

**Scope:** this is not the backlog. A defect goes to an issue, an open design
question goes to an ADR under `docs/adr/`, and a scope decision about what
Oxagen sells goes to `DEREGISTERED.md`. What belongs here is narrower: a
decision that is right now, wrong later, and whose trigger is a customer rather
than a sprint.

**Status:** opened 2026-09-18.

---

## What earns a place

An entry belongs here when all three are true.

1. It is a decision already in effect, not a proposal. The code, the config, or
   the rule is live on `main` today.
2. It was taken **because** there are no customers. If the reason holds with a
   thousand of them, it is not a customer-live to-do, it is a design choice.
3. A person can tell when it comes due. "Before the first paying customer" and
   "before production carries tenant data" are triggers. "Later" is not.

## What does not

- A defect. File an issue: it is wrong today, not wrong later.
- An open design question with no decision in effect. Decide it in the pull
  request, or write an ADR.
- A feature nobody has built. That is a roadmap item.
- A scope decision about what ships this quarter. That is `DEREGISTERED.md`.

## How to add one

Append a row, then a section under it with the same title. The section carries
what a person picking it up cold needs: what is in effect, where it lives, why
it was chosen, what changes, and how you know it is done. Link the pull request
or the ADR that put it in effect, so the reasoning survives the person.

---

## The register

| # | What | Trigger | Owner decides |
| --- | --- | --- | --- |
| 1 | Pull requests carry more than one change | First paying customer | Maintainer |
| 2 | `main` does not require a branch to be up to date before merge | First paying customer | Maintainer |
| 3 | Stripe runs against a sandbox account | Customer-facing billing cutover | Maintainer |
| 4 | De-registered features stay in the tree | Reassessed per release | Maintainer |

---

### 1. Pull requests carry more than one change

**In effect:** `docs/scr/SCR-004-residue-becomes-issues.md`, "Scope, and when
this rule changes". A pull request fixes defects it finds along the way, even
ones unrelated to its title, rather than deferring them to issues.

**Why now:** the maintainer decided this on 2026-09-06. It trades a
one-fix-per-pull-request history for speed, on purpose, during a period when
tracing a production outage back to the change that caused it is not a concern.

**What changes:** a pull request goes back to carrying one change, so an outage
bisects to one merge, and SCR-004's deferral cases narrow.

**Done looks like:** SCR-004's scope section is rewritten rather than deleted,
and the sentence naming 2026-09-06 says what replaced it and when.

### 2. `main` does not require a branch to be up to date before merge

**In effect:** the ruleset on `main` sets `strict_required_status_checks_policy:
false`. Read it with `gh api repos/macanderson/oxagen/rules/branches/main`. The
classic branch-protection endpoint returns 404, which does not mean the branch
is unprotected.

**Why now:** strict mode serializes merges. Every pull request has to re-run CI
against the new base each time anything lands ahead of it, which on a repository
merging several changes an hour costs more than it returns while nothing is
live.

**What it costs today:** a pull request is green against a base that has since
moved, and no check on the pull request path runs after the combination.

This is not theoretical. `packages/database/storage-manifest.json` is generated,
and the `contentHash` it records is a hash of the body it sits in. #3233 merged
on 2026-09-18 carrying a body of 319 capabilities and a `contentHash` of
`fe163569`, which is the hash of neither that body nor the 315-capability body
before it. The correct hash for what it committed is `d6f74054`. Git assembled
the final body at a moment after the last `pnpm schema:manifest` run on that
branch, and nothing recomputes the hash after git combines a file. #3233's own
checks were green, because they ran before that assembly. `main` went red on the
merge and stayed red until #3266 re-recorded the hash. The merge was clean. It
was not correct.

**What changes:** set `strict_required_status_checks_policy: true`, or add a
merge queue, so a branch is tested against the base it actually lands on.

**Done looks like:** a pull request whose base has moved cannot merge on a stale
green, and a generated file regenerated by two branches is caught before it
reaches `main` rather than after.

### 3. Stripe runs against a sandbox account

**In effect:** `docs/ops/stripe-sandbox-mode.md`. Rows in
`billing.subscriptions`, `billing.customers` and `billing.payment_methods` that
reference the previous Oxagen Inc. account (`acct_1TCS8FBqX8HwIjwR`, test mode)
do not resolve in the sandbox. That account's `api.oxagen.sh` webhook endpoint
was disabled on 2026-09-13 so it stops posting events the API can no longer
verify.

**Why now:** unresolvable rows point at nobody's money.

**What changes:** a customer-facing cutover re-syncs `billing.plans` and
reconciles or retires the rows that reference the old account. The document's
own cutover section is the procedure.

**Done looks like:** every row in the three billing tables resolves against the
live account, and no customer-visible surface reads an object that does not.

### 4. De-registered features stay in the tree

**In effect:** `DEREGISTERED.md`. A feature taken off Oxagen's surfaces keeps
its contract, handler, route, tool, page, component, and package. It loses
reach, not code.

**Why now:** Oxagen is pre-customer and still finding its shape, so a scope
decision made for one release is a statement about what it sells this quarter,
not a judgement that the code was wrong. Deleting on a scope decision turns a
reversible call into an irreversible one.

**What changes:** less than the others. The rent is a compile, a test run, and a
dependency bump per feature, and it stays payable. What a live product adds is a
reason to decide per feature whether the reversal is still plausible: code that
has been unreachable across two releases and has no customer asking for it is a
deletion, not a de-registration.

**Done looks like:** each row in `DEREGISTERED.md` has been read once against a
live roadmap and either kept with a reason or deleted.

---

## Related

- `DEREGISTERED.md`: what came off the surfaces, and where the code still is.
- `docs/scr/SCR-004-residue-becomes-issues.md`: what a pull request defers and
  what it fixes.
- `docs/ops/stripe-sandbox-mode.md`: the sandbox, and the cutover it needs.
