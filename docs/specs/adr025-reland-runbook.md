# ADR-025 re-land runbook — prod IAM re-seed (the one merge gate for #711)

**Why this exists.** ADR-025 renamed every capability to verb-first snake_case and
**removed the alias shim**. IAM authorizes by an exact match on
`iam.role_grants.capability_id` = the capability's canonical name. In prod those
rows are still keyed by the OLD dotted names (`org.create`, `graph.ingest`, …),
so the moment the snake-named code serves traffic, IAM finds no matching grant
and **denies every capability** — a second outage, different cause. This runbook
re-seeds the snake-keyed grants so the cutover is clean.

## The key fact that makes this safe

`tools/scripts/seed-iam-defaults.ts` (`pnpm db:seed-iam`) inserts one
`iam.role_grants` row per org × system-role × capability `defaultRoles` entry,
keyed by `capability_id = cap.name` and `public_id = sha256(roleId:capabilityId)`,
with **`ON CONFLICT DO NOTHING`**. Post-rename that means:

- It **inserts NEW snake-keyed rows** (new `capability_id`, new `public_id`).
- It **touches nothing existing** — the old dotted rows keep their own
  `public_id`, so they are neither updated nor deleted.

So the re-seed is **purely additive and idempotent**. Running it against the
currently-running (dotted) prod is harmless: the old dotted code keeps matching
the dotted rows, and the new snake rows sit ready for the snake deploy.

## Order of operations (seed FIRST, then merge+deploy — zero-downtime)

> Do NOT merge/deploy first. If snake code deploys before the snake grants
> exist, IAM denies everything until the seed lands.

1. **Checkout the re-land code** (it defines the snake `cap.name`s the seed reads):
   ```bash
   git fetch origin && git checkout feat/adr025-reland   # PR #711
   pnpm i --no-frozen-lockfile
   ```
2. **Target prod explicitly** (postgres-owner URL, NOT the runtime `oxagen_app`
   role — same as prod migrations). A stray shell `DATABASE_URL` silently wins,
   so unset it first and echo the sanitized target to confirm:
   ```bash
   unset DATABASE_URL
   export DATABASE_URL="$PRODUCTION_DATABASE_URL"   # postgres-owner, from repo-root .env.local
   node -e 'const u=new URL(process.env.DATABASE_URL);console.log("TARGET:",u.host,u.pathname)'
   ```
3. **Re-seed the snake grants** (additive, idempotent):
   ```bash
   pnpm db:seed-iam
   ```
   Expect it to report a large `inserted` count (the snake rows) and a large
   `skipped` count (existing dotted rows are a different public_id → not skipped;
   skips are only re-runs). Also run `pnpm db:backfill-iam --apply` only if there
   are orgs with zero principals (it self-skips already-seeded orgs).
4. **Verify with a SELECT before trusting logs** — snake grants must exist:
   ```sql
   -- representative snake capabilities should have grants across orgs
   SELECT capability_id, count(*) AS grants
   FROM iam.role_grants
   WHERE capability_id IN ('create_org','set_plugin_enabled','send_message',
                           'list_agent_tools','ingest_graph','recall_memory')
   GROUP BY capability_id ORDER BY capability_id;
   -- and confirm snake now dominates (dotted rows remain but are inert)
   SELECT (capability_id LIKE '%.%') AS is_dotted, count(*)
   FROM iam.role_grants GROUP BY 1;
   ```
5. **Merge #711 and deploy.** Now snake code + snake grants align; the dotted
   rows are inert. (Apply any pending Atlas migrations the manual-apply way if
   CI is still billing-blocked.)

## ClickHouse — no migration needed for dispatch

`tool_invocations.capability_name` is append-only telemetry. Historical rows stay
dotted; new events emit the snake name (metering keys on the canonical name).
Dispatch/IAM do not read it, so it does not gate the merge. Only analytics that
span the cutover need care — either filter by time or UNION the dotted+snake
names. `tools/scripts/fanout-token-metrics.ts` already queries the snake names
(matches post-cutover data).

## Rollback

The re-seed is additive, so it never needs rolling back. If the snake **deploy**
misbehaves, roll back the deploy only — the dotted `role_grants` are still present,
so the previous dotted build keeps authorizing normally. Once the snake deploy is
confirmed healthy for a while, the inert dotted rows can be pruned as hygiene
(`DELETE FROM iam.role_grants WHERE capability_id LIKE '%.%'`) — optional, non-urgent.

## Verification artifacts already captured (branch feat/adr025-reland)

- Kernel dispatch probe 5/5 — `verifications/<session>/naming-probe-reland.txt`.
- `git grep` dotted `invoke(`/`getCapability(` call-sites = 0; dotted
  `registerHandler(` keys = 0; `check-naming` 293 conform.
- Typecheck exit 0: oxagen, handlers, agent, api, app (proves main's post-revert
  #697/#698/#701 code compiles against the snake names).
