export function toFleetStats(out: { runs: { live: number | null } }) {
  return { liveRuns: out.runs.live ?? 0 };
}
