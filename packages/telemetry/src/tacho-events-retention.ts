/**
 * How long ClickHouse keeps a `tacho_events` row after the control plane
 * received it, in calendar months. Migration 0032 sets the table's TTL to
 * `toDateTime(received_at) + INTERVAL 13 MONTH` (#3944, S-11), and a wrapped
 * session has no archive segment, so a frame past it is gone.
 *
 * A reader that bounds a run's frames from seq 0 reads a missing frame below
 * this window as expired, not as a chain break (#4316). The value is pinned to
 * the migration's text in `tacho-events-retention.test.ts`. Change both
 * together.
 */
export const TACHO_EVENTS_RETENTION_MONTHS = 13;
