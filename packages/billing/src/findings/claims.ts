/**
 * claims.ts — the unproductive spend headline from the frames findings claim
 * (ADR-206). The headline adds detectors 1, 7, and 8. A frame counts once,
 * under the first of them that claims it, so two findings that claim one
 * frame add its cost once. Each operator's total is the frames counted under
 * that operator's runs, and the operator totals sum to the headline.
 */
/** One stored claim, as the reader selects it. */
export interface ClaimRow {
  /** 1, 7, or 8; the lowest claim on a frame counts it. */
  detector: number;
  runId: string;
  frameKey: string;
  operatorKey: string | null;
  costMicros: bigint;
}

export interface UnproductiveSpend {
  totalMicros: bigint;
  /** Largest first; `operatorKey` is null for runs that name no operator. */
  operators: { operatorKey: string | null; micros: bigint }[];
}

/** Count each claimed frame once, under the lowest detector that claims it. */
export function countClaims(rows: readonly ClaimRow[]): UnproductiveSpend {
  const first = new Map<string, ClaimRow>();
  for (const row of rows) {
    const key = `${row.runId}\u0000${row.frameKey}`;
    const held = first.get(key);
    if (held === undefined || row.detector < held.detector)
      first.set(key, row);
  }
  let totalMicros = 0n;
  const byOperator = new Map<string | null, bigint>();
  for (const row of first.values()) {
    totalMicros += row.costMicros;
    byOperator.set(
      row.operatorKey,
      (byOperator.get(row.operatorKey) ?? 0n) + row.costMicros,
    );
  }
  const operators = [...byOperator]
    .map(([operatorKey, micros]) => ({ operatorKey, micros }))
    .sort((a, b) =>
      a.micros !== b.micros
        ? a.micros > b.micros
          ? -1
          : 1
        : (a.operatorKey ?? "") < (b.operatorKey ?? "")
          ? -1
          : 1,
    );
  return { totalMicros, operators };
}
