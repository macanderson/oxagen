// published-manifest.ts: the servers a workspace has published, by name.
//
// The credential source needs a server's label for the connect message and
// its environments' URLs for OAuth discovery. The connect route needs the
// server's auth and the credential each environment names. All of it is in
// the tool manifest of the workspace's published steering version, so this
// reads that and nothing else. A server that is not published cannot be
// connected.
import { schema, withTenantDb } from "@oxagen/database";
import { type ManifestServer, toolManifestSchema } from "@oxagen/mcp-studio";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { CredentialScope } from "./store";

const bundleToolsSchema = z.object({ tools: z.unknown() }).passthrough();

/**
 * Read the servers of every steering repository the workspace has published.
 * Server names are unique in a workspace, so the map is keyed by name. A
 * version whose tools did not compile adds nothing.
 */
export async function publishedServers(
  scope: CredentialScope,
): Promise<Map<string, ManifestServer>> {
  const versions = schema.steeringVersions;
  const publications = schema.steeringPublications;
  const rows = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({ bundle: versions.bundle })
        .from(publications)
        .innerJoin(
          versions,
          and(
            eq(versions.orgId, publications.orgId),
            eq(versions.workspaceId, publications.workspaceId),
            eq(versions.repository, publications.repository),
            eq(versions.version, publications.publishedVersion),
          ),
        )
        .where(
          and(
            eq(publications.orgId, scope.orgId),
            eq(publications.workspaceId, scope.workspaceId),
          ),
        ),
    ),
  );
  const servers = new Map<string, ManifestServer>();
  for (const row of rows) {
    const bundle = bundleToolsSchema.safeParse(row.bundle);
    if (!bundle.success || bundle.data.tools === null) continue;
    const manifest = toolManifestSchema.safeParse(bundle.data.tools);
    if (!manifest.success) continue;
    for (const server of manifest.data.servers) servers.set(server.name, server);
  }
  return servers;
}
