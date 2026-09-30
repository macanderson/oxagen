-- mcp.server_discoveries records a discovery that waits for a machine (#4772).
--
-- A local server, or a registry server whose server.toml names
-- source.machines, lists its tools only on an enrolled machine. Discovery
-- runs in the API's durable functions, and the broker that holds the
-- machines' connections runs in the MCP service. The API now records such a
-- discovery as waiting_for_machine, with the machine groups that may run it,
-- and runs no tools/list itself. The MCP process a machine in one of those
-- groups polls claims the row and runs the discovery through its broker.
--
-- The status check gains waiting_for_machine. machine_groups holds
-- server.toml's source.machines for a waiting row. The partial index serves
-- the claim, which reads a workspace's waiting rows oldest first.
--
-- run_id names the run that owns the row. A run sets it when it begins and
-- writes its finish only while the row still carries it, so a run a later
-- one superseded cannot overwrite that run's result.
--
-- Every row the previous status check admitted is still admitted.

ALTER TABLE "mcp"."server_discoveries"
  ADD COLUMN "machine_groups" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "run_id" uuid;

ALTER TABLE "mcp"."server_discoveries"
  DROP CONSTRAINT "server_discoveries_status_check",
  ADD CONSTRAINT "server_discoveries_status_check" CHECK (status IN ('queued', 'running', 'waiting_for_machine', 'succeeded', 'failed'));

CREATE INDEX "server_discoveries_waiting_idx" ON "mcp"."server_discoveries" ("org_id", "workspace_id", "requested_at") WHERE (status = 'waiting_for_machine');
