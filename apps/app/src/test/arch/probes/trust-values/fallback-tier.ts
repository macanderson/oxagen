export function toPlan(out: { tier: string | null }) {
  return { tier: out.tier ?? "free" };
}
