export async function tier(): Promise<unknown> {
  const { resolveOrgTier } = await import("@oxagen/billing");
  return resolveOrgTier;
}
