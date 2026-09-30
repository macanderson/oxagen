-- ADR-204 §4, amendment of 2026-09-30 (#4474): turn containment on for each
-- runtime that a placement written during the #4437 deploy left without it.
--
-- 20260926230000 backfilled agent.runtimes.containment_required in production
-- at 08:09 UTC on 2026-09-27, in the migration-gate job of CI run 36299501166
-- (commit 7eed65652). The deploy-node legs of that run replaced the old code
-- after it: app at 08:18, api at 08:20, and mcp, the last, at 08:33. Until
-- then the old move_agent (api, mcp) and the old enroll_host and
-- create_tacho_enrollment (api) still served. The old host bundle read
-- containment from the agent's version, so none of them wrote it to a
-- runtime. Two kinds of write in that window left a requirement off:
--
-- 1. move_agent put an agent whose active version requires containment on a
--    runtime the backfill had already passed.
-- 2. A host enrollment for an agent on no runtime bound or created the
--    runtime named after the host. The new code carries the requirement only
--    on the agent's first enrollment on a runtime, and this enrollment
--    already counts as that first one.
--
-- The block below applies the backfill's test again, and counts an agent only
-- when the write that put it on the runtime falls in the window. A runtime
-- switches when all of these hold:
--
-- - It does not require containment now.
-- - No Owner or Admin has set its containment with update_runtime. That
--   handler writes a security event in the same transaction as each change
--   (capability update_runtime, detail.feature runtime_containment, keyed by
--   the runtime's public id). It is also the only write that turns
--   containment off, so an owner who turned it off keeps that answer.
--   agent.runtimes.updated_at is not the test, because a rename moves it too.
-- - A live agent whose active version requires containment is on it, by the
--   backfill's own test: the agent's runtime_id names it, or a host of the
--   agent bound to it is not revoked.
-- - The placement is in the window. Either the agent's latest registered or
--   runtime_changed version names the runtime and was written in the window,
--   or the agent's first host on the runtime was enrolled in the window.
--
-- The window runs from 08:08:00 to 08:34:00 UTC on 2026-09-27. The
-- migration-gate's Postgres step started at 08:08:40 and the mcp leg finished
-- at 08:33:11, so each end sits at least 40 seconds outside the recorded
-- steps. A placement before the window was either seen by the backfill or is
-- the pre-migration revoked-host gap that ADR-204 §4 records, which this file
-- leaves as recorded. A placement after it was written by the new code: a
-- move there takes the new runtime's containment (ADR-204, Consequences), and
-- a first enrollment carries the requirement itself. Running the whole
-- backfill again would undo those moves, so this file does not.
--
-- The test for a requiring version is the backfill's:
-- config -> 'containment' ->> 'required' = 'true'.
--
-- The block only turns containment on, and a second run finds nothing left
-- to switch. The notice has the shape of 20260926230000's.
--
-- The block runs with the RLS bypass set for this transaction only.
-- Hand-written, then `atlas migrate hash`.
--
-- Rollback: none needed. The migration only turns containment on, and an
-- Owner or Admin turns it off per runtime with update_runtime.

SELECT set_config('app.rls_bypass', 'on', true);

DO $$
DECLARE
  window_opened constant timestamptz := timestamptz '2026-09-27 08:08:00+00';
  window_closed constant timestamptz := timestamptz '2026-09-27 08:34:00+00';
  switched integer;
  live_hosts integer;
BEGIN
  WITH changed AS (
    UPDATE "agent"."runtimes" AS r
    SET containment_required = true
    WHERE r.containment_required = false
      -- update_runtime shipped with the new code, so no event of it predates
      -- the window. The bound lets the lookup skip the older partitions.
      AND NOT EXISTS (
        SELECT 1
        FROM "security"."security_events" AS e
        WHERE e.org_id = r.org_id
          AND e.occurred_at >= window_opened
          AND e.capability = 'update_runtime'
          AND e.detail ->> 'feature' = 'runtime_containment'
          AND e.detail ->> 'runtimeId' = r.public_id::text
      )
      AND EXISTS (
        SELECT 1
        FROM "agent"."agents" AS a
        JOIN "agent"."agent_versions" AS v ON v.id = a.active_version_id
        WHERE a.deleted_at IS NULL
          AND a.status <> 'archived'
          AND v.config -> 'containment' ->> 'required' = 'true'
          AND (
            -- Moved onto the runtime in the window, and not moved since.
            (
              a.runtime_id = r.id
              AND EXISTS (
                SELECT 1
                FROM "agent"."agent_versions" AS placed
                WHERE placed.agent_id = a.id
                  AND placed.change_kind IN ('registered', 'runtime_changed')
                  AND placed.runtime_id = r.id
                  AND placed.created_at >= window_opened
                  AND placed.created_at < window_closed
                  AND NOT EXISTS (
                    SELECT 1
                    FROM "agent"."agent_versions" AS later
                    WHERE later.agent_id = a.id
                      AND later.change_kind IN ('registered', 'runtime_changed')
                      AND later.version > placed.version
                  )
              )
            )
            -- First enrolled on the runtime in the window, and still enrolled
            -- there.
            OR (
              EXISTS (
                SELECT 1
                FROM "tacho"."hosts" AS h
                WHERE h.runtime_id = r.id
                  AND h.agent_id = a.id
                  AND h.status <> 'revoked'
              )
              AND EXISTS (
                SELECT 1
                FROM "tacho"."hosts" AS first_host
                WHERE first_host.runtime_id = r.id
                  AND first_host.agent_id = a.id
                  AND first_host.created_at >= window_opened
                  AND first_host.created_at < window_closed
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "tacho"."hosts" AS earlier
                WHERE earlier.runtime_id = r.id
                  AND earlier.agent_id = a.id
                  AND earlier.created_at < window_opened
              )
            )
          )
      )
    RETURNING r.id
  )
  SELECT
    (SELECT count(*) FROM changed),
    (SELECT count(*)
       FROM "tacho"."hosts" AS h
      WHERE h.status <> 'revoked'
        AND h.runtime_id IN (SELECT id FROM changed))
  INTO switched, live_hosts;
  RAISE NOTICE 'runtime_containment_reconcile: % runtime(s) now require containment, with % live host(s) on them', switched, live_hosts;
END $$;

SELECT set_config('app.rls_bypass', 'off', true);
