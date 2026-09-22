# The post-customer era

Oxagen runs in two eras.

**The pre-customer era** is now. Nobody is live in production. Tracing an outage
back to one merge, keeping a staging account in sync, and serializing a merge
queue all cost speed and return nothing, so Oxagen does not pay for them. That
is a deliberate trade, not an oversight.

**The post-customer era** starts at the first paying customer. On that day a
production incident has someone on the other end of it, and every trade above
inverts.

This file is the register of what has to change at that boundary, and the plan
for changing it. It exists so the boundary does not arrive before the list does.

**Status:** opened 2026-09-18. #3268 records the options and the recommendation
for each item, as a reference. It is not a parent, an epic, or a tracking
ticket, and nothing closes because of it: this repo carries one full change per
issue and adds checklist rows rather than hierarchy (AGENTS.md, SCR-004). Each
item below gets its own independent issue, linked from #3268 and standing on its
own — their definitions of done have nothing in common, so an issue that closed
only when all of them were done could never close. The one exception is items 4
and 5, which are a single change and so share a single issue — the "Order to do
them in" section below says why.

---

## What earns a place

An entry belongs here when all three are true.

1. It is in effect on `main` today. Not a proposal, not a worry: the code, the
   config, or the rule is live.
2. It is the way it is **because** there are no customers. If the reason holds
   with a thousand of them, it is a design choice and belongs in an ADR.
3. A person can recognise its trigger. "Before the first paying customer" and
   "before production carries tenant data" are triggers. "Later" is not.

## What does not

- A defect. File an issue: it is wrong today, not wrong later.
- An open design question with no decision in effect. Decide it in the pull
  request, or write an ADR under `docs/adr/`.
- A feature nobody has built. That is a roadmap item.
- A scope decision about what Oxagen sells this quarter. That is
  `DEREGISTERED.md`.

## How to add one

Append a row to the register, then a section with the same title carrying what a
person picking it up cold needs: what is in effect, where it lives, why it was
chosen, what changes, and how you know it is done. Link the pull request, ADR,
or issue that put it in effect, so the reasoning survives the person who holds
it.

---

## The register

| # | What | Perspective | Trigger |
| --- | --- | --- | --- |
| 1 | A branch need not be up to date with `main` before it merges | CI | First paying customer |
| 2 | A pull request carries more than one change | CI | First paying customer |
| 3 | Every change merges straight to `main`; there is no integration branch | CI | First paying customer |
| 4 | Production migrations have no automatic trigger and run by hand | Migration | Before production carries tenant data |
| 5 | A deploy no longer waits for its migration | Deploy | Before production carries tenant data |
| 6 | There is no staging or preview host | Deploy | First paying customer |
| 7 | Stripe runs against a sandbox account | Product | Billing cutover |
| 8 | De-registered features stay in the tree | Product | Per release |

---

## CI

### 1. A branch need not be up to date with `main` before it merges

**In effect:** main's ruleset sets `strict_required_status_checks_policy: false`.
Read it with `gh api repos/macanderson/oxagen/rules/branches/main`. The classic
branch-protection endpoint returns 404, which does not mean the branch is
unprotected.

**Why now:** strict mode serializes merges. Every pull request re-runs CI
against the new base each time anything lands ahead of it, which costs more than
it returns while nothing is live.

**What it costs today:** a pull request is green against a base that has since
moved, and no check runs against the combination that actually lands.

`packages/database/storage-manifest.json` is generated, and the `contentHash` it
records is a hash of the body it sits in. #3233 merged on 2026-09-18 carrying a
body of 319 capabilities and a `contentHash` of `fe163569`, which is the hash of
neither that body nor the 315-capability body before it. The correct hash for
what it committed is `d6f74054`. Git assembled the final body at a moment after
the last `pnpm schema:manifest` run on that branch, and nothing recomputes the
hash after git combines a file. #3233's own checks were green, because they ran
before that assembly. `main` went red on the merge and stayed red until
`b823d6b3d` re-recorded the hash, reaching `main` when #3265 merged. (#3266 was
opened for the same repair in parallel and closed as a duplicate once that
landed.) The merge was clean. It was not correct.

**What changes:** set `strict_required_status_checks_policy: true`, or put a
merge queue in front of `main`, so a branch is tested against the base it lands
on.

**Done looks like:** a pull request whose base has moved cannot merge on a stale
green, and a generated file regenerated by two branches is caught before `main`
rather than after.

### 2. A pull request carries more than one change

**In effect:** `.oxagen/rules/ctx.scr.004-fix-over-file.toml`, "Scope, and when
this rule changes". A pull request fixes defects it finds along the way, even
ones unrelated to its title.

**Why now:** the maintainer decided this on 2026-09-06. It trades a
one-fix-per-pull-request history for speed, on purpose, during a period when
tracing a production outage to the change that caused it is not a concern.

**What changes:** a pull request goes back to carrying one change, so an outage
bisects to one merge, and SCR-004's deferral cases narrow.

**Done looks like:** SCR-004's scope section is rewritten rather than deleted,
and the sentence naming 2026-09-06 says what replaced it and when.

### 3. Every change merges straight to `main`; there is no integration branch

**In effect:** `main` is the only long-lived branch. `pipeline.yml` deploys
`deploy-web` and `deploy-node` on every push to it. Oxagen has run an
integration branch before, for one cutover: `app-rebuild`, named in
`docs/specs/mission-control/plan.md`.

**Why now:** an integration branch buys a place to prove a set of changes
together before anyone sees them. With nobody live, `main` already is that
place.

**What changes:** the honest answer is that an integration branch is one of two
shapes, and the choice is not obvious. A **release branch** cuts from `main`,
gets a soak, and deploys from there, which keeps `main` fast and makes the
deployed commit an explicit decision. A **merge queue** keeps one branch and
tests each change against the base it lands on, which fixes item 1 as a side
effect but serializes merges.

A release branch is the better fit for a five-customer product: it decouples
"merged" from "deployed" without slowing anyone down, and it gives a rollback
target that is a branch rather than a revert. A merge queue is the better fit
once merge volume makes stale-base breakage routine.

**Done looks like:** `main` is no longer the thing that deploys, or it is, and
the decision is written down in an ADR with the trade named.

---

## Migration

### 4. Production migrations have no automatic trigger and run by hand

**In effect:** `.github/workflows/db-migrate.yml` is manual
(`workflow_dispatch`) and its own header says it is not the working path for
production. `pipeline.yml` carried a `migrate` job that applied Atlas migrations
to production on every push to `main`; it was retired in #1341 having been
unable to act on any event since #1280. The path that reaches production
Postgres is `infra/tools/run-db-migrations.sh`, run from the app node itself,
because Aurora's security group on account `916294258235` admits 5432 only from
that node, so a hosted runner always fails the reachability guard (#2652).

**Why now:** with nobody live, a schema that lags the code is an inconvenience
someone fixes by hand that afternoon.

**What it costs today:** production drifts behind the migration directory until
a person notices. It has already produced `column ... does not exist` 500s in
production, most recently on 2026-09-09 (#1275).

**What changes:** production migrations get a real trigger again. That means
solving the reachability problem the manual path exists to work around: a runner
inside the VPC, a bastion path, or a job on the app node that CI can ask for.

**Done looks like:** a merge that adds a migration applies it to production
without a person, or refuses to deploy the code that needs it. #1275 is the
issue that owns this.

### 5. A deploy no longer waits for its migration

**In effect:** `pipeline.yml`'s `deploy-node` declares `needs: [checks, test]`.
Its own comment records what used to be there and why it went:

> This used to also wait on `migrate`, because api and app read a schema the
> same merge may have changed, and deploying code ahead of its migration is what
> took production login down once already. That job is retired (#1341) and had
> applied nothing since #1280, so the wait had been decorative for months.

**Why now:** the wait guarded an ordering that item 4 had already removed.
Keeping a decorative `needs` would have been worse than deleting it, because it
would read as a guarantee.

**What changes:** restoring the ordering is the same work as item 4, and the
comment says so. Code must not reach production ahead of the schema it reads.

**Done looks like:** `deploy-node` cannot publish a commit whose migrations
have not applied, and the guarantee is tested rather than assumed. `deploy-web`
is deliberately excluded: it builds and publishes `apps/web/dist`, the static
marketing site, and reads no application schema, so ordering it behind a
migration would take the website down for a database problem it has no part in.
The ordering follows what reads the schema, not what deploys.

---

## Deploy

### 6. There is no staging or preview host

**In effect:** `infra/tools/caddy/Caddyfile` serves five hostnames, all
production: `stella`, `docs`, `app`, `api`, and `mcp` on `oxagen.sh`.
`docs/ops/stripe-sandbox-mode.md` records the consequence for billing: there is
no staging API host, so local development uses `stripe listen` through
`tools/scripts/stripe-tunnel.ts` with a per-session secret.

**Why now:** a second environment is a second thing to keep in sync, pay for,
and debug. With nobody live, production is a safe place to be wrong.

**What it costs today:** a change is proven in CI and then in production. CI is
good (`e2e`, `rls-integration`, `rds-compatibility`, `atlas-validate` all run on
every pull request), but it is not a long-lived environment with real data
shapes, real DNS, and real third parties.

**What changes:** a staging environment that mirrors production's topology
closely enough to be worth trusting, including its own Stripe account, its own
database, and its own hostnames.

**Done looks like:** a change reaches at least one environment with production's
shape before it reaches a customer, and the billing cutover in
`docs/ops/stripe-sandbox-mode.md` has somewhere to rehearse.

---

## Product

### 7. Stripe runs against a sandbox account

**In effect:** `docs/ops/stripe-sandbox-mode.md`. Rows in
`billing.subscriptions`, `billing.customers`, and `billing.payment_methods` that
reference the previous Oxagen Inc. account (`acct_1TCS8FBqX8HwIjwR`, test mode)
do not resolve in the sandbox. That account's `api.oxagen.sh` webhook endpoint
was disabled on 2026-09-13 so it stops posting events the API can no longer
verify.

**Why now:** unresolvable rows point at nobody's money.

**What changes:** a customer-facing cutover re-syncs `billing.plans` and
reconciles or retires the rows referencing the old account. That document's
cutover section is the procedure.

**Done looks like:** every row in the three billing tables resolves against the
live account, and no customer-visible surface reads an object that does not.

### 8. De-registered features stay in the tree

**In effect:** `DEREGISTERED.md`. A feature taken off Oxagen's surfaces keeps
its contract, handler, route, tool, page, component, and package. It loses
reach, not code.

**Why now:** Oxagen is pre-customer and still finding its shape, so a scope
decision made for one release is a statement about what it sells this quarter,
not a judgement that the code was wrong. Deleting on a scope decision turns a
reversible call into an irreversible one.

**What changes:** less than the others. The rent is a compile, a test run, and a
dependency bump per feature, and it stays payable. What a live product adds is a
reason to decide per feature whether the reversal is still plausible: code
unreachable across two releases with no customer asking for it is a deletion,
not a de-registration.

**Done looks like:** each row in `DEREGISTERED.md` has been read once against a
live roadmap and either kept with a reason or deleted — and a deletion still
lands the ADR naming the feature being removed, which is the rule AGENTS.md
states. Note what enforces it: `check:deregistered` reads only the §14
`preserved-paths` block and asserts every path still listed there exists. A
deletion that also removes the path from that block passes the guard without it
reading §13 or looking for an ADR. The ADR requirement is a rule people follow,
not a check CI makes, so do not merge on the guard's green as though it had
verified one. The roadmap review decides *whether* a row is worth retaining; it
is not itself the authorisation to delete it.

---

## Order to do them in

Not every item comes due on the same day, and two of them are the same work.

1. **Items 4 and 5, together, first.** They are one change: production
   migrations get a trigger, and the deploy waits for it. This is the only item
   on the list that has already caused a production incident, and it is the only
   one whose failure mode is silent until a request hits the missing column.
2. **Item 1.** One ruleset field or one merge queue. It has already cost a red
   `main` once, and the fix is the smallest on the list.
3. **Item 6.** A staging environment is the longest lead time here, and items 7
   and 3 both get easier once it exists.
4. **Item 7**, which needs item 6 to rehearse against.
5. **Item 3**, once merge volume or deploy risk makes the shape obvious. Writing
   the ADR can happen earlier than the change.
6. **Items 2 and 8** are rule changes, not code. They cost a document edit each
   and can land on the day the era turns.

## Related

- #3268: the plan, with the options weighed and a recommendation for each item.
- `DEREGISTERED.md`: what came off the surfaces, and where the code still is.
- `.oxagen/rules/ctx.scr.004-fix-over-file.toml`: what a pull request defers.
- `docs/ops/stripe-sandbox-mode.md`: the sandbox, and the cutover it needs.
- `.github/workflows/db-migrate.yml`: the manual migration runner, and its own
  account of why it is manual.
