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
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { useToast } from "@/components/ui/toast";
import { useTenant } from "@/lib/tenant/tenant-context";
import { docsUrl } from "@/lib/docs-url";
import { cn } from "@/lib/utils";
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
    // Per-item failures come back in `failures` — bulk install is not
    // all-or-nothing (see @/lib/agent-tools/install-actions installBulkPlugin).
  }) => Promise<{ ok: boolean; error?: string; failures?: string[] }>;
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
  const toast = useToast();
  const { workspaceId } = useTenant();
  const [activeTab, setActiveTab] =
    React.useState<PluginTypeValue>("agent_skill");
  const [search, setSearch] = React.useState("");
  const [servers, setServers] = React.useState<CatalogServer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [installingId, setInstallingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Bulk-install multi-select. `selected` holds `srv.id` (the compound catalog
  // id); the handler resolves each back to `srv.name` before dispatching, same
  // as the legacy MarketplaceModal. Per-item failures surface in `bulkFailures`.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = React.useState(false);
  const [bulkFailures, setBulkFailures] = React.useState<string[]>([]);

  const fetchServers = React.useCallback(
    async (offset = 0, replace = true) => {
      setLoading(true);
      setError(null);
      // Bound the request: a stalled catalog response must never strand the
      // panel on its loading skeleton with no terminal state. On timeout we
      // abort and surface a retryable ErrorState instead of pulsing forever.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const params = new URLSearchParams({
          pluginType: activeTab,
          limit: "30",
          offset: String(offset),
          workspaceId,
        });
        if (search.trim()) params.set("search", search.trim());
        const res = await fetch(
          `/api/v1/plugin/catalog/browse?${params.toString()}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          servers: CatalogServer[];
          nextOffset: number | null;
          total: number;
        };
        setServers((prev) =>
          replace ? data.servers : [...prev, ...data.servers],
        );
        setNextOffset(data.nextOffset);
        setTotal(data.total);
      } catch (e) {
        setError(
          controller.signal.aborted
            ? "The catalog took too long to respond. Check your connection and try again."
            : e instanceof Error
              ? e.message
              : "Failed to load catalog",
        );
      } finally {
        clearTimeout(timeout);
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

  const searchTimeoutRef =
    React.useRef<ReturnType<typeof setTimeout>>(undefined);
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
          description:
            result.error ?? `Could not install ${srv.title ?? srv.name}.`,
          type: "error",
        });
        return;
      }
      setServers((prev) =>
        prev.map((s) => (s.id === srv.id ? { ...s, installed: true } : s)),
      );
      toast.add({
        title: `${srv.title ?? srv.name} installed`,
        description: "You can use it now.",
        type: "success",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Install failed";
      setError(message);
      toast.add({
        title: "Install failed",
        description: message,
        type: "error",
      });
    } finally {
      setInstallingId(null);
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleBulkInstall = async () => {
    if (selected.size === 0) return;
    setBulkPending(true);
    setError(null);
    setBulkFailures([]);
    // Resolve each selected compound id back to the server's install name/slug;
    // pluginType is the active tab (this catalog is single-type per tab).
    const items = Array.from(selected).map((id) => {
      const srv = servers.find((s) => s.id === id);
      return { catalogServerId: srv?.name ?? id, pluginType: activeTab };
    });
    try {
      const result = await installBulkAction({ orgSlug, workspaceSlug, items });
      if (!result.ok) {
        setBulkFailures(result.failures ?? []);
        setError(result.error ?? "Bulk install failed");
        toast.add({
          title: "Some installs failed",
          description:
            result.error ?? "One or more plugins could not be installed.",
          type: "error",
        });
        return;
      }
      // Mark every selected row installed and clear the selection.
      setServers((prev) =>
        prev.map((s) => (selected.has(s.id) ? { ...s, installed: true } : s)),
      );
      const count = selected.size;
      setSelected(new Set());
      toast.add({
        title: count === 1 ? "Plugin installed" : `${count} plugins installed`,
        description: "You can equip them now.",
        type: "success",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Bulk install failed";
      setError(message);
      toast.add({
        title: "Install failed",
        description: message,
        type: "error",
      });
    } finally {
      setBulkPending(false);
    }
  };

  const activeLabel =
    PLUGIN_TABS.find((t) => t.value === activeTab)?.label ?? "tools";
  const noun =
    activeTab === "mcp_server" || activeTab === "integration"
      ? "servers"
      : "plugins";

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
                // Re-clicking the active tab is a no-op: clearing the list
                // without a tab change would blank results with no refetch
                // (the fetch effect keys off activeTab).
                if (value === activeTab) return;
                setActiveTab(value);
                setServers([]);
                setSelected(new Set());
                setBulkFailures([]);
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

      {/* Inline banner is for install/bulk errors that happen while results are
          on screen; a load failure with no results renders the ErrorState
          block below instead (never both). */}
      {error && servers.length > 0 && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Selection toolbar — appears once one or more cards are checked. */}
      {selected.size > 0 && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3"
          data-testid="marketplace-browse-selection-toolbar"
        >
          <div className="flex items-center gap-3">
            <p
              className="text-sm font-medium"
              data-testid="marketplace-browse-selection-count"
            >
              {selected.size} selected
            </p>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelected(new Set());
                  setBulkFailures([]);
                }}
                disabled={bulkPending}
                data-testid="marketplace-browse-clear-selection"
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={handleBulkInstall}
                disabled={bulkPending}
                data-testid="marketplace-browse-bulk-install-btn"
              >
                {bulkPending
                  ? "Installing…"
                  : `Install selected (${selected.size})`}
              </Button>
            </div>
          </div>
          {bulkFailures.length > 0 && (
            <ul
              className="list-disc space-y-0.5 pl-5 text-xs text-destructive"
              data-testid="marketplace-browse-bulk-failures"
            >
              {bulkFailures.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading && servers.length === 0 ? (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="marketplace-browse-skeleton"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-40 rounded-xl border border-border/40 bg-muted/30 animate-pulse"
            />
          ))}
        </div>
      ) : error && servers.length === 0 ? (
        // Load failed (or timed out) with nothing to show: a retryable error,
        // never a bare skeleton or a misleading "none found".
        <ErrorState
          title={`Couldn't load ${activeLabel.toLowerCase()}`}
          description={error}
          retry={() => void fetchServers(0, true)}
        />
      ) : servers.length === 0 ? (
        // Genuinely empty: a proper empty state with a pointing CTA — either
        // clear the search that hid everything, or read up on this tool type.
        <EmptyState
          variant="dashed"
          icon={<ShoppingBag />}
          title={search.trim() ? "No matches" : `No ${noun} available`}
          description={
            search.trim()
              ? `Nothing in ${activeLabel} matches “${search.trim()}”.`
              : `There are no ${activeLabel.toLowerCase()} to install here yet.`
          }
          action={
            search.trim() ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSearchChange("")}
                data-testid="marketplace-browse-clear-search"
              >
                Clear search
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                render={
                  <a
                    href={`${docsUrl()}/marketplace`}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
                data-testid="marketplace-browse-empty-docs"
              >
                Learn about {activeLabel.toLowerCase()}
              </Button>
            )
          }
          data-testid="marketplace-browse-empty"
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {total} {noun}
          </p>

          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="marketplace-browse-grid"
          >
            {servers.map((srv) => (
              <Card
                key={srv.id}
                className={cn(
                  "relative",
                  selected.has(srv.id) && "border-primary/60 bg-primary/5",
                )}
                data-testid={`marketplace-browse-card-${srv.id}`}
              >
                {/* Multi-select checkbox — disabled once installed. */}
                {!srv.installed && (
                  <span className="absolute right-3 top-3 z-10">
                    <Checkbox
                      checked={selected.has(srv.id)}
                      onCheckedChange={() => toggleSelect(srv.id)}
                      aria-label={
                        selected.has(srv.id)
                          ? `Deselect ${srv.title ?? srv.name}`
                          : `Select ${srv.title ?? srv.name}`
                      }
                      data-testid={`marketplace-browse-select-${srv.id}`}
                    />
                  </span>
                )}
                <CardHeader className="flex flex-row items-start gap-3 pr-8">
                  <ServerIcon
                    icons={srv.icons}
                    pluginType={srv.pluginType}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <CardTitle
                      className="truncate text-sm"
                      data-testid={`marketplace-browse-title-${srv.id}`}
                    >
                      {srv.title ?? srv.name}
                    </CardTitle>
                    <CardDescription className="line-clamp-2">
                      {srv.description}
                    </CardDescription>
                  </div>
                </CardHeader>
                <div className="flex flex-wrap gap-1.5 px-6 pb-2">
                  {srv.installed && (
                    <Badge
                      variant="success"
                      size="sm"
                      data-testid={`marketplace-browse-installed-badge-${srv.id}`}
                    >
                      Installed
                    </Badge>
                  )}
                  <Badge
                    variant={srv.tier === "premium" ? "warning" : "muted"}
                    size="sm"
                  >
                    {srv.tier === "premium" ? "Premium" : "Free"}
                  </Badge>
                  {srv.pluginType === "mcp_server" ||
                  srv.pluginType === "integration" ? (
                    <>
                      {srv.transportTypes.slice(0, 2).map((t) => (
                        <Badge key={t} variant="outline" size="sm">
                          {t}
                        </Badge>
                      ))}
                      <Badge
                        variant={
                          srv.authKind === "oauth"
                            ? "info"
                            : srv.authKind === "secret"
                              ? "warning"
                              : "muted"
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
