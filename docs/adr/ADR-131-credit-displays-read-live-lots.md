# ADR-131: Credit displays read live lots

Status: Accepted for implementation

## Problem

The cached credit balance changes when credits are granted or spent. It does not fall when a lot expires. `get_subscription` read that mirror and could show credits that admission would refuse.

## Decision

Read the displayed balance through `effectiveBalance(orgId)`. The helper sums remaining credit from unexpired lots inside tenant scope. A failed authoritative read fails the subscription request. It does not fall back to the mirror.

This follows the default recommendation in #2976, absorbed #2214. Keep the historical mirror and its existing writes for compatibility. This change introduces no column deletion, scheduled reconciliation, or mirror-first debit.

## Validation

Handler regressions distinguish a cached balance of 999 from a live balance of 50 and refuse stale fallback after a read failure. Existing billing tests cover the live-lot aggregate and expiration predicate. The handler regressions await CI.
