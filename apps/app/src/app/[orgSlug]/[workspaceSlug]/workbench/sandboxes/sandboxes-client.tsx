"use client";

/**
 * sandboxes-client.tsx — the Workbench → Sandboxes list + "warm a sandbox" panel.
 *
 * Two truthfulness rules drive the list: (1) a sandbox's user-assigned name is
 * always its primary on-screen label — the sbx_ id is demoted to a small,
 * copyable secondary chip, never the headline (an unlabeled session reads as
 * "Untitled sandbox", never its id); (2) the default view shows ONLY sessions
 * the provider currently agrees are running/idle — a cleaned-out, stopped, or
 * reaped sandbox never lingers in the list looking alive. A "Show inactive"
 * toggle opts into the full history for debugging. A ~8s visibility-paused
 * poll (mirroring SandboxLogsConsole's live-tail pattern) keeps the list
 * truthful without a manual refresh, and every mutation (warm/rename/stop)
 * re-polls immediately afterward.
 *
 * Warming supports both the built-in presets and any saved sandbox template
 * (grouped separately in the picker), plus an optional set of GitHub repos to
 * clone into `/workspace/<repo>` — see sandbox-repo-picker.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Boxes, Pencil, Play, Square, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardPanel,
} from "@/components/ui/card";
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
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "@/components/ui/select";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { workspace } from "@/lib/routes";
import type { SandboxSummary, SandboxStatus } from "@/lib/workbench/sandboxes";
import type { RepoOption } from "@/components/chat/repo-selector";
import type { SandboxTemplateSummary } from "./sandbox-template-actions";
import {
  WARM_UP_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  templateById,
} from "@/components/sandbox/warm-up-templates";
import { SandboxTemplateCard } from "@/components/sandbox/sandbox-template-card";
import {
  SandboxRepoPicker,
  toSandboxRepoInputs,
  type SandboxRepoSelection,
} from "@/components/sandbox/sandbox-repo-picker";
import {
  startSandboxAction,
  stopSandboxAction,
  renameSandboxAction,
  refreshSandboxesAction,
} from "./actions";

const STATUS_TONE: Record<SandboxStatus, "success" | "warning" | "muted"> = {
  running: "success",
  idle: "warning",
  stopped: "muted",
  gone: "muted",
};

const POLL_MS = 8_000;
/** Sessions the provider currently agrees are live — everything else is "inactive". */
function isActiveStatus(status: SandboxStatus): boolean {
  return status === "running" || status === "idle";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

export interface SandboxesClientProps {
  orgSlug: string;
  workspaceSlug: string;
  initialSandboxes: SandboxSummary[];
  canManage: boolean;
  unavailable: boolean;
  /** Saved sandbox templates (Settings → Environments), selectable alongside the built-in presets. */
  templates: SandboxTemplateSummary[];
  /** The workspace's usable GitHub repos, for the warm flow's repo picker. */
  repoOptions: RepoOption[];
}

export function SandboxesClient({
  orgSlug,
  workspaceSlug,
  initialSandboxes,
  canManage,
  unavailable,
  templates,
  repoOptions,
}: SandboxesClientProps) {
  const router = useRouter();
  const scope = useMemo(
    () => ({ orgSlug, workspaceSlug }),
    [orgSlug, workspaceSlug],
  );

  // ── Warm-up form state ──────────────────────────────────────────────────────
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [name, setName] = useState("");
  const [repoRows, setRepoRows] = useState<SandboxRepoSelection[]>([]);
  const [warmError, setWarmError] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);

  const savedTemplates = useMemo(
    () => templates.filter((t) => t.isActive),
    [templates],
  );
  const isSavedTemplate = templateId.startsWith("sbx_");
  const presetTemplate = useMemo(
    () => (isSavedTemplate ? null : templateById(templateId)),
    [templateId, isSavedTemplate],
  );
  const selectedSavedTemplate = isSavedTemplate
    ? (savedTemplates.find((t) => t.id === templateId) ?? null)
    : null;

  const trimmedName = name.trim();
  const canWarm = canManage && !warming && trimmedName.length > 0;

  // ── Session list state — truthful (default active-only) + live-tail poll ────
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>(() =>
    initialSandboxes.filter((s) => isActiveStatus(s.status)),
  );
  const [showInactive, setShowInactive] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const refresh = useCallback(
    async (activeOnly: boolean) => {
      try {
        const res = await refreshSandboxesAction({ ...scope, activeOnly });
        if (res.ok) {
          setSandboxes(res.sandboxes);
          setListError(null);
        } else {
          setListError(res.error);
        }
      } catch (err) {
        // A transient poll failure should never crash the surface — the list
        // just stays at its last-known-good state until the next success.
        console.error("sandboxes: refresh failed", err);
      }
    },
    [scope],
  );

  useEffect(() => {
    void refresh(!showInactive);
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh(!showInactive);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, showInactive]);

  // ── Rename dialog ────────────────────────────────────────────────────────────
  const [renameTarget, setRenameTarget] = useState<SandboxSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);

  const openRename = (s: SandboxSummary) => {
    setRenameTarget(s);
    setRenameValue(s.label ?? "");
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const label = renameValue.trim();
    if (!label) {
      setRenameError("Name your sandbox.");
      return;
    }
    setRenamePending(true);
    const res = await renameSandboxAction({
      ...scope,
      sessionId: renameTarget.sessionId,
      label,
    });
    setRenamePending(false);
    if (res.ok) {
      setRenameTarget(null);
      await refresh(!showInactive);
    } else {
      setRenameError(res.error);
    }
  };

  const onStop = async (sessionId: string) => {
    setStoppingId(sessionId);
    const res = await stopSandboxAction({ ...scope, sessionId });
    setStoppingId(null);
    if (res.ok) {
      await refresh(!showInactive);
    } else {
      setListError(res.error);
    }
  };

  const onWarm = async () => {
    setWarmError(null);
    setWarming(true);
    const res = await startSandboxAction({
      ...scope,
      name: trimmedName,
      templateId,
      repos: toSandboxRepoInputs(repoRows, repoOptions),
    });
    setWarming(false);
    if (res.ok) {
      router.push(
        workspace.workbench.sandbox(
          { orgSlug, workspaceSlug },
          res.sandbox.sessionId,
        ),
      );
      return;
    }
    setWarmError(res.error);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Warm-up panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="h-4 w-4" aria-hidden />
            Warm a sandbox
          </CardTitle>
          <CardDescription>
            Name it, pick a template, optionally pre-clone repos, and provision
            a durable sandbox — its one-time setup runs at create time so an
            agent wakes up to a ready workspace.
          </CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">
          {unavailable ? (
            <div
              role="status"
              className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
            >
              Durable sandboxes aren&apos;t configured for this environment
              (SANDBOX_ENABLED + a Modal driver are required). You can still
              browse recorded sessions below; warming a new one will fail until
              it&apos;s enabled.
            </div>
          ) : null}

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="sandbox-name">Name</Label>
              <Input
                id="sandbox-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. acme-api refactor"
                maxLength={80}
                autoComplete="off"
                aria-describedby="sandbox-name-hint"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sandbox-template">Template</Label>
              <Select
                value={templateId}
                onValueChange={(v) => setTemplateId(v ?? DEFAULT_TEMPLATE_ID)}
              >
                <SelectTrigger
                  id="sandbox-template"
                  className="w-full sm:w-64"
                  aria-label="Sandbox template"
                >
                  <SelectValue placeholder="Choose a template">
                    {(value: string | null) => {
                      if (!value) return "Choose a template";
                      if (value.startsWith("sbx_")) {
                        return (
                          savedTemplates.find((t) => t.id === value)?.name ??
                          value
                        );
                      }
                      return templateById(value).label;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {savedTemplates.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>Saved templates</SelectLabel>
                      {savedTemplates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                  <SelectGroup>
                    <SelectLabel>Presets</SelectLabel>
                    {WARM_UP_TEMPLATES.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => void onWarm()}
              disabled={!canWarm}
              className="shrink-0"
            >
              {warming ? "Warming…" : "Warm sandbox"}
            </Button>
          </div>
          <p id="sandbox-name-hint" className="text-xs text-muted-foreground">
            A name so you can tell your sandboxes apart later — it doesn&apos;t
            need to be unique.
          </p>

          {presetTemplate ? (
            <SandboxTemplateCard template={presetTemplate} />
          ) : selectedSavedTemplate ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-4">
              <span className="text-sm font-semibold text-foreground">
                {selectedSavedTemplate.name}
              </span>
              {selectedSavedTemplate.description ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {selectedSavedTemplate.description}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>provider: {selectedSavedTemplate.provider}</span>
                {selectedSavedTemplate.runtime ? (
                  <span>runtime: {selectedSavedTemplate.runtime}</span>
                ) : null}
                <span>network: {selectedSavedTemplate.network.mode}</span>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label>Repos to clone</Label>
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
        </CardPanel>
      </Card>

      {/* Session list */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Sessions</h2>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={showInactive}
              onCheckedChange={(c) => setShowInactive(c === true)}
              aria-label="Show inactive sandboxes"
            />
            Show inactive
          </label>
        </div>
        {listError ? (
          <p role="alert" className="text-sm text-error">
            {listError}
          </p>
        ) : null}
        {sandboxes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <Boxes className="h-6 w-6 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {showInactive
                ? "No sandbox sessions yet. Warm one above to give an agent a ready workspace."
                : 'No active sandbox sessions. Warm one above, or toggle "Show inactive" to see stopped sessions.'}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {sandboxes.map((s) => {
              const active = isActiveStatus(s.status);
              return (
                <li
                  key={s.sessionId}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-background p-4 transition-colors hover:border-ring"
                  data-status={s.status}
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={workspace.workbench.sandbox(scope, s.sessionId)}
                      className="flex min-w-0 flex-1 flex-col gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        className={
                          "flex items-center gap-2 text-sm font-medium " +
                          (active ? "" : "text-muted-foreground")
                        }
                      >
                        <Terminal
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        {s.label ? (
                          <span className="truncate">{s.label}</span>
                        ) : (
                          <span className="italic text-muted-foreground">
                            Untitled sandbox
                          </span>
                        )}
                      </span>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <CopyableId value={s.sessionId} label="id" max={18} />
                        <span>image: {s.image}</span>
                        <span>driver: {s.driver}</span>
                        <span>last used: {relativeTime(s.lastUsedAt)}</span>
                      </div>
                      {s.repos && s.repos.length > 0 ? (
                        <ul className="flex flex-wrap gap-1.5">
                          {s.repos.map((r) => (
                            <li key={`${r.owner}/${r.repo}`}>
                              <Badge
                                variant="muted"
                                size="sm"
                                className="font-mono font-normal"
                              >
                                {r.owner}/{r.repo}
                                {r.branch ? `@${r.branch}` : ""}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </Link>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-1.5">
                        {s.recoveryStatus === "failed" ? (
                          <Badge variant="error">recovery failed</Badge>
                        ) : null}
                        <Badge variant={STATUS_TONE[s.status]}>
                          {s.status}
                        </Badge>
                      </div>
                      {canManage ? (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Rename sandbox"
                            onClick={() => openRename(s)}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                          </Button>
                          {active ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Stop sandbox"
                              onClick={() => void onStop(s.sessionId)}
                              disabled={stoppingId === s.sessionId}
                            >
                              <Square className="size-3.5" aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Rename sandbox</DialogTitle>
            <DialogDescription>
              This is the name shown in the list — it doesn&apos;t need to be
              unique.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label htmlFor="sandbox-rename-input">Name</Label>
            <Input
              id="sandbox-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={80}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
              }}
            />
            {renameError ? (
              <p role="alert" className="text-sm text-error">
                {renameError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRenameTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void submitRename()}
              disabled={renamePending || renameValue.trim().length === 0}
            >
              {renamePending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export default SandboxesClient;
