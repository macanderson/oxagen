"use client";
import * as React from "react";
import Image from "next/image";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsPanel } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PluginDetailPanel } from "./plugin-detail-panel";
import {
  CapabilityIcon,
  PLUGIN_TYPE_DEFAULTS,
  resolveIconEntry,
} from "./capability-icon";
import { useToast } from "@/components/ui/toast";
import { useTenant } from "@/lib/tenant/tenant-context";
import { Search, ShoppingBag, RefreshCw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  pluginType:
    | "mcp_server"
    | "integration"
    | "agent_capability"
    | "agent_skill"
    | "knowledge_source";
  /** Returned by the API but not rendered in the UI */
  tier?: "free" | "premium";
  installed?: boolean;
}

type PluginTypeValue =
  | "mcp_server"
  | "integration"
  | "agent_capability"
  | "agent_skill"
  | "knowledge_source";

interface MarketplaceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Server action: install single plugin */
  installAction: (input: {
    orgSlug: string;
    workspaceId: string;
    catalogServerId: string;
    pluginType: PluginTypeValue;
    pluginId?: string;
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  /** Server action: bulk install */
  installBulkAction: (input: {
    orgSlug: string;
    workspaceId: string;
    items: Array<{
      catalogServerId?: string;
      pluginType: PluginTypeValue;
      pluginId?: string;
    }>;
  }) => Promise<{ ok: boolean; error?: string }>;
}

// Agent-tool types only: skills, MCP servers, capabilities. Integrations
// (data connectors) are discovered on the Marketplace → Integrations side,
// not in this modal.
const PLUGIN_TABS = [
  { value: "agent_skill" as PluginTypeValue, label: "Skills" },
  { value: "mcp_server" as PluginTypeValue, label: "MCP Servers" },
  { value: "agent_capability" as PluginTypeValue, label: "Capabilities" },
] as const satisfies ReadonlyArray<{ value: PluginTypeValue; label: string }>;

// ── ServerIcon — picks between <Image>, <CapabilityIcon>, or per-type default ─

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
  // default — per-type colored icon
  const { iconName, color } = PLUGIN_TYPE_DEFAULTS[pluginType];
  return <CapabilityIcon iconName={iconName} color={color} size={size} />;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MarketplaceModal({
  open,
  onOpenChange,
  installAction,
  installBulkAction,
}: MarketplaceModalProps) {
  const toast = useToast();
  const { orgSlug, workspaceId } = useTenant();
  const [activeTab, setActiveTab] =
    React.useState<PluginTypeValue>("agent_skill");
  const [search, setSearch] = React.useState("");
  const [authFilter, setAuthFilter] = React.useState<
    "" | "oauth" | "secret" | "none"
  >("");
  // Installed filter: "" = all, "yes" = installed only, "no" = not installed only.
  const [installedFilter, setInstalledFilter] = React.useState<
    "" | "yes" | "no"
  >("");
  const [servers, setServers] = React.useState<CatalogServer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [bulkPending, setBulkPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch catalog via the API route (GET /api/v1/plugin/catalog/browse)
  const fetchServers = React.useCallback(
    async (offset = 0, replace = true) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          pluginType: activeTab,
          limit: "30",
          offset: String(offset),
        });
        if (search.trim()) params.set("search", search.trim());
        if (authFilter) params.set("authKind", authFilter);
        if (installedFilter === "yes") params.set("installed", "true");
        else if (installedFilter === "no") params.set("installed", "false");
        if (workspaceId) params.set("workspaceId", workspaceId);
        const res = await fetch(
          `/api/v1/plugin/catalog/browse?${params.toString()}`,
        );
        // Do NOT surface the raw response body — a 5xx from the edge returns an
        // HTML error page, and a handler error can carry internal detail. Log
        // the body for the console, show the user a stable, actionable line.
        if (!res.ok) {
          console.error(
            `plugin/catalog/browse failed (${res.status})`,
            await res.text().catch(() => ""),
          );
          throw new Error(
            res.status === 403
              ? "You don't have access to the plugin catalog for this workspace."
              : `Couldn't load the plugin catalog (${res.status}). Try again in a moment.`,
          );
        }
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
        setError(e instanceof Error ? e.message : "Failed to load catalog");
      } finally {
        setLoading(false);
      }
    },
    [activeTab, search, authFilter, installedFilter, workspaceId],
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
  }, [open, activeTab, authFilter, installedFilter, fetchServers]);

  // Debounce search input
  const searchTimeoutRef =
    React.useRef<ReturnType<typeof setTimeout>>(undefined);
  // Clear any pending debounce when the modal unmounts so the callback cannot
  // fire against an already-unmounted component.
  React.useEffect(() => () => clearTimeout(searchTimeoutRef.current), []);
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
      // ── BULK-INSTALL FIX ─────────────────────────────────────────────────────
      // `selected` stores `srv.id` (the compound catalog id, e.g.
      // "registryId:serverName:version" for MCP, or a UUID for skills).
      // The install handler expects the server's *name* / skill *slug*, not the
      // compound id.  Resolve each selected id back to its srv.name here.
      const result = await installBulkAction({
        orgSlug,
        workspaceId,
        items: Array.from(selected).map((id) => {
          const srv = servers.find((s) => s.id === id);
          return { catalogServerId: srv?.name ?? id, pluginType: activeTab };
        }),
      });
      if (!result.ok) {
        setError(result.error ?? "Bulk install failed");
        toast.add({
          title: "Install failed",
          description: result.error ?? "Some plugins could not be installed.",
          type: "error",
        });
        return;
      }
      const count = selected.size;
      setSelected(new Set());
      toast.add({
        title: count === 1 ? "Plugin installed" : `${count} plugins installed`,
        description: "You can use it now.",
        type: "success",
      });
      onOpenChange(false);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-[1100px] w-[calc(100vw-2rem)] h-[80vh] flex flex-col gap-0 p-0 overflow-hidden"
        data-testid="marketplace-modal"
      >
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <ShoppingBag
              className="h-5 w-5 text-muted-foreground"
              aria-hidden="true"
            />
            Agent Tools Marketplace
          </DialogTitle>
          <DialogDescription>
            Browse and install skills, MCP servers, and capabilities for your
            workspace.
          </DialogDescription>
        </DialogHeader>

        {/*
         * WIDTH CONTAINMENT CHANGES:
         * 1. Outer flex row has overflow-hidden (prevents any child from
         *    blowing past the dialog edge).
         * 2. Left nav is w-52 flex-shrink-0 (fixed; never grows/shrinks).
         * 3. Right content column has min-w-0 (allows flex to shrink it).
         * 4. Inner content+detail row also has overflow-hidden + min-w-0.
         * 5. Detail panel is w-80 flex-shrink-0 (fixed; not w-1/2 which
         *    could exceed the dialog on smaller viewports).
         * 6. Filter chip row uses flex-wrap so chips wrap, never overflow.
         */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v as PluginTypeValue);
            setSelected(new Set());
            // Clear server list immediately so the previous type's results never flash.
            setServers([]);
          }}
          className="flex flex-row flex-1 min-h-0 overflow-hidden"
        >
          {/* ── Vertical left nav ──────────────────────────────────────────── */}
          <nav
            className="w-52 flex-shrink-0 flex flex-col border-r border-border/40 overflow-y-auto py-3"
            aria-label="Plugin type navigation"
            data-testid="marketplace-tab-bar"
          >
            {PLUGIN_TABS.map(({ value, label }) => {
              const { iconName, color } = PLUGIN_TYPE_DEFAULTS[value];
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
                    setSelected(new Set());
                    setServers([]);
                  }}
                  className={`flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors ${
                    isActive
                      ? "bg-muted/60 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                  }`}
                  data-testid={`marketplace-tab-${value}`}
                >
                  <CapabilityIcon iconName={iconName} color={color} size={22} />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>

          {/* ── Right content column ───────────────────────────────────────── */}
          {/* min-w-0 lets this column shrink so the nav stays at w-52 */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            {/* Filter bar — inside the right column only */}
            <div
              className="flex-shrink-0 px-5 py-2.5 border-b border-border/40"
              data-testid="marketplace-filter-bar"
            >
              {/* flex-wrap: chips never push past the column edge */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Auth filter chips — not applicable for agent/knowledge types */}
                {(activeTab === "mcp_server" || activeTab === "integration") &&
                  (["", "oauth", "secret", "none"] as const).map((k) => (
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

                {/* Installed filter chips — applies to every tab */}
                {(activeTab === "mcp_server" ||
                  activeTab === "integration") && (
                  <span className="h-4 w-px bg-border/60" aria-hidden="true" />
                )}
                {(
                  [
                    ["", "All"],
                    ["yes", "Installed"],
                    ["no", "Not installed"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={`installed-${k || "all"}`}
                    type="button"
                    onClick={() => setInstalledFilter(k)}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                      installedFilter === k
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border/60 text-muted-foreground hover:border-foreground/40"
                    }`}
                    data-testid={`marketplace-filter-installed-${k || "all"}`}
                  >
                    {label}
                  </button>
                ))}

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
                    data-testid="marketplace-search-input"
                  />
                </div>

                {/* Refresh catalog button — triggers immediate sync */}
                {activeTab === "mcp_server" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await fetch("/api/v1/plugin/catalog/sync", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ fullSync: false }),
                        });
                        toast.add({
                          title: "Catalog refresh started",
                          description: "New servers will appear shortly.",
                          type: "success",
                        });
                        // Re-fetch after a brief delay to show new results
                        setTimeout(() => fetchServers(0, true), 2000);
                      } catch {
                        toast.add({
                          title: "Refresh failed",
                          description: "Could not sync the registry catalog.",
                          type: "error",
                        });
                      }
                    }}
                    className="flex-shrink-0"
                    aria-label="Refresh server catalog"
                    data-testid="marketplace-refresh-btn"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </div>

            {/* Content panels */}
            {PLUGIN_TABS.map(({ value }) => (
              <TabsPanel
                key={value}
                value={value}
                className="flex-1 min-h-0 overflow-hidden mt-0"
                data-testid={`marketplace-panel-${value}`}
              >
                {/* overflow-hidden on the row wrapper prevents any child from
                    blowing past the right content column edge. */}
                <div className="flex h-full overflow-hidden min-w-0">
                  {/* Server grid — min-w-0 so it shrinks when panel is open */}
                  <div
                    className={`flex-1 min-w-0 overflow-auto p-5 ${detailId ? "border-r border-border/40" : ""}`}
                  >
                    {error && (
                      <p className="mb-4 text-sm text-destructive">{error}</p>
                    )}
                    {loading && servers.length === 0 ? (
                      <div
                        className="grid grid-cols-2 gap-3"
                        data-testid="marketplace-grid-skeleton"
                      >
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
                          {total}{" "}
                          {value === "agent_capability" ||
                          value === "agent_skill" ||
                          value === "knowledge_source"
                            ? "plugins"
                            : "servers"}
                        </p>
                        {/* min-w-0 on the grid prevents grid cells from
                            overflowing the available column width. */}
                        <div
                          className="grid grid-cols-2 gap-3 min-w-0"
                          data-testid="marketplace-server-grid"
                        >
                          {servers.length === 0 && (
                            <p
                              className="col-span-2 py-8 text-center text-sm text-muted-foreground"
                              data-testid="marketplace-no-results"
                            >
                              No plugins found.
                            </p>
                          )}
                          {servers.map((srv) => {
                            const isSelected = selected.has(srv.id);
                            return (
                              <button
                                key={srv.id}
                                type="button"
                                onClick={() => setDetailId(srv.id)}
                                className={`relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors min-w-0 overflow-hidden ${
                                  isSelected
                                    ? "border-primary/60 bg-primary/5"
                                    : "border-border/60 bg-card hover:border-foreground/30 hover:bg-muted/30"
                                }`}
                                aria-label={srv.title ?? srv.name}
                                data-testid={`marketplace-server-card-${srv.id}`}
                              >
                                {/* Multi-select checkbox */}
                                <span
                                  className="absolute top-3 right-3"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                  }}
                                  aria-label={
                                    isSelected ? "Deselect" : "Select"
                                  }
                                >
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={() => toggleSelect(srv.id)}
                                    data-testid={`marketplace-select-${srv.id}`}
                                  />
                                </span>

                                <div className="flex items-start gap-2 pr-6 min-w-0">
                                  <ServerIcon
                                    icons={srv.icons}
                                    pluginType={srv.pluginType}
                                    size={32}
                                  />
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
                                  {srv.installed && (
                                    <Badge
                                      variant="success"
                                      size="sm"
                                      data-testid={`marketplace-installed-badge-${srv.id}`}
                                    >
                                      Installed
                                    </Badge>
                                  )}
                                  {srv.pluginType === "mcp_server" ||
                                  srv.pluginType === "integration" ? (
                                    <>
                                      {srv.transportTypes
                                        .slice(0, 2)
                                        .map((t) => (
                                          <Badge
                                            key={t}
                                            variant="outline"
                                            size="sm"
                                          >
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
                                    <>
                                      {srv.categories.slice(0, 2).map((c) => (
                                        <Badge
                                          key={c}
                                          variant="outline"
                                          size="sm"
                                        >
                                          {c}
                                        </Badge>
                                      ))}
                                    </>
                                  )}
                                </div>
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

                  {/* Detail panel — fixed width so it doesn't take half the
                      available space (which could exceed dialog at small sizes).
                      w-80 / flex-shrink-0 keeps it from growing or shrinking. */}
                  {detailId && (
                    <div
                      className="w-80 flex-shrink-0 overflow-auto"
                      data-testid="marketplace-detail-panel"
                    >
                      {(() => {
                        const detailServer = servers.find(
                          (s) => s.id === detailId,
                        );
                        return (
                          <PluginDetailPanel
                            serverName={detailServer?.name ?? detailId}
                            pluginType={value as PluginTypeValue}
                            installAction={(input) =>
                              installAction({ ...input, workspaceId })
                            }
                            onInstalled={() => onOpenChange(false)}
                            onClose={() => setDetailId(null)}
                          />
                        );
                      })()}
                    </div>
                  )}
                </div>
              </TabsPanel>
            ))}
          </div>
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
            {bulkPending
              ? "Installing…"
              : `Install selected (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
