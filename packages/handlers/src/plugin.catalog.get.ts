import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import {
  listServers,
  getServerVersion,
  deriveTransportTypes,
  deriveAuthKind,
} from "@oxagen/plugins/registry";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, version = "latest" } = input as { name: string; version?: string };

  // Load enabled registries for this workspace to search across.
  const registries = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.mcpRegistries.id,
        baseUrl: schema.mcpRegistries.baseUrl,
      })
      .from(schema.mcpRegistries)
      .where(
        and(
          eq(schema.mcpRegistries.orgId, ctx.orgId),
          eq(schema.mcpRegistries.workspaceId, ctx.workspaceId),
          eq(schema.mcpRegistries.enabled, true),
        ),
      ),
  );

  if (registries.length === 0) {
    throw new Error("no enabled registries for this workspace");
  }

  // Try each registry until we find the server. For "latest", list and pick the
  // first match by name; for a pinned version, use getServerVersion directly.
  for (const reg of registries) {
    try {
      if (version === "latest") {
        // listServers with exact name search; the registry returns the latest
        // version when no version is specified.
        const result = await listServers(reg.baseUrl, { search: name, limit: 10 });
        const match = result.servers.find((s) => s.server.name === name);
        if (!match) continue;

        const sd = match.server;
        const meta = match._meta;
        logger.info({ name, version: sd.version, registryId: reg.id }, "plugin.catalog.get: ok");
        return {
          name: sd.name,
          title: sd.title ?? null,
          description: sd.description,
          version: sd.version,
          repository: sd.repository ?? null,
          websiteUrl: sd.websiteUrl ?? null,
          icons: sd.icons ?? [],
          packages: sd.packages ?? [],
          remotes: sd.remotes ?? [],
          transportTypes: deriveTransportTypes(sd),
          authKind: deriveAuthKind(sd),
          categories: (meta as Record<string, unknown> | undefined)?.categories
            ? (meta as Record<string, unknown>).categories as string[]
            : [],
        };
      } else {
        const s = await getServerVersion(reg.baseUrl, name, version);
        const sd = s.server;
        logger.info({ name, version, registryId: reg.id }, "plugin.catalog.get: ok");
        return {
          name: sd.name,
          title: sd.title ?? null,
          description: sd.description,
          version: sd.version,
          repository: sd.repository ?? null,
          websiteUrl: sd.websiteUrl ?? null,
          icons: sd.icons ?? [],
          packages: sd.packages ?? [],
          remotes: sd.remotes ?? [],
          transportTypes: deriveTransportTypes(sd),
          authKind: deriveAuthKind(sd),
          categories: [],
        };
      }
    } catch (err) {
      logger.warn({ err, registryId: reg.id, name, version }, "plugin.catalog.get: registry fetch failed, trying next");
    }
  }

  throw new Error(`catalog server not found: ${name}@${version}`);
};
