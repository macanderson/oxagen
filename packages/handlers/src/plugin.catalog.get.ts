import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { getOxagenPlugin } from "@oxagen/oxagen/plugins";
import {
  listServers,
  getServerVersion,
  deriveTransportTypes,
  deriveAuthKind,
} from "@oxagen/plugins/registry";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, version = "latest" } = input as { name: string; version?: string };

  // ── First-party Oxagen capability packs ─────────────────────────────────────
  // Capability packs (agent_capability / knowledge_source / integration) live in
  // the in-repo Oxagen plugin registry, NOT in MCP registries. Resolve them here
  // so the marketplace detail panel works for ids like "oxagen/media-image"
  // WITHOUT requiring any enabled MCP registry. Before this, catalog.get always
  // hit the registry path and threw (→ 500) for every first-party pack, which
  // crashed the marketplace detail panel. Hidden packs are treated as not-found.
  const manifest = getOxagenPlugin(name);
  if (manifest && manifest.visibility !== "hidden") {
    logger.info({ name, version: manifest.version }, "plugin.catalog.get: oxagen plugin ok");
    return {
      name: manifest.id,
      title: manifest.name,
      description: manifest.description,
      version: manifest.version,
      repository: null,
      websiteUrl: null,
      // Forward Lucide icon name + hex accent color per the SHARED ICON DATA CONTRACT.
      // UI branches: http(s)/data URI → <Image>; plain string → CapabilityIcon(color).
      icons: manifest.icon ? [{ src: manifest.icon, color: manifest.color }] : [],
      packages: [],
      remotes: [],
      transportTypes: [],
      authKind: "none",
      categories: [manifest.category],
    };
  }

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

  // Not a first-party pack and no registries to search → genuinely not found.
  // Surface as a not-found error (route maps this to 404, not a 500) so the
  // marketplace renders a clean "not found" instead of crashing.
  if (registries.length === 0) {
    throw new Error(`catalog server not found: ${name}@${version}`);
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
