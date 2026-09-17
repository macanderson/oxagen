export async function canManage(): Promise<unknown> {
  const { actorCanManageApiKeys } = await import("@oxagen/handlers");
  return actorCanManageApiKeys;
}
