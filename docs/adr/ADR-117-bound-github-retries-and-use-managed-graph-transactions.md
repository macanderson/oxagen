# ADR-117: Bound GitHub retries and use managed graph transactions

Status: proposed

## Context

A stalled GitHub request can hold an ingestion or governance operation open indefinitely. Repeating a rate-limited request before GitHub permits it can prolong the restriction. Neo4j auto-commit queries do not receive the driver's managed transaction retries.

## Decision

The GitHub client applies a 30-second timeout to each request attempt, including its response body. Callers may supply a shorter timeout and an abort signal.

A 403 retries only when headers or the response identify a rate limit. A 429 is treated as a rate limit. Retry-After takes precedence, followed by the primary quota reset time when remaining quota is zero. Without either, secondary-limit waits start at 60 seconds and double. Each call makes at most three attempts. A required wait above 120 seconds produces GitHubRateLimitedError with retryAfterMs so the caller can schedule later. The client does not shorten the server's wait. Network failures and timeouts are not retried because a mutation may have reached GitHub before the connection failed.

Scoped Neo4j read queries use executeRead managed transactions. Queries with mutating clauses or procedure calls use non-retrying session.run transactions. Existing mutations can generate identifiers or increment counters without caller-stable idempotency keys. Retrying after a lost commit acknowledgement could repeat those effects. Procedure calls also use the non-retrying path because the seam cannot infer an arbitrary procedure's access mode. Existing graph transaction timeouts and tenant-bound parameters remain attached to both paths.

## Consequences

Request callers can distinguish a rate limit from another API failure by the typed error and HTTP status. A long quota reset fails promptly instead of keeping a request open or retrying early. The injected sleep seam supports deterministic tests.

Managed read transactions retain Neo4j's default retry budget. The seam does not combine several scopedSession.run calls into one transaction. Write failures propagate without replay. Managed write retries require a separately reviewed caller-stable idempotency guarantee.

The retry choices follow [GitHub's REST rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). Callback behavior follows [Neo4j's managed transaction guidance](https://neo4j.com/docs/javascript-manual/current/transactions/).

Refs #2974, #2353, #2406.
