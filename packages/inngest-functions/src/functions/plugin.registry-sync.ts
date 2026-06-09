/** On-demand sync of a single registry (dispatched by plugin/registry.sync). */
import { syncRegistry, createSystemSyncPersistence } from "@oxagen/plugins";
import { inngest } from "../inngest";

export const pluginRegistrySync = inngest.createFunction(
  { id: "plugin.registry-sync", retries: 2 },
  { event: "plugin/registry.sync" },
  async ({ event, step }) => {
    const { registryId, mode } = event.data as { registryId: string; mode: "full" | "incremental" };
    const persistence = createSystemSyncPersistence();
    return step.run("sync", () => syncRegistry(registryId, { mode }, persistence));
  },
);
