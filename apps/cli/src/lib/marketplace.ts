/**
 * marketplace.ts — Client for the plugin marketplace (catalog browse / detail /
 * install), built on the same org-scoped HTTP + auth seam as the rest of the
 * CLI (lib/api.ts). It wraps the three platform capabilities:
 *
 *   browse_plugin_catalog → POST plugin/catalog/browse
 *   get_catalog_plugin    → POST plugin/catalog/get
 *   install_plugin        → POST plugin/org/install
 *
 * The {@link MarketplaceClient} interface is deliberately small and stable so a
 * UI panel (built in parallel) can depend on it and inject a mock. Its
 * `getPlugin` / `installPlugin` arguments are structural subsets of a
 * {@link MarketplaceEntry}, so a caller holding an entry from `browseCatalog`
 * can pass that entry straight through.
 *
 * Every method returns a discriminated {@link MarketplaceResult} instead of
 * throwing: auth-missing is a first-class `{ ok: false, code: "auth" }` result
 * (not an exception), matching the graceful-degradation the UI needs, while
 * lib/api.ts's rich error logging still happens under the hood.
 */
import { apiPostOrThrow, resolveApiContext, ApiError } from "./api.js";

/** The five plugin kinds the marketplace serves. Mirrors the platform enum. */
export type PluginType =
  | "mcp_server"
  | "agent_capability"
  | "agent_skill"
  | "knowledge_source"
  | "integration";

/**
 * A single catalog entry — the minimal, stable shape a list/grid UI renders.
 * Richer per-server data is fetched on demand via {@link MarketplaceClient.getPlugin}.
 */
export interface MarketplaceEntry {
  /** Catalog id (used as the install target — maps to the API's `pluginId`). */
  id: string;
  /** Registry server name (used to fetch detail). */
  name: string;
  /** Human title, or null when the registry has none. */
  title: string | null;
  /** One-line description. */
  description: string;
  /** Which kind of plugin this is. */
  pluginType: PluginType;
  /** Published version string. */
  version: string;
  /** Whether this plugin is already installed in the caller's workspace. */
  installed: boolean;
  /** Free-text category tags. */
  categories: string[];
}

/** Filters for {@link MarketplaceClient.browseCatalog}. All optional. */
export interface BrowseCatalogParams {
  pluginType?: PluginType;
  search?: string;
  /** true ⇒ only installed; false ⇒ only not-installed; omit ⇒ all. */
  installed?: boolean;
  /** Page size (server clamps to 1–100, default 30). */
  limit?: number;
  /** Page offset (default 0). */
  offset?: number;
}

/** One page of catalog results. */
export interface BrowseCatalogPage {
  entries: MarketplaceEntry[];
  /** Offset of the next page, or null when this is the last. */
  nextOffset: number | null;
  /** Total matching entries across all pages. */
  total: number;
  /** Non-fatal registry-fetch warnings (e.g. one registry timed out). */
  warnings?: string[];
}

/** Full detail for one catalog server (the human-facing scalar fields). */
export interface PluginDetail {
  name: string;
  title: string | null;
  description: string;
  version: string;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  websiteUrl: string | null;
  /** Sanitized README HTML, when a repository is resolvable. */
  readmeHtml?: string | null;
}

/** Outcome of an install. */
export interface InstallResult {
  orgListingId: string;
  /** "oauth" means the server needs the OAuth authorize flow completed next. */
  authKind: "oauth" | "secret" | "none";
}

/** Why a marketplace call did not return data. */
export type MarketplaceErrorCode = "auth" | "http" | "network";

/**
 * The result of a marketplace call — success carries `data`, failure carries a
 * message and a machine-readable `code` (plus the HTTP `status` for `http`).
 */
export type MarketplaceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: MarketplaceErrorCode; status?: number };

/**
 * The marketplace surface a UI (or command) depends on. Exactly three methods;
 * inject a mock implementing this interface for tests/preview.
 */
export interface MarketplaceClient {
  /** Search + filter the catalog. */
  browseCatalog(
    params?: BrowseCatalogParams,
  ): Promise<MarketplaceResult<BrowseCatalogPage>>;
  /** Fetch full detail for one server (by name + version). */
  getPlugin(ref: {
    name: string;
    version?: string;
  }): Promise<MarketplaceResult<PluginDetail>>;
  /** Install a plugin into the caller's workspace. */
  installPlugin(ref: {
    pluginType: PluginType;
    id?: string;
  }): Promise<MarketplaceResult<InstallResult>>;
}

const NOT_LOGGED_IN =
  "Not logged in — run `oxagen login`, or set OXAGEN_API_TOKEN / OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.";

// ── Raw API response shapes (not exported — internal to the mapping) ──────────

interface BrowseServerRaw {
  id: string;
  name: string;
  title: string | null;
  description: string;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  version: string;
  pluginType: PluginType;
  installed: boolean;
}
interface BrowseOutputRaw {
  servers: BrowseServerRaw[];
  nextOffset: number | null;
  total: number;
  warnings?: string[];
}
interface GetOutputRaw {
  name: string;
  title: string | null;
  description: string;
  version: string;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  websiteUrl: string | null;
  readmeHtml?: string | null;
}
interface InstallOutputRaw {
  orgListingId: string;
  authKind: "oauth" | "secret" | "none";
}

function mapEntry(s: BrowseServerRaw): MarketplaceEntry {
  return {
    id: s.id,
    name: s.name,
    title: s.title,
    description: s.description,
    pluginType: s.pluginType,
    version: s.version,
    installed: s.installed,
    categories: s.categories,
  };
}

/** Turn any thrown error into a typed failure result (never re-throws). */
function toErrorResult<T>(err: unknown): MarketplaceResult<T> {
  if (err instanceof ApiError) {
    // status 0 ⇒ network/transport failure; >0 ⇒ a real HTTP response.
    if (err.status > 0) {
      return {
        ok: false,
        error: err.message,
        code: "http",
        status: err.status,
      };
    }
    return { ok: false, error: err.message, code: "network" };
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    code: "network",
  };
}

/** Construct the real marketplace client (talks to the platform API). */
export function createMarketplaceClient(): MarketplaceClient {
  return {
    async browseCatalog(params = {}) {
      if (!resolveApiContext()) {
        return { ok: false, error: NOT_LOGGED_IN, code: "auth" };
      }
      try {
        const raw = await apiPostOrThrow<BrowseOutputRaw>(
          "plugin/catalog/browse",
          {
            pluginType: params.pluginType,
            search: params.search,
            installed: params.installed,
            limit: params.limit,
            offset: params.offset,
          },
        );
        return {
          ok: true,
          data: {
            entries: raw.servers.map(mapEntry),
            nextOffset: raw.nextOffset,
            total: raw.total,
            ...(raw.warnings ? { warnings: raw.warnings } : {}),
          },
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    async getPlugin(ref) {
      if (!resolveApiContext()) {
        return { ok: false, error: NOT_LOGGED_IN, code: "auth" };
      }
      try {
        const raw = await apiPostOrThrow<GetOutputRaw>("plugin/catalog/get", {
          name: ref.name,
          version: ref.version ?? "latest",
        });
        return {
          ok: true,
          data: {
            name: raw.name,
            title: raw.title,
            description: raw.description,
            version: raw.version,
            transportTypes: raw.transportTypes,
            authKind: raw.authKind,
            categories: raw.categories,
            websiteUrl: raw.websiteUrl,
            readmeHtml: raw.readmeHtml ?? null,
          },
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    async installPlugin(ref) {
      if (!resolveApiContext()) {
        return { ok: false, error: NOT_LOGGED_IN, code: "auth" };
      }
      try {
        const raw = await apiPostOrThrow<InstallOutputRaw>(
          "plugin/org/install",
          { pluginType: ref.pluginType, pluginId: ref.id },
        );
        return {
          ok: true,
          data: { orgListingId: raw.orgListingId, authKind: raw.authKind },
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },
  };
}
