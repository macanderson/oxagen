/**
 * Periodic incremental catalog sync across all enabled registries. Each
 * registry is synced in its own step so one failure doesn't abort the rest.
 */
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { syncRegistry, createSystemSyncPersistence } from "@oxagen/plugins";
import { createFunction } from "../create-function";

export const [pluginCatalogSyncCron] = createFunction(
  { id: "plugin.catalog-sync-cron", retries: 2 },
  { cron: "0 */6 * * *" },
  async ({ step }) => {
    const registries = await step.run("load-enabled-registries", () =>
      withSystemDb((tx) =>
        tx
          .select({ id: schema.mcpRegistries.id })
          .from(schema.mcpRegistries)
          .where(eq(schema.mcpRegistries.enabled, true)),
      ),
    );

    const persistence = createSystemSyncPersistence();
    let total = 0;
    for (const r of registries) {
      const result = await step.run(`sync-${r.id}`, () =>
        syncRegistry(r.id, { mode: "incremental" }, persistence),
      );
      total += result.upserted;
    }
    return { registries: registries.length, upserted: total };
  },
);
