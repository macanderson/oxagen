# ADR-025 re-land runbook — prod IAM re-seed (the one merge gate for #711)

**Status: DRAFT — text only. Do NOT execute any of this against prod without the
user's explicit, direct go. #711 stays a DRAFT until then.**

> **Stale after launch pruning (2026-07-21):** do not execute this runbook until
> its capability set and grant remap are regenerated. It still contains names for
> retired graph mutation, code-map, graph-sync, lineage, and inference surfaces.

**Why this exists.** ADR-025 renamed every capability to verb-first snake_case and
**removed the alias shim**. IAM authorizes on an exact match of
`iam.role_grants.capability_id` = the capability's canonical name. In prod those
rows are still keyed by the OLD dotted names (`org.create`, …), so the moment the
snake-named build serves traffic IAM finds no matching grant and **denies every
capability** — a second outage, different cause. This runbook makes the cutover clean.

## Two classes of grant, two different fixes

`iam.role_grants` rows split by the role's `is_system_default`:

- **System roles** (Owner/Admin/Member/…, `is_system_default = true`) —
  `pnpm db:seed-iam` re-creates their grants from each capability's `defaultRoles`
  keyed by the snake `cap.name` (`INSERT … ON CONFLICT DO NOTHING`, additive).
- **Custom roles** (`is_system_default = false`, customer-created) — the seed does
  **NOT** touch them. Their dotted grants must be remapped in place (step d).

`public_id = 'rlg_' || substr(sha256(role_id || ':' || capability_id), 1, 24)`; the
step-(d) UPDATE recomputes it so remapped rows stay self-consistent (pgcrypto `digest`).

Everything below is **additive/idempotent** and safe against the still-running dotted
prod, so the order is **seed FIRST, then merge+deploy** (zero-downtime).

---

### (a) ASSESSMENT — measure before touching anything (read-only)
```sql
-- Overall dotted vs snake split of role_grants:
SELECT (capability_id LIKE '%.%') AS is_dotted, count(*) AS grants
FROM iam.role_grants GROUP BY 1 ORDER BY 1;

-- Dotted grants by role class. The is_system_default=false bucket is the one the
-- seed will NOT recreate → it needs the step-(d) UPDATE:
SELECT ro.is_system_default,
       count(*)                         AS dotted_grants,
       count(DISTINCT rg.capability_id)  AS distinct_dotted_caps,
       count(DISTINCT rg.role_id)        AS roles
FROM iam.role_grants rg
JOIN iam.roles ro ON ro.id = rg.role_id
WHERE rg.capability_id LIKE '%.%'
GROUP BY ro.is_system_default;

-- The exact custom-role dotted capabilities step (d) will remap:
SELECT DISTINCT rg.capability_id
FROM iam.role_grants rg
JOIN iam.roles ro ON ro.id = rg.role_id
WHERE ro.is_system_default = false AND rg.capability_id LIKE '%.%'
ORDER BY 1;
```

### (b) PRE-SEED — system-role grants (run from the re-land checkout, BEFORE merge)
```bash
git fetch origin && git checkout feat/adr025-reland   # PR #711 — snake cap.names
pnpm i --no-frozen-lockfile
# Target prod's postgres-OWNER url (NOT the runtime oxagen_app role). A stray shell
# DATABASE_URL silently wins — unset it, then echo the sanitized target to confirm:
unset DATABASE_URL
export DATABASE_URL="$PRODUCTION_DATABASE_URL"        # owner url from repo-root .env.local
node -e 'const u=new URL(process.env.DATABASE_URL);console.log("TARGET:",u.host,u.pathname)'
pnpm db:seed-iam                                       # additive: inserts snake grants for system roles
```

### (c) VERIFY the pre-seed (read-only — trust the SELECT, not the logs)
```sql
-- Snake grants for representative caps must now exist across orgs (>0 each):
SELECT capability_id, count(*) AS grants
FROM iam.role_grants
WHERE capability_id IN ('create_org','set_plugin_enabled','send_message',
                        'list_agent_tools','ingest_graph','recall_memory')
GROUP BY capability_id ORDER BY capability_id;
```

### (d) REMAP custom-role grants — MAP-driven UPDATE
`tools/scripts/adr025-reland-custom-role-grant-remap.sql` (generated from
`adr025-name-map.mjs`; 294 old→new pairs). It touches ONLY `is_system_default = false`
roles, recomputes `public_id`, needs `pgcrypto`, and is wrapped in a transaction so you
inspect before COMMIT.
```bash
psql "$DATABASE_URL" -f tools/scripts/adr025-reland-custom-role-grant-remap.sql
```
Then re-run assessment (a) — the `is_system_default = false` dotted bucket must be 0.

### (e) MERGE + DEPLOY, then SMOKE
Merge #711, deploy (apply any pending Atlas migrations the manual-apply way if CI is
still billing-blocked). Then:
- Log into app.oxagen.sh with `creds.json`; exercise IAM-gated capabilities (list
  connections, open the plugins page + toggle one, send a chat message, create an API
  key) — all must succeed, none deny.
- Health-check API (`/health`) and MCP (`/mcp`).
- Confirm no `no_handler` / `unknown_capability` / `authz_denied` spikes in logs.

### (f) OPTIONAL cleanup (later, non-urgent, after the deploy is confirmed healthy)
Inert dotted rows on system roles remain (the seed added snake rows beside them; they
never match). Prune for hygiene once the snake deploy is proven stable:
```sql
DELETE FROM iam.role_grants WHERE capability_id LIKE '%.%';
```

---

## ClickHouse — no migration needed for dispatch
`tool_invocations.capability_name` is append-only telemetry; dispatch/IAM never read
it. Historical rows stay dotted; new events emit the snake name. Only analytics
spanning the cutover need care (filter by time, or UNION dotted+snake).
`tools/scripts/fanout-token-metrics.ts` already queries the snake names.

## Rollback
The seed + remap are additive/self-contained. If the snake **deploy** misbehaves, roll
back the deploy only — until step (f) the dotted system-role rows are still present, so
the previous dotted build keeps authorizing. Run (f) only once the snake deploy is
confirmed healthy.

## Proof already captured (branch feat/adr025-reland)
Dispatch probe 5/5 (`verifications/<session>/naming-probe-reland.txt`); `git grep`
dotted `invoke(`/`getCapability(` call-sites = 0, dotted `registerHandler(` keys = 0;
`check-naming` 293 conform; typecheck exit 0 for oxagen/handlers/agent/api/app.
