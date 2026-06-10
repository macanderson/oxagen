"use client";
import * as React from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PluginDetailPanel } from "./plugin-detail-panel";
import { Search, Package, Plug, FileText, ShoppingBag } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogServer {
  id: string;
  name: string;
  title: string | null;
  description: string;
  icons: Array<{ src: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  version: string;
  pluginType: "mcp_server" | "integration" | "content_tool";
}

interface MarketplaceModalProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deny-listed server names (for greying out) */
  deniedNames?: string[];
  /** Server action: install single plugin */
  installAction: (input: {
    orgSlug: string;
    catalogServerId: string;
    pluginType: "mcp_server" | "integration" | "content_tool";
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  /** Server action: bulk install */
  installBulkAction: (input: {
    orgSlug: string;
    items: Array<{
      catalogServerId: string;
      pluginType: "mcp_server" | "integration" | "content_tool";
    }>;
  }) => Promise<{ ok: boolean; error?: string }>;
}

const PLUGIN_TABS = [
  { value: "mcp_server", label: "MCP Servers", icon: Plug },
  { value: "integration", label: "Integrations", icon: Package },
  { value: "content_tool", label: "Content Tools", icon: FileText },
] as const;

type PluginTypeValue = "mcp_server" | "integration" | "content_tool";

// ── Component ─────────────────────────────────────────────────────────────────

export function MarketplaceModal({
  orgSlug,
  open,
  onOpenChange,
  deniedNames = [],
  installAction,
  installBulkAction,
}: MarketplaceModalProps) {
  const [activeTab, setActiveTab] = React.useState<PluginTypeValue>("mcp_server");
  const [search, setSearch] = React.useState("");
  const [authFilter, setAuthFilter] = React.useState<"" | "oauth" | "secret" | "none">("");
  const [servers, setServers] = React.useState<CatalogServer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [bulkPending, setBulkPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch catalog via the API route (POST /api/v1/plugin/catalog/browse)
  const fetchServers = React.useCallback(
    async (offset = 0, replace = true) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/plugin/catalog/browse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pluginType: activeTab,
            limit: 30,
            offset,
            ...(search.trim() ? { search: search.trim() } : {}),
            ...(authFilter ? { authKind: authFilter } : {}),
          }),
        });
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
    [search, authFilter],
  );

  // Re-fetch when the modal opens or filters change.
  // Defer all state-setting calls out of the synchronous effect body to satisfy
  // react-hooks/set-state-in-effect (same pattern as message-composer.tsx).
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setSelected(new Set());
      setDetailId(null);
      void fetchServers(0, true);
    }, 0);
    return () => clearTimeout(t);
  }, [open, activeTab, authFilter, fetchServers]);

  // Debounce search input
  const searchTimeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = (val: string) => {
    setSearch(val);
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => fetchServers(0, true), 300);
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
    try {
      const result = await installBulkAction({
        orgSlug,
        items: Array.from(selected).map((id) => ({
          catalogServerId: id,
          pluginType: activeTab,
        })),
      });
      if (!result.ok) {
        setError(result.error ?? "Bulk install failed");
        return;
      }
      setSelected(new Set());
      onOpenChange(false);
    } finally {
      setBulkPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-5xl h-[80vh] flex flex-col gap-0 p-0"
        data-testid="marketplace-modal"
      >
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <ShoppingBag className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Plugin Marketplace
          </DialogTitle>
          <DialogDescription>
            Browse and install MCP servers, integrations, and content tools for your organization.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v as PluginTypeValue);
            setSelected(new Set());
          }}
          className="flex flex-col flex-1 min-h-0"
        >
          {/* Tab bar + search row */}
          <div
            className="flex-shrink-0 px-6 pt-3 pb-0 border-b border-border/40"
            data-testid="marketplace-tab-bar"
          >
            <div className="flex items-center justify-between gap-4">
              <TabsList variant="underline" className="gap-6">
                {PLUGIN_TABS.map(({ value, label, icon: Icon }) => (
                  <TabsTab
                    key={value}
                    value={value}
                    className="flex items-center gap-1.5 text-sm"
                    data-testid={`marketplace-tab-${value}`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </TabsTab>
                ))}
              </TabsList>

              <div className="flex items-center gap-2">
                {/* Auth filter chips */}
                {(["", "oauth", "secret", "none"] as const).map((k) => (
                  <button
                    key={k || "all"}
                    type="button"
                    onClick={() => setAuthFilter(k)}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                      authFilter === k
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border/60 text-muted-foreground hover:border-foreground/40"
                    }`}
                    data-testid={`marketplace-filter-auth-${k || "all"}`}
                  >
                    {k === "" ? "All" : k}
                  </button>
                ))}
                <div className="relative ml-2">
                  <Search
                    className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    placeholder="Search…"
                    size="sm"
                    className="pl-7 w-52"
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    data-testid="marketplace-search-input"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Content panels */}
          {PLUGIN_TABS.map(({ value }) => (
            <TabsPanel
              key={value}
              value={value}
              className="flex-1 min-h-0 overflow-auto mt-0"
              data-testid={`marketplace-panel-${value}`}
            >
              <div className="flex h-full">
                {/* Server grid */}
                <div
                  className={`flex-1 overflow-auto p-6 ${detailId ? "border-r border-border/40" : "w-full"}`}
                >
                  {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
                  {loading && servers.length === 0 ? (
                    <div className="grid grid-cols-2 gap-3" data-testid="marketplace-grid-skeleton">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div
                          key={i}
                          className="h-28 rounded-xl border border-border/40 bg-muted/30 animate-pulse"
                        />
                      ))}
                    </div>
                  ) : (
                    <>
                      <p className="mb-3 text-xs text-muted-foreground">
                        {total} servers
                      </p>
                      <div
                        className="grid grid-cols-2 gap-3"
                        data-testid="marketplace-server-grid"
                      >
                        {servers.map((srv) => {
                          const denied = deniedNames.includes(srv.name);
                          const isSelected = selected.has(srv.id);
                          return (
                            <button
                              key={srv.id}
                              type="button"
                              onClick={() => {
                                if (!denied) setDetailId(srv.id);
                              }}
                              disabled={denied}
                              className={`relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${
                                denied
                                  ? "border-border/30 bg-muted/20 opacity-50 cursor-not-allowed"
                                  : isSelected
                                    ? "border-primary/60 bg-primary/5"
                                    : "border-border/60 bg-card hover:border-foreground/30 hover:bg-muted/30"
                              }`}
                              aria-label={
                                denied
                                  ? `${srv.title ?? srv.name} — blocked by your organization's admins`
                                  : (srv.title ?? srv.name)
                              }
                              data-testid={`marketplace-server-card-${srv.id}`}
                              data-denied={denied ? "true" : undefined}
                            >
                              {/* Multi-select checkbox — native input, styled with Tailwind */}
                              {!denied && (
                                <span
                                  className="absolute top-3 right-3"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleSelect(srv.id);
                                  }}
                                  aria-label={isSelected ? "Deselect" : "Select"}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelect(srv.id)}
                                    className="h-4 w-4 rounded border-border accent-primary"
                                    onClick={(e) => e.stopPropagation()}
                                    data-testid={`marketplace-select-${srv.id}`}
                                  />
                                </span>
                              )}

                              <div className="flex items-start gap-2 pr-6">
                                {srv.icons[0] ? (
                                  <img
                                    src={srv.icons[0].src}
                                    alt=""
                                    className="h-8 w-8 rounded object-contain flex-shrink-0"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <span className="flex h-8 w-8 items-center justify-center rounded bg-muted flex-shrink-0">
                                    <Plug
                                      className="h-4 w-4 text-muted-foreground"
                                      aria-hidden="true"
                                    />
                                  </span>
                                )}
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium leading-tight">
                                    {srv.title ?? srv.name}
                                  </p>
                                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                    {srv.description}
                                  </p>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-1">
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
                              </div>

                              {denied && (
                                <p
                                  className="text-xs text-muted-foreground italic"
                                  data-testid={`marketplace-denied-badge-${srv.id}`}
                                >
                                  Blocked by your organization&apos;s admins
                                </p>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {nextOffset !== null && (
                        <div className="mt-4 flex justify-center">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => fetchServers(nextOffset, false)}
                            disabled={loading}
                            data-testid="marketplace-load-more"
                          >
                            {loading ? "Loading…" : "Load more"}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Detail panel */}
                {detailId && (
                  <div className="w-1/2 overflow-auto" data-testid="marketplace-detail-panel">
                    <PluginDetailPanel
                      catalogId={detailId}
                      orgSlug={orgSlug}
                      pluginType={value as PluginTypeValue}
                      isDenied={
                        servers.find((s) => s.id === detailId)
                          ? deniedNames.includes(
                              servers.find((s) => s.id === detailId)!.name,
                            )
                          : false
                      }
                      installAction={installAction}
                      onInstalled={() => onOpenChange(false)}
                      onClose={() => setDetailId(null)}
                    />
                  </div>
                )}
              </div>
            </TabsPanel>
          ))}
        </Tabs>

        {/* Footer — bulk install */}
        <DialogFooter
          className="flex-shrink-0 border-t border-border/40 px-6 py-4"
          data-testid="marketplace-footer"
        >
          <p className="mr-auto text-sm text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} selected`
              : "Select plugins to bulk-install"}
          </p>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={bulkPending}
          >
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || bulkPending}
            onClick={handleBulkInstall}
            data-testid="marketplace-bulk-install-btn"
          >
            {bulkPending ? "Installing…" : `Install selected (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
