export function toRate(out: {
  ratePerGauMicros: string;
  amountDueMicros: string;
}) {
  return { rate: out.ratePerGauMicros, due: out.amountDueMicros };
}
