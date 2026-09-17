export function toCost(out: { costMicros: string | null }) {
  return { micros: out.costMicros || "0", currency: out.costMicros };
}
