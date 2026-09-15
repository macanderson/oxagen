export function toBucket(out: { usedGau: number | null }) {
  return {
    usedGau: out.usedGau,
    pendingApprovals: 0,
    remainingGau: out.usedGau === null ? 0 : out.usedGau,
  };
}
