export function toUsageCredits(out: {
  creditBalanceCents: number;
  costMicros: number;
}) {
  return { balanceCredits: out.creditBalanceCents, cost: out.costMicros };
}
