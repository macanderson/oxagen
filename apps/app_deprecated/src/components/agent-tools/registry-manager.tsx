"use client";
/**
 * registry-manager.tsx — workspace-scoped registry self-service UI.
 *
 * Lists registries, allows adding by name + URL, and removing any registry
 * (including the default — the contract promotes the next-oldest when removed).
 * Enforces the single-default rule: when exactly one registry exists, it is
 * implicitly default and cannot be removed without a replacement.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { Globe, Plus, Trash2, HelpCircle } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegistryRow {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  isDefault: boolean;
}

interface RegistryManagerProps {
  orgSlug: string;
  workspaceSlug: string;
  initialRegistries: RegistryRow[];
  docsBaseUrl: string;
  addRegistryAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    name: string;
    baseUrl: string;
  }) => Promise<{
    ok: boolean;
    registryId?: string;
    isDefault?: boolean;
    error?: string;
  }>;
  removeRegistryAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    registryId: string;
  }) => Promise<{ ok: boolean; promotedId?: string | null; error?: string }>;
}

// ── RegistryHelpPopover ───────────────────────────────────────────────────────

function RegistryHelpPopover({ docsBaseUrl }: { docsBaseUrl: string }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="What is a plugin registry?"
            className="inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground hover:text-foreground transition-colors"
          />
        }
      >
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup className="w-80">
        <p className="mb-2 font-semibold text-sm text-foreground">
          What is a registry?
        </p>
        <p className="mb-3 text-xs text-muted-foreground leading-relaxed">
          A plugin registry is a URL that exposes a list of available MCP
          servers and tools. Oxagen queries the registry to populate the
          marketplace and discover installable plugins. Any server implementing
          the{" "}
          <span className="font-medium text-foreground">
            MCP Registry OpenAPI spec
          </span>{" "}
          can be added.
        </p>
        <p className="mb-2 text-xs font-medium text-foreground">
          Example registry URL
        </p>
        <code className="block mb-3 rounded-md bg-muted px-3 py-2 text-xs font-mono text-foreground break-all">
          https://registry.modelcontextprotocol.io
        </code>
        <a
          href={`${docsBaseUrl}/plugins/registries`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Learn more about registries
        </a>
      </PopoverPopup>
    </Popover>
  );
}

// ── RegistryManager ───────────────────────────────────────────────────────────

export function RegistryManager({
  orgSlug,
  workspaceSlug,
  initialRegistries,
  docsBaseUrl,
  addRegistryAction,
  removeRegistryAction,
}: RegistryManagerProps) {
  const [registries, setRegistries] =
    React.useState<RegistryRow[]>(initialRegistries);
  const [showForm, setShowForm] = React.useState(false);
  const [name, setName] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

  const handleAdd = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError("Registry name and URL are required.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await addRegistryAction({
      orgSlug,
      workspaceSlug,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to add registry");
      return;
    }
    // Append optimistically — the page will revalidate on next load for full consistency.
    if (result.registryId) {
      const isFirstAndDefault =
        registries.length === 0 || result.isDefault === true;
      const newReg: RegistryRow = {
        id: result.registryId,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        enabled: true,
        isDefault: isFirstAndDefault,
      };
      // If the new registry is default, clear the old default flag on existing entries.
      setRegistries((prev) => {
        const updated = isFirstAndDefault
          ? prev.map((r) => ({ ...r, isDefault: false }))
          : prev;
        return [...updated, newReg];
      });
    }
    setName("");
    setBaseUrl("");
    setShowForm(false);
  };

  const handleRemove = async (reg: RegistryRow) => {
    if (
      !window.confirm(
        `Remove registry "${reg.name}"? Plugins sourced from it will remain installed but won't receive future catalog updates.`,
      )
    )
      return;
    setRemovingId(reg.id);
    setError(null);
    const result = await removeRegistryAction({
      orgSlug,
      workspaceSlug,
      registryId: reg.id,
    });
    setRemovingId(null);
    if (!result.ok) {
      setError(result.error ?? "Remove failed");
      return;
    }
    // Update local state: remove the registry and promote the new default if returned.
    setRegistries((prev) => {
      const remaining = prev.filter((r) => r.id !== reg.id);
      if (result.promotedId) {
        return remaining.map((r) =>
          r.id === result.promotedId ? { ...r, isDefault: true } : r,
        );
      }
      // If no promotedId, the first remaining registry becomes default (single-default rule).
      if (remaining.length === 1) {
        return remaining.map((r) => ({ ...r, isDefault: true }));
      }
      return remaining;
    });
  };

  // The single-default rule: when only one registry exists, it is implicitly
  // default and the remove button is hidden (no replacement to promote to).
  const isSingleRegistry = registries.length === 1;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            MCP Server Registries
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Registries are the catalog sources Oxagen discovers and installs MCP
            servers and plugins from.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RegistryHelpPopover docsBaseUrl={docsBaseUrl} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowForm((v) => !v)}
            data-testid="add-registry-btn"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Add registry
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/20 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="reg-name" className="text-xs">
                Registry name
              </Label>
              <Input
                id="reg-name"
                type="text"
                placeholder="My Registry"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
                data-testid="registry-name-input"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="reg-url" className="text-xs">
                Base URL
              </Label>
              <Input
                id="reg-url"
                type="url"
                placeholder="https://registry.modelcontextprotocol.io"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={pending}
                data-testid="registry-url-input"
              />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={pending}
              data-testid="registry-submit-btn"
            >
              {pending ? "Adding…" : "Add registry"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {registries.length === 0 ? (
        <EmptyState
          size="sm"
          variant="muted"
          title="No registries configured"
          description="Add a registry to enable marketplace plugin discovery."
        />
      ) : (
        <ul className="divide-y divide-border/30 overflow-hidden rounded-lg border border-border/40">
          {registries.map((reg) => (
            <li
              key={reg.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-6"
              data-testid={`registry-row-${reg.id}`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2 font-medium">
                <Globe
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="truncate">{reg.name}</span>
                {reg.isDefault && (
                  <Badge
                    variant="muted"
                    size="sm"
                    data-testid={`registry-default-badge-${reg.id}`}
                  >
                    Default
                  </Badge>
                )}
              </div>

              <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    URL
                  </dt>
                  <dd className="mt-0.5 max-w-[240px] truncate text-xs text-muted-foreground">
                    {reg.baseUrl}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Status
                  </dt>
                  <dd className="mt-0.5 text-sm">
                    <Badge
                      variant={reg.enabled ? "success" : "muted"}
                      size="sm"
                    >
                      {reg.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </dd>
                </div>
              </dl>

              <div className="flex shrink-0 items-center gap-1">
                {/* Hide remove for the last remaining registry (single-default rule) */}
                {!isSingleRegistry && (
                  <button
                    type="button"
                    onClick={() => handleRemove(reg)}
                    disabled={removingId === reg.id}
                    className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
                    aria-label={`Remove ${reg.name} registry`}
                    data-testid={`registry-remove-btn-${reg.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Error outside the form (from remove actions) */}
      {!showForm && error && (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
