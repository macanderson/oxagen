"use client";
/**
 * browse-panel.tsx — Marketplace → Agent Tools: the installable agent-tool
 * catalog (skills, MCP servers, capabilities).
 *
 * Card-based grid over the same data source as the legacy marketplace
 * modal (GET /api/v1/plugin/catalog/browse → plugin.catalog.browse), install
 * via the same server actions (installPlugin / installBulkPlugin from
 * @/lib/agent-tools/install-actions) so there is exactly one install path.
 */
import * as React from "react";
import Image from "next/image";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useTenant } from "@/lib/tenant/tenant-context";
import {
  CapabilityIcon,
  PLUGIN_TYPE_DEFAULTS,
  resolveIconEntry,
} from "@/components/plugins/capability-icon";
import { Search, ShoppingBag } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type PluginTypeValue =
  | "mcp_server"
  | "integration"
  | "agent_capability"
  | "agent_skill"
  | "knowledge_source";

interface CatalogServer {
  id: string;
  name: string;
  title: string | null;
  description: string;
  icons: Array<{ src: string; color?: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  version: string;
  pluginType: PluginTypeValue;
  /** Plan gate — rendered as a badge here (the legacy modal never surfaced it). */
  tier?: "free" | "premium";
  installed?: boolean;
}

interface BrowsePanelProps {
  orgSlug: string;
  workspaceSlug: string;
  installAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    catalogServerId: string;
    pluginType: PluginTypeValue;
    pluginId?: string;
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  installBulkAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    items: Array<{
      catalogServerId?: string;
      pluginType: PluginTypeValue;
      pluginId?: string;
    }>;
  }) => Promise<{ ok: boolean; error?: string }>;
}

// The Agent Tools side of the Marketplace: skills, MCP servers, and
// capabilities. Data connectors live on the Integrations side (see
// ../integrations), not here.
const PLUGIN_TABS = [
  { value: "agent_skill" as PluginTypeValue, label: "Skills" },
  { value: "mcp_server" as PluginTypeValue, label: "MCP Servers" },
  { value: "agent_capability" as PluginTypeValue, label: "Capabilities" },
] as const satisfies ReadonlyArray<{ value: PluginTypeValue; label: string }>;

// ── ServerIcon ────────────────────────────────────────────────────────────────

function ServerIcon({
  icons,
  pluginType,
  size = 32,
}: {
  icons: Array<{ src: string; color?: string }>;
  pluginType: PluginTypeValue;
  size?: number;
}) {
  const resolved = resolveIconEntry(icons);
  if (resolved.type === "image") {
    return (
      <Image
        src={resolved.src}
        alt=""
        width={size}
        height={size}
        unoptimized
        className="rounded object-contain flex-shrink-0"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }
  if (resolved.type === "lucide") {
    return (
      <CapabilityIcon
        iconName={resolved.iconName}
        color={resolved.color ?? PLUGIN_TYPE_DEFAULTS[pluginType].color}
        size={size}
      />
    );
  }
  const { iconName, color } = PLUGIN_TYPE_DEFAULTS[pluginType];
  return <CapabilityIcon iconName={iconName} color={color} size={size} />;
}

// ── BrowsePanel ───────────────────────────────────────────────────────────────

export function BrowsePanel({
  orgSlug,
  workspaceSlug,
  installAction,
  installBulkAction,
}: BrowsePanelProps) {
  // installBulkAction is part of the shared action surface (parity with the
  // legacy marketplace modal); this page-based browse experience installs one
  // card at a time, so it is accepted but not wired to a bulk-select UI here.
  void installBulkAction;

  const toast = useToast();
  const { workspaceId } = useTenant();
  const [activeTab, setActiveTab] = React.useState<PluginTypeValue>("agent_skill");
  const [search, setSearch] = React.useState("");
  const [servers, setServers] = React.useState<CatalogServer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [installingId, setInstallingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const fetchServers = React.useCallback(
    async (offset = 0, replace = true) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          pluginType: activeTab,
          limit: "30",
          offset: String(offset),
          workspaceId,
        });
        if (search.trim()) params.set("search", search.trim());
        const res = await fetch(`/api/v1/plugin/catalog/browse?${params.toString()}`);
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          servers: CatalogServer[];
          nextOffset: number | null;
          total: number;
        };
        setServers((prev) => (replace ? data.servers : [...prev, ...data.servers]));
        setNextOffset(data.nextOffset);
        setTotal(data.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load catalog");
      } finally {
        setLoading(false);
      }
    },
    [activeTab, search, workspaceId],
  );

  React.useEffect(() => {
    void fetchServers(0, true);
    // Re-fetch on tab switch; search changes are debounced separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const searchTimeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(searchTimeoutRef.current), []);
  const handleSearchChange = (val: string) => {
    setSearch(val);
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => fetchServers(0, true), 300);
  };

  const handleInstall = async (srv: CatalogServer) => {
    setInstallingId(srv.id);
    setError(null);
    try {
      const result = await installAction({
        orgSlug,
        workspaceSlug,
        catalogServerId: srv.name,
        pluginType: srv.pluginType,
      });
      if (!result.ok) {
        setError(result.error ?? "Install failed");
        toast.add({
          title: "Install failed",
          description: result.error ?? `Could not install ${srv.title ?? srv.name}.`,
          type: "error",
        });
        return;
      }
      setServers((prev) => prev.map((s) => (s.id === srv.id ? { ...s, installed: true } : s)));
      toast.add({
        title: `${srv.title ?? srv.name} installed`,
        description: "You can use it now.",
        type: "success",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Install failed";
      setError(message);
      toast.add({ title: "Install failed", description: message, type: "error" });
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Type tabs */}
      <nav
        className="flex flex-wrap items-center gap-2"
        aria-label="Plugin type"
        data-testid="marketplace-browse-tab-bar"
      >
        {PLUGIN_TABS.map(({ value, label }) => {
          const isActive = activeTab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setActiveTab(value);
                setServers([]);
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border/60 text-muted-foreground hover:border-foreground/40"
              }`}
              data-testid={`marketplace-browse-tab-${value}`}
            >
              {label}
            </button>
          );
        })}

        <div className="relative ml-auto">
          <Search
            className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search…"
            size="sm"
            className="pl-7 w-56"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            data-testid="marketplace-browse-search-input"
          />
        </div>
      </nav>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading && servers.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="marketplace-browse-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 rounded-xl border border-border/40 bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {total} {activeTab === "mcp_server" || activeTab === "integration" ? "servers" : "plugins"}
          </p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="marketplace-browse-grid">
            {servers.length === 0 && (
              <div className="col-span-full rounded-lg border border-border/40 bg-muted/20 px-6 py-10 text-center">
                <ShoppingBag className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">No plugins found.</p>
              </div>
            )}
            {servers.map((srv) => (
              <Card key={srv.id} data-testid={`marketplace-browse-card-${srv.id}`}>
                <CardHeader className="flex flex-row items-start gap-3">
                  <ServerIcon icons={srv.icons} pluginType={srv.pluginType} size={32} />
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-sm" data-testid={`marketplace-browse-title-${srv.id}`}>
                      {srv.title ?? srv.name}
                    </CardTitle>
                    <CardDescription className="line-clamp-2">{srv.description}</CardDescription>
                  </div>
                </CardHeader>
                <div className="flex flex-wrap gap-1.5 px-6 pb-2">
                  {srv.installed && (
                    <Badge variant="success" size="sm" data-testid={`marketplace-browse-installed-badge-${srv.id}`}>
                      Installed
                    </Badge>
                  )}
                  <Badge variant={srv.tier === "premium" ? "warning" : "muted"} size="sm">
                    {srv.tier === "premium" ? "Premium" : "Free"}
                  </Badge>
                  {srv.pluginType === "mcp_server" || srv.pluginType === "integration" ? (
                    <>
                      {srv.transportTypes.slice(0, 2).map((t) => (
                        <Badge key={t} variant="outline" size="sm">
                          {t}
                        </Badge>
                      ))}
                      <Badge
                        variant={
                          srv.authKind === "oauth" ? "info" : srv.authKind === "secret" ? "warning" : "muted"
                        }
                        size="sm"
                      >
                        {srv.authKind}
                      </Badge>
                    </>
                  ) : (
                    srv.categories.slice(0, 2).map((c) => (
                      <Badge key={c} variant="outline" size="sm">
                        {c}
                      </Badge>
                    ))
                  )}
                </div>
                <CardFooter>
                  <Button
                    className="w-full"
                    size="sm"
                    variant={srv.installed ? "outline" : "default"}
                    disabled={srv.installed || installingId === srv.id}
                    onClick={() => handleInstall(srv)}
                    data-testid={`marketplace-browse-install-btn-${srv.id}`}
                  >
                    {srv.installed
                      ? "Installed"
                      : installingId === srv.id
                        ? "Installing…"
                        : "Install"}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>

          {nextOffset !== null && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchServers(nextOffset, false)}
                disabled={loading}
                data-testid="marketplace-browse-load-more"
              >
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
