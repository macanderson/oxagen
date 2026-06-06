/**
 * Org plugins settings page — static mock UI.
 *
 * Displays installed plugins, registries, and denylist with hardcoded data.
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live plugin data in OXA-XXXX (see parent ticket).
 */

import {
  Globe,
  Package,
  Plug,
  ShoppingBag,
  Shield,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import {
  Card,
  CardPanel,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Mock data — realistic, hardcoded. Replace with DB query when wired.
// ---------------------------------------------------------------------------

type PluginType = "mcp_server" | "integration" | "content_tool";
type PluginStatus = "enabled" | "disabled" | "error";

interface MockPlugin {
  id: string;
  name: string;
  title: string;
  description: string;
  pluginType: PluginType;
  status: PluginStatus;
  installedAt: string;
  lastUsedAt: string | null;
  registry: string;
}

interface MockRegistry {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  isDefaultSeed: boolean;
  lastSyncedAt: string | null;
  pluginCount: number;
}

interface MockDenylistEntry {
  id: string;
  pluginName: string;
  reason: string | null;
  addedAt: string;
  addedBy: string;
}

const MOCK_PLUGINS: MockPlugin[] = [
  {
    id: "plg_01j9xpqa",
    name: "github-mcp",
    title: "GitHub",
    description:
      "Read and write GitHub repos, issues, pull requests, and CI runs via MCP.",
    pluginType: "mcp_server",
    status: "enabled",
    installedAt: "May 29, 2026",
    lastUsedAt: "Jun 6, 2026",
    registry: "Oxagen Registry",
  },
  {
    id: "plg_02j9xpqb",
    name: "linear-mcp",
    title: "Linear",
    description:
      "Create, update, and triage Linear issues and projects from the agent.",
    pluginType: "mcp_server",
    status: "enabled",
    installedAt: "May 30, 2026",
    lastUsedAt: "Jun 6, 2026",
    registry: "Oxagen Registry",
  },
  {
    id: "plg_03j9xpqc",
    name: "google-drive-integration",
    title: "Google Drive",
    description:
      "Sync files, documents, and spreadsheets from Google Drive into the knowledge graph.",
    pluginType: "integration",
    status: "enabled",
    installedAt: "Jun 1, 2026",
    lastUsedAt: "Jun 5, 2026",
    registry: "Oxagen Registry",
  },
  {
    id: "plg_04j9xpqd",
    name: "pdf-extractor",
    title: "PDF Extractor",
    description:
      "Extract structured content from PDF documents for knowledge ingestion.",
    pluginType: "content_tool",
    status: "disabled",
    installedAt: "Jun 2, 2026",
    lastUsedAt: null,
    registry: "Oxagen Registry",
  },
  {
    id: "plg_05j9xpqe",
    name: "notion-integration",
    title: "Notion",
    description:
      "Sync Notion pages and databases into the org knowledge graph.",
    pluginType: "integration",
    status: "error",
    installedAt: "Jun 3, 2026",
    lastUsedAt: "Jun 4, 2026",
    registry: "Oxagen Registry",
  },
];

const MOCK_REGISTRIES: MockRegistry[] = [
  {
    id: "reg_01",
    name: "Oxagen Registry",
    baseUrl: "https://registry.oxagen.ai",
    enabled: true,
    isDefaultSeed: true,
    lastSyncedAt: "Jun 6, 2026 · 08:00 AM",
    pluginCount: 42,
  },
  {
    id: "reg_02",
    name: "Internal Tools",
    baseUrl: "https://tools.acme.io/mcp-registry",
    enabled: true,
    isDefaultSeed: false,
    lastSyncedAt: "Jun 5, 2026 · 06:30 PM",
    pluginCount: 7,
  },
];

const MOCK_DENYLIST: MockDenylistEntry[] = [
  {
    id: "dny_01",
    pluginName: "external-code-exec",
    reason: "Unapproved arbitrary code execution — security review pending.",
    addedAt: "Jun 3, 2026",
    addedBy: "Mac Anderson",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_TYPE_LABEL: Record<PluginType, string> = {
  mcp_server: "MCP server",
  integration: "Integration",
  content_tool: "Content tool",
};

const STATUS_CONFIG: Record<
  PluginStatus,
  { label: string; variant: "default" | "muted" | "destructive"; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }
> = {
  enabled: { label: "Enabled", variant: "default", icon: CheckCircle2 },
  disabled: { label: "Disabled", variant: "muted", icon: XCircle },
  error: { label: "Error", variant: "destructive", icon: AlertTriangle },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function OrgPluginsPage() {
  const enabledCount = MOCK_PLUGINS.filter((p) => p.status === "enabled").length;
  const errorCount = MOCK_PLUGINS.filter((p) => p.status === "error").length;

  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>

      {/* Summary strip */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-muted/30 px-4 py-2.5 text-sm">
          <Plug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium text-foreground">{enabledCount}</span>
          <span className="text-muted-foreground">active plugins</span>
        </div>
        {errorCount > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            <span className="font-medium text-destructive">{errorCount}</span>
            <span className="text-muted-foreground">with errors</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled>
            <ShoppingBag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Browse marketplace
          </Button>
        </div>
      </div>

      {/* Installed plugins */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Installed plugins</CardTitle>
              <CardDescription>
                MCP servers, integrations, and content tools enabled for this
                organization.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          <div className="flex flex-col gap-2">
            {MOCK_PLUGINS.map((plugin) => {
              const cfg = STATUS_CONFIG[plugin.status];
              const StatusIcon = cfg.icon;
              return (
                <div
                  key={plugin.id}
                  className="flex flex-wrap items-start gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-card">
                    <Plug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  </div>

                  <div className="flex flex-1 flex-col gap-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {plugin.title}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {PLUGIN_TYPE_LABEL[plugin.pluginType]}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-snug">
                      {plugin.description}
                    </p>
                    <p className="text-[11px] text-muted-foreground/60">
                      {plugin.registry} &middot; Installed {plugin.installedAt}
                      {plugin.lastUsedAt && ` · Last used ${plugin.lastUsedAt}`}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 mt-0.5">
                    <Badge variant={cfg.variant} className="text-xs">
                      <StatusIcon className="mr-1 h-3 w-3" aria-hidden="true" />
                      {cfg.label}
                    </Badge>
                    <Button variant="ghost" size="sm" disabled>
                      Configure
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardPanel>
      </Card>

      {/* Registries */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <Globe className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Plugin registries</CardTitle>
              <CardDescription>
                Sources this org syncs plugin catalogs from. Default registries
                cannot be removed.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          <div className="flex flex-col gap-2">
            {MOCK_REGISTRIES.map((reg) => (
              <div
                key={reg.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3"
              >
                <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {reg.name}
                    </span>
                    {reg.isDefaultSeed && (
                      <Badge variant="muted" className="text-[10px]">
                        Default
                      </Badge>
                    )}
                    <Badge
                      variant={reg.enabled ? "default" : "outline"}
                      className="text-[10px]"
                    >
                      {reg.enabled ? "Active" : "Paused"}
                    </Badge>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground truncate">
                    {reg.baseUrl}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60">
                    {reg.pluginCount} plugins &middot; Last synced{" "}
                    {reg.lastSyncedAt ?? "never"}
                  </p>
                </div>
                {!reg.isDefaultSeed && (
                  <Button variant="ghost" size="sm" disabled className="shrink-0">
                    Remove
                  </Button>
                )}
              </div>
            ))}

            <Button variant="outline" size="sm" disabled className="mt-1 w-fit">
              <Globe className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Add registry
            </Button>
          </div>
        </CardPanel>
      </Card>

      {/* Denylist */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <Shield className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Plugin denylist</CardTitle>
              <CardDescription>
                Plugins blocked for this organization. Denylisted plugins cannot
                be installed by any workspace member.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          {MOCK_DENYLIST.length === 0 ? (
            <p className="text-xs text-muted-foreground px-4 py-6 text-center">
              No plugins are denylisted for this organization.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {MOCK_DENYLIST.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-start gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3"
                >
                  <Shield className="h-4 w-4 shrink-0 text-destructive mt-0.5" aria-hidden="true" />
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium font-mono text-foreground">
                      {entry.pluginName}
                    </span>
                    {entry.reason && (
                      <p className="text-xs text-muted-foreground leading-snug">
                        {entry.reason}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/60">
                      Added by {entry.addedBy} on {entry.addedAt}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
