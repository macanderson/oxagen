import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { installOne, type InstallOneInput } from "./plugin.org.install";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { items } = input as { items: InstallOneInput[] };

  const installed = await Promise.all(
    items.map(async (item) => {
      try {
        const orgListingId = await installOne(ctx, item);
        return {
          catalogServerId: item.catalogServerId ?? null,
          orgListingId,
          error: null,
        };
      } catch (err) {
        return {
          catalogServerId: item.catalogServerId ?? null,
          orgListingId: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return { installed };
};
