"use client";
/**
 * mcp-catalog-search.tsx — search the MCP registry catalog and install from
 * this page (Workbench → Agent Tools → MCP Servers).
 *
 * Same data source (GET /api/v1/plugin/catalog/browse → plugin.catalog.browse)
 * and the same single install path (installPlugin server action →
 * plugin.org.install) as the Marketplace browse panel. What's new here: the
 * install result carries the probed `authKind`, and when it is "oauth" the
 * post-install AuthenticateDialog opens — the server won't work until the
 * user completes the provider's OAuth consent flow.
 */
import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useTenant } from "@/lib/tenant/tenant-context";
import {
  CapabilityIcon,
  PLUGIN_TYPE_DEFAULTS,
  resolveIconEntry,
} from "@/components/plugins/capability-icon";
import { AuthenticateDialog } from "./authenticate-dialog";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogRow {
  id: string;
  name: string;
  title: string | null;
  description: string;
  icons: Array<{ src: string; color?: string }>;
  transportTypes: string[];
  authKind: string;
  version: string;
  installed?: boolean;
}

type InstallResult = {
  ok: boolean;
  orgListingId?: string;
  authKind?: "oauth" | "secret" | "none";
  error?: string;
};

export interface McpCatalogSearchProps {
  orgSlug: string;
  workspaceSlug: string;
  installAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    catalogServerId: string;
    pluginType: "mcp_server";
  }) => Promise<InstallResult>;
}

// Only remote-capable servers are installable from here — package-only
// (stdio) registry entries have no hosted endpoint to connect to.
const REMOTE_TRANSPORTS = new Set(["streamable-http", "sse", "http"]);

export function isRemoteInstallable(transportTypes: string[]): boolean {
  return transportTypes.some((t) => REMOTE_TRANSPORTS.has(t));
}

function RowIcon({ icons }: { icons: CatalogRow["icons"] }) {
  const resolved = resolveIconEntry(icons);
  if (resolved.type === "image") {
    return (
      <Image
        src={resolved.src}
        alt=""
        width={28}
        height={28}
        unoptimized
        className="rounded object-contain flex-shrink-0"
        style={{ width: 28, height: 28 }}
        aria-hidden="true"
      />
    );
  }
  const fallback = PLUGIN_TYPE_DEFAULTS.mcp_server;
  return (
    <CapabilityIcon
      iconName={
        resolved.type === "lucide" ? resolved.iconName : fallback.iconName
      }
      color={
        (resolved.type === "lucide" ? resolved.color : null) ?? fallback.color
      }
      size={28}
    />
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function McpCatalogSearch({
  orgSlug,
  workspaceSlug,
  installAction,
}: McpCatalogSearchProps) {
  const toast = useToast();
  const router = useRouter();
  const { workspaceId } = useTenant();

  const [query, setQuery] = React.useState("");
  const [rows, setRows] = React.useState<CatalogRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [installingId, setInstallingId] = React.useState<string | null>(null);
  const [authPrompt, setAuthPrompt] = React.useState<{
    orgListingId: string;
    serverTitle: string;
  } | null>(null);

  const requestSeq = React.useRef(0);

  const fetchRows = React.useCallback(
    async (search: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          pluginType: "mcp_server",
          limit: "12",
          offset: "0",
          workspaceId,
        });
        if (search.trim()) params.set("search", search.trim());
        const res = await fetch(
          `/api/v1/plugin/catalog/browse?${params.toString()}`,
        );
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { servers: CatalogRow[] };
        if (seq !== requestSeq.current) return; // stale response — a newer search superseded it
        setRows(data.servers);
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setError(e instanceof Error ? e.message : "Failed to load the catalog");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [workspaceId],
  );

  // Initial load + debounced search.
  const debounceRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(debounceRef.current), []);
  React.useEffect(() => {
    void fetchRows("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleQueryChange = (val: string) => {
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchRows(val), 300);
  };

  const returnTo = `/${orgSlug}/${workspaceSlug}/workbench/tools/mcp`;

  const handleInstall = async (row: CatalogRow) => {
    setInstallingId(row.id);
    const title = row.title ?? row.name;
    try {
      const result = await installAction({
        orgSlug,
        workspaceSlug,
        catalogServerId: row.name,
        pluginType: "mcp_server",
      });
      if (!result.ok || !result.orgListingId) {
        toast.add({
          title: "Install failed",
          description: result.error ?? `Could not install ${title}.`,
          type: "error",
        });
        return;
      }

      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, installed: true } : r)),
      );
      toast.add({
        title: `${title} installed`,
        description:
          result.authKind === "oauth"
            ? "One more step: authenticate to activate it."
            : "You can use it now.",
        type: "success",
      });

      if (result.authKind === "oauth") {
        // The server is installed but unusable until the OAuth consent flow
        // completes — prompt immediately.
        setAuthPrompt({
          orgListingId: result.orgListingId,
          serverTitle: title,
        });
      }
      router.refresh();
    } catch (e) {
      toast.add({
        title: "Install failed",
        description:
          e instanceof Error ? e.message : `Could not install ${title}.`,
        type: "error",
      });
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="mcp-catalog-search">
      <div className="flex items-center gap-2 max-w-md">
        <Search
          className="h-4 w-4 text-muted-foreground flex-shrink-0"
          aria-hidden="true"
        />
        <Input
          placeholder="Search the MCP catalog — try “Stripe”…"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          className="h-8"
          aria-label="Search the MCP server catalog"
          data-testid="mcp-catalog-search-input"
        />
        {loading ? (
          <Loader2
            className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground"
            aria-label="Searching"
          />
        ) : null}
      </div>

      {error ? (
        <p
          className="text-xs text-destructive"
          data-testid="mcp-catalog-search-error"
        >
          {error}
        </p>
      ) : null}

      {rows.length === 0 && !loading && !error ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="mcp-catalog-search-empty"
        >
          No servers match{query.trim() ? ` “${query.trim()}”` : ""} yet.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border/40 rounded-lg border border-border/40">
          {rows.map((row) => {
            const title = row.title ?? row.name;
            const installable = isRemoteInstallable(row.transportTypes);
            return (
              <li
                key={row.id}
                className="flex items-center gap-3 px-4 py-3"
                data-testid={`mcp-catalog-row-${row.name}`}
              >
                <RowIcon icons={row.icons} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{title}</p>
                    {row.transportTypes.map((t) => (
                      <Badge key={t} variant="outline" size="sm">
                        {t}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {row.description}
                  </p>
                </div>
                {row.installed ? (
                  <Badge variant="muted" size="sm">
                    Installed
                  </Badge>
                ) : installable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleInstall(row)}
                    disabled={installingId !== null}
                    data-testid={`mcp-catalog-install-${row.name}`}
                  >
                    {installingId === row.id ? "Installing…" : "Install"}
                  </Button>
                ) : (
                  <Badge variant="muted" size="sm">
                    No hosted endpoint
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {authPrompt ? (
        <AuthenticateDialog
          open
          onOpenChange={(open) => {
            if (!open) setAuthPrompt(null);
          }}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          orgListingId={authPrompt.orgListingId}
          serverTitle={authPrompt.serverTitle}
          returnTo={returnTo}
        />
      ) : null}
    </div>
  );
}
