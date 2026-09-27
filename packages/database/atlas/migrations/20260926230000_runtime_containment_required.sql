-- ADR-204: whether an agent must run under the contained launcher (ADR-152)
-- is a property of the runtime it runs on, not of the agent's version config
-- (#4372).
--
-- 1. agent.runtimes.containment_required: false unless an Owner or Admin
--    turns it on with create_runtime or update_runtime.
-- 2. Backfill: a runtime requires containment when the active version of any
--    live agent on it required it. An agent is on a runtime when its own
--    runtime_id names the runtime, or when a host enrollment bound to the
--    runtime belongs to the agent, because the host bundle reads the host's
--    runtime and is not revoked. The version configs keep their containment
--    tables. An agent with no runtime yet carries its version's requirement
--    to the runtime its first host enrollment binds (findOrCreateHostRuntime).
--
-- The backfill runs with the RLS bypass set for this transaction only.
-- Hand-written, then `atlas migrate hash`.
--
-- Rollback:
--   ALTER TABLE agent.runtimes DROP COLUMN containment_required;
--   The version configs still hold the containment each agent had, so the
--   previous code reads the same answer after a rollback.

-- ── 1. agent.runtimes.containment_required ──────────────────────────────────
ALTER TABLE "agent"."runtimes"
  ADD COLUMN "containment_required" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "agent"."runtimes"."containment_required" IS
  'Every agent on this runtime runs only under the contained launcher (ADR-152, ADR-204). The host bundle reads it from the host''s runtime.';

-- ── 2. Backfill from the active versions ────────────────────────────────────
SELECT set_config('app.rls_bypass', 'on', true);

-- A revoked host does not count: `move_agent` revokes an agent's hosts on
-- the runtime it leaves, and that runtime's other agents must not inherit
-- the moved agent's containment. The notice names how many runtimes now
-- require containment and how many live hosts sit on them, because a host
-- whose tacho cannot read containment is suspended and a host without Docker
-- has its actions refused.
DO $$
DECLARE
  switched integer;
  live_hosts integer;
BEGIN
  WITH changed AS (
    UPDATE "agent"."runtimes" AS r
    SET containment_required = true
    WHERE r.containment_required = false
      AND EXISTS (
        SELECT 1
        FROM "agent"."agents" AS a
        JOIN "agent"."agent_versions" AS v ON v.id = a.active_version_id
        WHERE a.deleted_at IS NULL
          AND v.config -> 'containment' ->> 'required' = 'true'
          AND (
            a.runtime_id = r.id
            OR EXISTS (
              SELECT 1
              FROM "tacho"."hosts" AS h
              WHERE h.runtime_id = r.id
                AND h.agent_id = a.id
                AND h.status <> 'revoked'
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
  RAISE NOTICE 'runtime_containment_required: % runtime(s) now require containment, with % live host(s) on them', switched, live_hosts;
END $$;

SELECT set_config('app.rls_bypass', 'off', true);
