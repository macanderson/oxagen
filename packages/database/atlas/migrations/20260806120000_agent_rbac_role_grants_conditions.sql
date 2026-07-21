-- Agent RBAC (docs/specs/agent-rbac/spec.md): add conditions_jsonb to
-- iam.role_grants so a role's grant rows can carry a `resourceScope` ceiling
-- — the same condition payload shape/evaluator already used by
-- iam.grants.conditions_jsonb and iam.policies.conditions_jsonb (see
-- packages/oxagen/src/iam/conditions.ts). This lands the three system
-- workspace roles seeded by tools/scripts/seed-iam-defaults.ts (Agent
-- Observer / Agent Contributor / Agent Operator) — no "Agent Legacy" /
-- unrestricted role exists; pre-launch, no backwards-compatibility path.
--
-- Seed data only — the resolver's role-grant resourceScope-ceiling read path
-- ships separately; this migration and the seed script only make the data
-- available.
--
-- Hand-written + `atlas migrate hash` (see 20260804100000 module comment —
-- `atlas migrate diff` is broken by the unresolved pg_trgm fresh-replay
-- defect).

ALTER TABLE "iam"."role_grants"
  ADD COLUMN IF NOT EXISTS "conditions_jsonb" jsonb;
