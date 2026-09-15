export function toCost(out: { costMicros: string }) {
  return { micros: out.costMicros, basis: "gateway_observed" };
}
