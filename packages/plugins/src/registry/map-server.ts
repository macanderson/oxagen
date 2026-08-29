/**
 * Pure mapping/derivation from a registry ServerDetail to a mcp.catalog_servers
 * row. auth_kind is a heuristic: 'secret' if ANY env-var/header/remote-variable
 * is flagged isSecret, else 'none'. Real OAuth detection happens later, at
 * connect time via detectOAuthProtected() — the registry record never
 * declares OAuth explicitly.
 */
import type { ServerDetail, ServerMeta } from "./types";

export type AuthKind = "oauth" | "secret" | "none";

export function deriveTransportTypes(sd: ServerDetail): string[] {
  const set = new Set<string>();
  for (const p of sd.packages ?? []) {
    if (p.transport?.type) set.add(p.transport.type);
  }
  for (const r of sd.remotes ?? []) {
    if (r.type) set.add(r.type);
  }
  return [...set];
}

export function deriveAuthKind(sd: ServerDetail): AuthKind {
  const anySecret =
    (sd.packages ?? []).some((p) =>
      (p.environmentVariables ?? []).some((e) => e.isSecret === true),
    ) ||
    (sd.remotes ?? []).some(
      (r) =>
        (r.headers ?? []).some((h) => h.isSecret === true) ||
        Object.values(r.variables ?? {}).some((v) => v.isSecret === true),
    );
  return anySecret ? "secret" : "none";
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Column values for an upsert into mcp.catalog_servers (excludes id/audit). */
export interface CatalogRowInput {
  registryId: string;
  name: string;
  version: string;
  isLatest: boolean;
  title: string | null;
  description: string;
  repository: ServerDetail["repository"] | null;
  websiteUrl: string | null;
  icons: NonNullable<ServerDetail["icons"]>;
  packages: NonNullable<ServerDetail["packages"]>;
  remotes: NonNullable<ServerDetail["remotes"]>;
  transportTypes: string[];
  authKind: AuthKind;
  status: string;
  publishedAt: Date | null;
  upstreamUpdatedAt: Date | null;
  statusChangedAt: Date | null;
  meta: Record<string, unknown>;
}

export function mapServerDetailToCatalogRow(
  sd: ServerDetail,
  meta: ServerMeta | undefined,
  registryId: string,
): CatalogRowInput {
  return {
    registryId,
    name: sd.name,
    version: sd.version,
    isLatest: meta?.isLatest ?? false,
    title: sd.title ?? null,
    description: sd.description,
    repository: sd.repository ?? null,
    websiteUrl: sd.websiteUrl ?? null,
    icons: sd.icons ?? [],
    packages: sd.packages ?? [],
    remotes: sd.remotes ?? [],
    transportTypes: deriveTransportTypes(sd),
    authKind: deriveAuthKind(sd),
    status: meta?.status ?? "active",
    publishedAt: toDate(meta?.publishedAt),
    upstreamUpdatedAt: toDate(meta?.updatedAt),
    statusChangedAt: toDate(meta?.statusChangedAt),
    meta: (meta ?? {}) as Record<string, unknown>,
  };
}
