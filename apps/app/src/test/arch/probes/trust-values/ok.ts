export function toCost(out: { costBasis: string | null; tier: string | null }) {
  return {
    basis: out.costBasis,
    tier: out.tier === "free" ? out.tier : null,
    plan: out.tier ?? null,
    label: "estimated",
  };
}
