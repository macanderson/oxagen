-- agent.agents records whether the model proxy may keep the agent's prompt
-- cache warm while it waits on a subagent (spend spec, detector 3; lane F32).
--
-- While a parent run waits on a subagent, its cached prompt can expire, and
-- the next turn pays to write the cache again. The tacho model proxy can
-- resend the parent's last request with max_tokens 0 to keep the cache warm.
-- It does so only when the agent's idle cache finding shows the keep-alive
-- costs less than the cache rewrites it saves.
--
-- The keep-alive is on by default, so every existing agent reads true. An org
-- Owner or Admin turns it off for one agent with set_agent_cache_keep_alive,
-- which writes false here.

ALTER TABLE "agent"."agents"
  ADD COLUMN "cache_keep_alive" boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN "agent"."agents"."cache_keep_alive" IS
  'Whether the model proxy may send a cache keep-alive for this agent while it waits on a subagent. True by default; set_agent_cache_keep_alive sets it.';
