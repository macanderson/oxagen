"use client";
import * as React from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useTenant } from "@/lib/tenant/tenant-context";
import {
  CapabilityIcon,
  PLUGIN_TYPE_DEFAULTS,
  resolveIconEntry,
} from "./capability-icon";
import { ExternalLink, X } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type PluginTypeValue =
  | "mcp_server"
  | "integration"
  | "agent_capability"
  | "agent_skill"
  | "knowledge_source";

interface CatalogDetail {
  name: string;
  title: string | null;
  description: string;
  version: string;
  websiteUrl: string | null;
  icons: Array<{ src: string; color?: string }>;
  packages: unknown[];
  remotes: Array<{ transportType?: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  readmeHtml?: string | null;
  status?: string;
  installed?: boolean;
}

interface PluginDetailPanelProps {
  /** Registry server name used to fetch detail via catalog/get?name=&version=latest */
  serverName: string;
  pluginType: PluginTypeValue;
  installAction: (input: {
    orgSlug: string;
    catalogServerId: string;
    pluginType: PluginTypeValue;
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  onInstalled: () => void;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PluginDetailPanel({
  serverName,
  pluginType,
  installAction,
  onInstalled,
  onClose,
}: PluginDetailPanelProps) {
  const toast = useToast();
  const { orgSlug, workspaceId } = useTenant();
  const [detail, setDetail] = React.useState<CatalogDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [installing, setInstalling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDetail(null);
    setError(null);
    fetch(
      `/api/v1/plugin/catalog/get?name=${encodeURIComponent(serverName)}&version=latest&workspaceId=${encodeURIComponent(workspaceId)}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        // Parse defensively: a non-OK response returns `{ error }`, not a
        // CatalogDetail. Treating that body as detail (the old behaviour) made
        // the render crash on `detail.icons[0]` — which took the whole
        // marketplace panel down. Validate status + shape before committing.
        const body = (await r.json().catch(() => null)) as
          | (CatalogDetail & { error?: string })
          | null;
        if (!r.ok || body == null || typeof body.error === "string") {
          throw new Error(
            (body && typeof body.error === "string" && body.error) ||
              `Failed to load plugin detail (${r.status})`,
          );
        }
        return body as CatalogDetail;
      })
      .then((d) => {
        setDetail(d);
        setLoading(false);
      })
      .catch((e) => {
        if ((e as { name?: string }).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed");
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
    // workspaceId is used in the fetch URL — refetch if the active workspace changes.
  }, [serverName, workspaceId]);

  const handleInstall = async () => {
    if (!detail) return;
    setInstalling(true);
    setError(null);
    try {
      const result = await installAction({
        orgSlug,
        catalogServerId: detail.name,
        pluginType,
      });
      if (!result.ok) {
        setError(result.error ?? "Install failed");
        toast.add({
          title: "Install failed",
          description:
            result.error ?? `Could not install ${detail.title ?? detail.name}.`,
          type: "error",
        });
        return;
      }
      toast.add({
        title: `${detail.title ?? detail.name} installed`,
        description: "You can use it now.",
        type: "success",
      });
      onInstalled();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Install failed";
      setError(message);
      toast.add({
        title: "Install failed",
        description: message,
        type: "error",
      });
    } finally {
      setInstalling(false);
    }
  };

  if (loading) {
    return (
      <div
        className="flex flex-col gap-4 p-6"
        data-testid="plugin-detail-loading"
      >
        <div className="h-12 w-12 rounded-xl bg-muted/40 animate-pulse" />
        <div className="h-5 w-48 rounded bg-muted/40 animate-pulse" />
        <div className="h-3 w-full rounded bg-muted/40 animate-pulse" />
        <div className="h-3 w-3/4 rounded bg-muted/40 animate-pulse" />
      </div>
    );
  }

  if (!detail) {
    return (
      <p
        className="p-6 text-sm text-destructive"
        data-testid="plugin-detail-error"
      >
        {error ?? "Not found"}
      </p>
    );
  }

  const isAgentOrKnowledge =
    pluginType === "agent_capability" ||
    pluginType === "agent_skill" ||
    pluginType === "knowledge_source";

  return (
    <div className="flex h-full flex-col" data-testid="plugin-detail-panel">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border/40 p-6">
        {(() => {
          const resolved = resolveIconEntry(detail.icons);
          if (resolved.type === "image") {
            return (
              <Image
                src={resolved.src}
                alt=""
                width={48}
                height={48}
                unoptimized
                className="h-12 w-12 rounded-xl object-contain flex-shrink-0"
                aria-hidden="true"
              />
            );
          }
          if (resolved.type === "lucide") {
            return (
              <CapabilityIcon
                iconName={resolved.iconName}
                color={resolved.color ?? PLUGIN_TYPE_DEFAULTS[pluginType].color}
                size={48}
              />
            );
          }
          // default — per-type colored icon
          const { iconName, color } = PLUGIN_TYPE_DEFAULTS[pluginType];
          return <CapabilityIcon iconName={iconName} color={color} size={48} />;
        })()}
        <div className="min-w-0 flex-1">
          <h3
            className="text-base font-semibold"
            data-testid="plugin-detail-title"
          >
            {detail.title ?? detail.name}
          </h3>
          <p className="text-xs text-muted-foreground">
            {detail.name} · v{detail.version}
          </p>
          {detail.websiteUrl && (
            <a
              href={detail.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline"
              data-testid="plugin-detail-website"
            >
              {detail.websiteUrl.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Close detail"
          data-testid="plugin-detail-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Badges */}
      <div
        className="flex flex-wrap gap-1.5 border-b border-border/40 px-6 py-3"
        data-testid="plugin-detail-badges"
      >
        {detail.installed && (
          <Badge
            variant="success"
            size="sm"
            data-testid="plugin-detail-installed-badge"
          >
            Installed
          </Badge>
        )}
        {isAgentOrKnowledge ? (
          <>
            {detail.categories.slice(0, 3).map((c) => (
              <Badge key={c} variant="secondary" size="sm">
                {c}
              </Badge>
            ))}
          </>
        ) : (
          <>
            {detail.transportTypes.map((t) => (
              <Badge key={t} variant="outline" size="sm">
                {t}
              </Badge>
            ))}
            <Badge
              variant={
                detail.authKind === "oauth"
                  ? "info"
                  : detail.authKind === "secret"
                    ? "warning"
                    : "muted"
              }
              size="sm"
            >
              {detail.authKind === "none" ? "No auth" : detail.authKind}
            </Badge>
            {detail.categories.slice(0, 3).map((c) => (
              <Badge key={c} variant="secondary" size="sm">
                {c}
              </Badge>
            ))}
            {detail.status && detail.status !== "active" && (
              <Badge variant="destructive" size="sm">
                {detail.status}
              </Badge>
            )}
          </>
        )}
      </div>

      {/* Body — description + README */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <p className="mb-3 text-sm text-muted-foreground">
          {detail.description}
        </p>
        {!isAgentOrKnowledge &&
          (detail.readmeHtml ? (
            // TRUST BOUNDARY — readmeHtml is produced by
            // packages/plugins/src/registry/readme.ts `fetchAndRenderReadme`,
            // which runs the pipeline:
            //   remarkParse → remarkGfm → remarkRehype → rehypeSanitize → rehypeStringify
            // The `plugin.catalog.get` handler (packages/handlers/src/plugin.catalog.get.ts)
            // calls `fetchAndRenderReadme` so that rehype-sanitize runs before
            // serialisation. Do NOT assign unsanitized markdown or third-party
            // HTML to this prop.
            <div
              className="prose prose-sm dark:prose-invert max-w-none text-sm"
              dangerouslySetInnerHTML={{ __html: detail.readmeHtml }}
              data-testid="plugin-detail-readme"
            />
          ) : (
            <p
              className="text-xs text-muted-foreground italic"
              data-testid="plugin-detail-no-readme"
            >
              No README available.
            </p>
          ))}
      </div>

      {/* Install footer */}
      <div className="flex-shrink-0 border-t border-border/40 px-6 py-4">
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        {detail.installed ? (
          <Button
            className="w-full"
            variant="outline"
            disabled
            data-testid="plugin-detail-install-btn"
          >
            Already installed
          </Button>
        ) : (
          <Button
            className="w-full"
            onClick={handleInstall}
            disabled={
              installing ||
              (!isAgentOrKnowledge &&
                detail.status !== "active" &&
                detail.status !== undefined)
            }
            data-testid="plugin-detail-install-btn"
          >
            {installing ? "Installing…" : "Install to workspace"}
          </Button>
        )}
      </div>
    </div>
  );
}
