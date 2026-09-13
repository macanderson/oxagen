// The stream cursor: a Postgres bigint `run_seq` carried as decimal text. Shared
// by the SSE route (server) and the live hooks (client), so it imports nothing.

const DECIMAL_SEQ = /^(0|[1-9]\d{0,19})$/;

/** A decimal, non-negative bigint as text. */
export function isStreamSeq(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_SEQ.test(value);
}

/** Compare two decimal seqs exactly (they can exceed 2^53, so never as numbers). */
export function compareSeq(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
