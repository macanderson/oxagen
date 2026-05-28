-- ClickHouse — median LLM latency by provider + model over 7 days.
-- Per OXA-1351 acceptance criteria.

SELECT
  provider,
  model,
  surface,
  count()                                                  AS calls,
  quantileExactInclusive(0.50)(toFloat64(duration_ms))     AS p50_ms,
  quantileExactInclusive(0.95)(toFloat64(duration_ms))     AS p95_ms,
  quantileExactInclusive(0.99)(toFloat64(duration_ms))     AS p99_ms,
  sum(input_tokens)                                        AS input_tokens,
  sum(output_tokens)                                       AS output_tokens
FROM token_usage
WHERE created_at >= now() - INTERVAL 7 DAY
GROUP BY provider, model, surface
ORDER BY calls DESC;
