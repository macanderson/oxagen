-- Two-axis memory model: add compliance_threshold + default_decay_floor to
-- workspace.workspace_memory_policy.
--
-- docs/specs/two-axis-memory/DESIGN.md introduces two new policy knobs read
-- by agent.memory.policy.read/write and consulted at memory-write time to
-- seed each :AgentMemory node's decay_floor:
--   compliance_threshold — enforcement (1-100) at/above which a RULE
--                          deviation is scored VIOLATION rather than
--                          DISCRETION (see compliance derivation in DESIGN.md)
--   default_decay_floor  — confidence (0-100) new memories never auto-decay
--                          below
--
-- Existing rows backfill to the same defaults the Drizzle schema declares
-- (70 / 5) so `atlas migrate diff` sees zero drift against the ORM.
ALTER TABLE workspace.workspace_memory_policy
  ADD COLUMN IF NOT EXISTS compliance_threshold integer NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS default_decay_floor real NOT NULL DEFAULT 5;
