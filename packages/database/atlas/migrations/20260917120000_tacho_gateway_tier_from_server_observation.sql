-- tacho_hosts.gateway_last_seen_at — the server's own record that this host's
-- MCP gateway key was used.
--
-- The enforcement tier on a Tacho session said whether the platform enforced a
-- call or the agent merely reported one. It was derived from an attribute on
-- the submitted batch, which the harness can set: OTLP attributes pass through
-- the normalizer verbatim, the daemon seals whatever it is given, and the seal
-- proves only that the record was not altered after collection. A valid chain
-- over a false input is byte-for-byte a valid chain, so a client-attested tier
-- was signed and trusted by replay grading.
--
-- This column is written where the control plane AUTHORISES a call presenting
-- the host's tacho_gateway_v1 key — a request it served itself. The tier is
-- computed from it, so the value the agent submits no longer decides anything.
--
-- Nullable with no backfill: a host that has never had a gateway call
-- authorised has no observation, and "no evidence" must read as no evidence
-- rather than as a default tier.
ALTER TABLE "tacho"."tacho_hosts"
  ADD COLUMN IF NOT EXISTS "gateway_last_seen_at" timestamptz;

-- tacho_sessions.gateway_observed_at — what a `gateway` tier stands on.
--
-- The tier may legitimately rise after a session opens: a daemon chain is
-- created when the daemon starts, long before the first connected app calls
-- anything through the local MCP gateway. A rise is the dangerous shape, so a
-- risen tier has to be answerable for itself. This column holds the host
-- observation that raised it, and is null on every other tier.
ALTER TABLE "tacho"."tacho_sessions"
  ADD COLUMN IF NOT EXISTS "gateway_observed_at" timestamptz;
