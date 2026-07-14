"use client";

/**
 * sandbox-create-dialog.tsx — the focused "new sandbox" flow, lifted out of the
 * list page so the list itself stays calm (a single primary action, not an
 * always-open form).
 *
 * The setup experience is the point: pick a RUNTIME from clear cards (each shows
 * the language + baked version), name it, optionally list the npm/pip PACKAGES
 * to pre-install, and optionally pre-clone repos. Packages compose into the
 * preset's one-time setup command server-side (see `startSandboxAction`
 * `setupPackages`), so a freshly warmed sandbox already has its deps. Saved
 * templates own their own setup, so the package field hides when one is chosen.
 */

import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Bot,
  Braces,
  Hexagon,
  Package,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { workspace } from "@/lib/routes";
import type { RepoOption } from "@/components/chat/repo-selector";
import {
  WARM_UP_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  templateById,
  type WarmUpTemplate,
} from "@/components/sandbox/warm-up-templates";
import {
  isValidPackageToken,
  managersForImage,
  parsePackageTokens,
  type PackageManagerId,
} from "@/components/sandbox/sandbox-runtimes";
import {
  SandboxRepoPicker,
  toSandboxRepoInputs,
  type SandboxRepoSelection,
} from "@/components/sandbox/sandbox-repo-picker";
import type { SandboxTemplateSummary } from "./sandbox-template-actions";
import { startSandboxAction } from "./actions";

/** warm-up-templates keeps its icon as a string; map it to a component here. */
const RUNTIME_ICONS: Record<string, LucideIcon> = {
  Bot,
  Hexagon,
  Braces,
  SquareTerminal,
};

export interface SandboxCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
  unavailable: boolean;
  templates: SandboxTemplateSummary[];
  repoOptions: RepoOption[];
  /** Called after a successful warm with the new session id (parent navigates). */
  onWarmed: (sessionId: string) => void;
}

function RuntimeCard({
  template,
  selected,
  onSelect,
  disabled,
}: {
  template: WarmUpTemplate;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const Icon = RUNTIME_ICONS[template.icon] ?? SquareTerminal;
  const runtime =
    template.contents.languages
      .map((l) => `${l.name} ${l.version}`)
      .join(" · ") || "System base";
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      data-testid={`sandbox-runtime-${template.id}`}
      className={cn(
        "flex min-h-[4.5rem] flex-col gap-1 rounded-xl border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:border-ring",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {template.label}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">
        {runtime}
      </span>
    </button>
  );
}

export function SandboxCreateDialog({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  canManage,
  unavailable,
  templates,
  repoOptions,
  onWarmed,
}: SandboxCreateDialogProps) {
  const scope = useMemo(
    () => ({ orgSlug, workspaceSlug }),
    [orgSlug, workspaceSlug],
  );

  const savedTemplates = useMemo(
    () => templates.filter((t) => t.isActive),
    [templates],
  );

  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [name, setName] = useState("");
  const [repoRows, setRepoRows] = useState<SandboxRepoSelection[]>([]);
  const [pkgs, setPkgs] = useState<string[]>([]);
  const [pkgDraft, setPkgDraft] = useState("");
  const [pkgError, setPkgError] = useState<string | null>(null);
  const [warmError, setWarmError] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);

  const isSavedTemplate = templateId.startsWith("sbx_");
  const presetTemplate = isSavedTemplate ? null : templateById(templateId);

  // The runtime's primary package manager drives the warm-time package field —
  // shown only for npm/pip runtimes (node/python/agent), hidden for a saved
  // template (it owns its setup) or a bare shell base.
  const primaryManager = presetTemplate
    ? managersForImage(presetTemplate.image)[0]
    : undefined;
  const packageManagerId: PackageManagerId | undefined =
    primaryManager &&
    (primaryManager.id === "npm" || primaryManager.id === "pip")
      ? primaryManager.id
      : undefined;

  const trimmedName = name.trim();
  const canWarm = canManage && !warming && trimmedName.length > 0;

  const addPkgTokens = (raw: string) => {
    const tokens = parsePackageTokens(raw);
    if (tokens.length === 0) return;
    const invalid = tokens.filter((t) => !isValidPackageToken(t));
    if (invalid.length > 0) {
      setPkgError(`Not a valid package name: ${invalid.join(", ")}`);
      return;
    }
    setPkgError(null);
    setPkgs((prev) => [...new Set([...prev, ...tokens])]);
    setPkgDraft("");
  };

  const onPkgKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      if (pkgDraft.trim().length > 0) {
        e.preventDefault();
        addPkgTokens(pkgDraft);
      }
      return;
    }
    if (e.key === "Backspace" && pkgDraft.length === 0 && pkgs.length > 0) {
      e.preventDefault();
      setPkgs((prev) => prev.slice(0, -1));
    }
  };

  const onWarm = async () => {
    setWarmError(null);
    // Fold any un-committed draft into the package list.
    const pending = parsePackageTokens(pkgDraft);
    const allPkgs = [...new Set([...pkgs, ...pending])];
    if (allPkgs.some((t) => !isValidPackageToken(t))) {
      setPkgError("Remove invalid package names first.");
      return;
    }
    const setupPackages =
      packageManagerId && allPkgs.length > 0
        ? [{ manager: packageManagerId, names: allPkgs }]
        : undefined;

    setWarming(true);
    const res = await startSandboxAction({
      ...scope,
      name: trimmedName,
      templateId,
      repos: toSandboxRepoInputs(repoRows, repoOptions),
      ...(setupPackages ? { setupPackages } : {}),
    });
    setWarming(false);
    if (res.ok) {
      onWarmed(res.sandbox.sessionId);
      return;
    }
    setWarmError(res.error);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New sandbox</DialogTitle>
          <DialogDescription>
            Pick a runtime, name it, and optionally pre-install packages or
            clone repos — its one-time setup runs at create time.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="gap-5">
          {unavailable ? (
            <div
              role="status"
              className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
            >
              Durable sandboxes aren&apos;t configured for this environment —
              warming will fail until SANDBOX_ENABLED + a Modal driver are set.
            </div>
          ) : null}

          {/* Runtime */}
          <div className="flex flex-col gap-2">
            <Label>Runtime</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {WARM_UP_TEMPLATES.map((t) => (
                <RuntimeCard
                  key={t.id}
                  template={t}
                  selected={templateId === t.id}
                  onSelect={() => setTemplateId(t.id)}
                  disabled={warming}
                />
              ))}
            </div>
            {savedTemplates.length > 0 ? (
              <div className="flex flex-col gap-1.5 pt-1">
                <Label
                  htmlFor="sandbox-saved-template"
                  className="text-xs text-muted-foreground"
                >
                  Or use a saved template
                </Label>
                <Select
                  value={isSavedTemplate ? templateId : ""}
                  onValueChange={(v) =>
                    setTemplateId(v && v.length > 0 ? v : DEFAULT_TEMPLATE_ID)
                  }
                >
                  <SelectTrigger
                    id="sandbox-saved-template"
                    className="w-full"
                    aria-label="Saved template"
                  >
                    <SelectValue placeholder="None — use a runtime above">
                      {(value: string | null) =>
                        value
                          ? (savedTemplates.find((t) => t.id === value)?.name ??
                            value)
                          : "None — use a runtime above"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {savedTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>

          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sandbox-name">Name</Label>
            <Input
              id="sandbox-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. acme-api refactor"
              maxLength={80}
              autoComplete="off"
              disabled={warming}
            />
          </div>

          {/* Packages (preset npm/pip runtimes only) */}
          {packageManagerId ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sandbox-packages">
                <span className="flex items-center gap-1.5">
                  <Package
                    className="h-3.5 w-3.5 text-muted-foreground"
                    aria-hidden
                  />
                  {packageManagerId} packages
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </span>
              </Label>
              <div
                className={cn(
                  "flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring",
                  warming && "opacity-60",
                )}
              >
                {pkgs.map((pkg) => (
                  <span
                    key={pkg}
                    data-testid="sandbox-create-pkg-chip"
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                  >
                    {pkg}
                    <button
                      type="button"
                      aria-label={`Remove ${pkg}`}
                      className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() =>
                        setPkgs((prev) => prev.filter((p) => p !== pkg))
                      }
                      disabled={warming}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                ))}
                <input
                  id="sandbox-packages"
                  data-testid="sandbox-create-pkg-input"
                  value={pkgDraft}
                  onChange={(e) => setPkgDraft(e.target.value)}
                  onKeyDown={onPkgKeyDown}
                  onBlur={() =>
                    pkgDraft.trim().length > 0 && addPkgTokens(pkgDraft)
                  }
                  disabled={warming}
                  placeholder={
                    pkgs.length === 0
                      ? packageManagerId === "npm"
                        ? "express  zod  @tanstack/react-query"
                        : "requests  pydantic  fastapi"
                      : "add another…"
                  }
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Installed once at create time with {packageManagerId}, in /work.
                Press Enter or comma to add each package.
              </p>
              {pkgError ? (
                <p role="alert" className="text-xs text-error">
                  {pkgError}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Repos */}
          <div className="flex flex-col gap-1.5">
            <Label>Repos to clone (optional)</Label>
            <SandboxRepoPicker
              repositories={repoOptions}
              rows={repoRows}
              onRowsChange={setRepoRows}
              connectIntegrationsHref={workspace.marketplace.integrations(
                scope,
              )}
              disabled={warming}
            />
          </div>

          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              Only workspace owners and admins can warm sandboxes.
            </p>
          ) : null}
          {warmError ? (
            <p role="alert" className="text-sm text-error">
              {warmError}
            </p>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={warming}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onWarm()}
            disabled={!canWarm}
            data-testid="sandbox-warm-submit"
          >
            {warming ? "Warming…" : "Warm sandbox"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export default SandboxCreateDialog;
