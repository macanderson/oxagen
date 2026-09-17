export function toPlanCard(out: Record<string, number>) {
  const cost = out["costMicros"];
  return { balance: out.creditBalanceCents, cost };
}
