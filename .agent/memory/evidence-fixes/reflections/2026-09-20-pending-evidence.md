# Pending evidence

An unproven retention mandate withheld body bytes but acknowledged their events, preventing later atomic body delivery. Holding only that event would also break the dense chain the ingest handler verifies. Hold the session suffix and let other session chains drain. The persisted event timestamp gives the hold a 24-hour ceiling that cannot reset on restart.

SessionEnd needs a final observation before its seal, while Git must stay outside the global hook queue. Persist the pending end and registry before acknowledging, then close from the Git lane. Tests cover failed Git, immediate Stop and SessionEnd, restart, held queues larger than a batch, recovery, and expiry. No local tests ran under the shared-machine policy.
