-- Enforce one principal per (org_id, parent_user_id) for human/delegated
-- principals (2026-07-11 Postgres schema audit §1.3).
--
-- fetch-authz.ts resolves a human/API-key to its IAM principal via
--   WHERE org_id = ? AND parent_user_id = ? LIMIT 1
-- Two concurrent provisioning calls (iam-provision.ts) could both pass their
-- app-side existence check and insert duplicate principals; the LIMIT 1 above
-- then picks one non-deterministically, so an owner can resolve to a principal
-- with no role assignments and be spuriously denied. The onConflictDoNothing()
-- guards already in iam-provision.ts were dead until this index existed.
--
-- Step 1 is defensive: production currently has 0 duplicate groups, but any
-- pre-existing duplicate (in preview/local/other envs) must be collapsed onto
-- the oldest principal — migrating its role assignments — before the unique
-- index can be created. The keeper is the earliest-created row per group.

-- 1a. Drop loser role-assignments that would collide with the keeper's on the
--     (principal_id, role_id, org_id, workspace_id) unique tuple, so the
--     re-point in 1b cannot violate pra_principal_role_org_* uniqueness.
DELETE FROM iam.principal_role_assignments pra
USING (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY org_id, parent_user_id ORDER BY created_at, id
         ) AS keeper_id
  FROM iam.principals
  WHERE parent_user_id IS NOT NULL
) ranked
WHERE ranked.id <> ranked.keeper_id
  AND pra.principal_id = ranked.id
  AND EXISTS (
    SELECT 1
    FROM iam.principal_role_assignments k
    WHERE k.principal_id = ranked.keeper_id
      AND k.role_id = pra.role_id
      AND k.org_id = pra.org_id
      AND k.workspace_id IS NOT DISTINCT FROM pra.workspace_id
  );

-- 1a-bis. Drop loser-vs-loser collisions: when two or more loser principals
--     in the same group hold the same (role_id, org_id, workspace_id) tuple
--     that the keeper lacks, 1a leaves them all in place. Re-pointing every
--     one of them onto the keeper in 1b would create duplicate
--     (keeper, role_id, org_id, workspace_id) rows and violate the
--     pra_principal_role_org_* unique indexes. Keep the earliest such loser
--     row per tuple and delete the rest so 1b's re-point stays collision-free.
DELETE FROM iam.principal_role_assignments pra
USING (
  SELECT loser.id,
         row_number() OVER (
           PARTITION BY ranked.keeper_id,
                        loser.role_id, loser.org_id, loser.workspace_id
           ORDER BY loser.created_at, loser.id
         ) AS rn
  FROM iam.principal_role_assignments loser
  JOIN (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY org_id, parent_user_id ORDER BY created_at, id
           ) AS keeper_id
    FROM iam.principals
    WHERE parent_user_id IS NOT NULL
  ) ranked ON ranked.id = loser.principal_id
  WHERE ranked.id <> ranked.keeper_id
) dups
WHERE dups.id = pra.id
  AND dups.rn > 1;

-- 1b. Re-point the surviving loser role-assignments onto the keeper.
UPDATE iam.principal_role_assignments pra
SET principal_id = ranked.keeper_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY org_id, parent_user_id ORDER BY created_at, id
         ) AS keeper_id
  FROM iam.principals
  WHERE parent_user_id IS NOT NULL
) ranked
WHERE ranked.id <> ranked.keeper_id
  AND pra.principal_id = ranked.id;

-- 1c. Delete the now-redundant duplicate principals.
DELETE FROM iam.principals p
USING (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY org_id, parent_user_id ORDER BY created_at, id
         ) AS keeper_id
  FROM iam.principals
  WHERE parent_user_id IS NOT NULL
) ranked
WHERE ranked.id <> ranked.keeper_id
  AND p.id = ranked.id;

-- 2. The forward guard. Partial so org-level service principals
--    (parent_user_id NULL) remain unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS "principals_org_parent_user_uniq"
  ON "iam"."principals" ("org_id", "parent_user_id")
  WHERE parent_user_id IS NOT NULL;
