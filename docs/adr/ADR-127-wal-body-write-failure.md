# ADR-127: Keep sealed events when body storage fails

Status: Accepted
Date: 2026-09-19
Related: #3365, ADR-126

## Context

The host WAL stores sealed events separately from retained content. Its body write ran first and propagated errors before attempting the event write. A denied body path or a partial write could therefore discard an event the recorder had already sealed. A torn body line could also stop shipment of later events.

## Decision

A body append failure is reported with its session, operation and error code. The WAL still attempts the sealed event append. It does not change the sealed envelope or its content digest. The control plane can accept the event with missing content through its existing body-gap handling.

Each body batch starts with a newline. If an earlier append stopped within a record, the next batch starts on a separate line, including after restart. Body reads skip malformed records and report unavailable files. Event reads remain strict because skipping an event would conceal a broken chain. Retention rewrites continue to remove torn body records.

The daemon sends these diagnostics through its existing logger. Diagnostics contain no body bytes or filesystem error messages, and a failing diagnostic sink cannot block the event append.

## Limits

This isolates body failures. An event-file failure still propagates: a full device that also refuses the event write cannot preserve the event through this change. The existing WAL durability and sync policy remain unchanged. Complete bodies written before an event-file failure remain subject to the existing orphan retention sweep.

## Evidence

The isolated regression file exercises an actual directory at the body path, an injected failure after a real partial append, restart and later sequence recovery, prior and later body reads, torn-record removal, diagnostic failure, and strict event parsing. Full suites run in CI.
