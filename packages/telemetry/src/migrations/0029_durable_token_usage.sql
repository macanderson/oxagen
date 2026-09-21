-- A stable call ID lets FINAL collapse retried deliveries after an uncertain
-- acknowledgment. Legacy rows remain in their original table.
CREATE TABLE IF NOT EXISTS durable_token_usage
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, created_at, execution_step_id, usage_event_id)
TTL toDateTime(created_at) + INTERVAL 365 DAY
AS SELECT *, generateUUIDv4() AS usage_event_id FROM token_usage WHERE 0;

CREATE VIEW IF NOT EXISTS metered_token_usage AS
SELECT * FROM token_usage
UNION ALL
SELECT * EXCEPT usage_event_id FROM durable_token_usage FINAL;
