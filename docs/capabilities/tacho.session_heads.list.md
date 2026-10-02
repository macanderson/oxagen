# list_tacho_session_heads

Answer which of a batch of sessions the control plane already holds for the calling host, and how each was recorded. `oxagen agent backfill` asks before it seals anything, and skips every session in the answer (ADR-161).

**Surfaces:** api

**Input:** `host_enrollment_id`, up to 500 `session_uuids` the host derived for the sessions it may backfill, and up to 500 `harness_session_ids` for the same sessions. A harness session id is 1 to 128 letters, digits, dots, underscores, colons or hyphens.

**Output:** `sessions`, one entry for each named root session the control plane holds. Each entry has its `session_uuid`, its `harness_session_id`, its `seq_count` (how many frames the control plane holds), its `record_basis` (`live`, `backfill`, or `mixed`), and the `backfill_normalizer` version a backfill sealed it under, or null.

The host API key must own the named active enrollment, and its creator must still hold the organization Owner or Admin role. The answer names a session in two cases: the calling host holds it under one of the named uuids, or the same agent recorded a session with one of the named harness session ids in the key's workspace. The second case finds a session that an earlier enrollment of the same machine recorded under another uuid, after the machine lost `TACHO_HOME` and enrolled again. Subagent sessions are never named, because a subagent's chain goes with its parent's.

Why the pass asks: ingest answers a second chain that starts at seq 0 for a session it holds as a chain break, and a session recorded under two uuids would show as two runs. The daemon calls `POST /v1/tacho/sessions/heads` in batches of 500 and stops at the first failed or refused call. The pass seals no session from that batch or a later one, and a dry run still reports what it read. The next pass asks about those sessions again. Each host gets 30 calls a minute on this path, separate from the command poll and the bundle refresh. See [ADR-161](../adr/ADR-161-backfilled-runs-are-rebuilt-from-local-transcripts-and-claim-no-governance.md).
