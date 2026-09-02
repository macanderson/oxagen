import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { getOxagenPlugin } from "@oxagen/oxagen/plugins";
import {
  listServers,
  getServerVersion,
  deriveTransportTypes,
  deriveAuthKind,
  fetchAndRenderReadme,
  isReadmeFresh,
} from "@oxagen/plugins/registry";
import type { Repository } from "@oxagen/plugins/registry";
import { logger } from "./logger";

/**
 * Resolve README HTML for a server's repository, fail-safe: any error is
 * logged and swallowed so a broken/unreachable README never fails the whole
 * catalog.get call. This live-lookup path (unlike the periodic
 * mcp.catalog_servers sync job) has no persistent cache, so there is no
 * fetchedAt to check — isReadmeFresh(null, …) always reports "stale," i.e.
 * always fetch. The check is kept so the caching contract is honored if a
 * persistent cache is added to this path later.
 */
async function resolveReadmeHtml(
  repository: Repository | null | undefined,
  name: string,
  version: string,
): Promise<string | null> {
  if (!repository) return null;
  if (isReadmeFresh(null, Date.now())) return null;
  try {
    return await fetchAndRenderReadme(repository);
  } catch (err) {
    logger.warn(
      { err, name, version },
      "plugin.catalog.get: readme fetch failed, returning without readme",
    );
    return null;
  }
}

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, version = "latest" } = input as {
    name: string;
    version?: string;
  };

  // ── First-party Oxagen capability packs ─────────────────────────────────────
  // Capability packs (agent_capability / knowledge_source / integration) live in
  // the in-repo Oxagen plugin registry, NOT in MCP registries. Resolve them here
  // so the marketplace detail panel works for ids like "oxagen/media-image"
  // WITHOUT requiring any enabled MCP registry — the registry path below cannot
  // resolve a first-party pack and would throw for every one of them. Hidden
  // packs are treated as not-found.
  const manifest = getOxagenPlugin(name);
  if (manifest && manifest.visibility !== "hidden") {
    logger.info(
      { name, version: manifest.version },
      "plugin.catalog.get: oxagen plugin ok",
    );
    return {
      name: manifest.id,
      title: manifest.name,
      description: manifest.description,
      version: manifest.version,
      repository: null,
      websiteUrl: null,
      // Forward Lucide icon name + hex accent color per the SHARED ICON DATA CONTRACT.
      // UI branches: http(s)/data URI → <Image>; plain string → CapabilityIcon(color).
      icons: manifest.icon
        ? [{ src: manifest.icon, color: manifest.color }]
        : [],
      packages: [],
      remotes: [],
      transportTypes: [],
      authKind: "none",
      categories: [manifest.category],
      // First-party packs have no repository to source a README from.
      readmeHtml: null,
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
  // NOTE: a bare Error carries no status, so apps/api's errorMiddleware falls
  // through to its catch-all and returns 500 "Unexpected server error" (and
  // fires captureError). Only HTTPException or a CapabilityError with
  // unknown_capability/no_handler reach 404 there. Making the marketplace show
  // a clean "not found" needs a typed error, not just this message.
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
        const result = await listServers(reg.baseUrl, {
          search: name,
          limit: 10,
        });
        const match = result.servers.find((s) => s.server.name === name);
        if (!match) continue;

        const sd = match.server;
        const meta = match._meta;
        logger.info(
          { name, version: sd.version, registryId: reg.id },
          "plugin.catalog.get: ok",
        );
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
            ? ((meta as Record<string, unknown>).categories as string[])
            : [],
          readmeHtml: await resolveReadmeHtml(sd.repository, name, sd.version),
        };
      } else {
        const s = await getServerVersion(reg.baseUrl, name, version);
        const sd = s.server;
        logger.info(
          { name, version, registryId: reg.id },
          "plugin.catalog.get: ok",
        );
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
          readmeHtml: await resolveReadmeHtml(sd.repository, name, sd.version),
        };
      }
    } catch (err) {
      logger.warn(
        { err, registryId: reg.id, name, version },
        "plugin.catalog.get: registry fetch failed, trying next",
      );
    }
  }

  throw new Error(`catalog server not found: ${name}@${version}`);
};
