"use client";
/**
 * skill-detail-panel.tsx — Skill detail: version history, edit, activate, download.
 *
 * Editing never mutates a version: "Save New Version" creates an immutable
 * draft (activate=false), then a confirmation dialog asks whether to pin it
 * as the workspace default — mirroring the agent draft→publish model. The
 * pinned (active) version is what every surface resolves when the skill is
 * referenced without an explicit version.
 *
 * Uses render-prop / explicit import pattern (no "use client" from server component).
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { formatDate } from "@/lib/utils";
import { CheckCircle, Download, History, Pencil } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillVersion {
  id: string;
  versionNumber: number;
  version: string;
  commitMessage: string | null;
  createdAt: string;
  createdByEmail: string | null;
  isActive: boolean;
}

export interface SkillDetailData {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: string;
  installedFromSlug: string | null;
  activeVersion: string | null;
  /** False when no version is pinned and the shown content is merely latest. */
  activeVersionIsPinned: boolean;
  content: string | null;
  updatedAt: string | null;
}

interface SkillDetailPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  skill: SkillDetailData;
  versions: SkillVersion[];
  canManage: boolean;
  editAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    skillSlug: string;
    content: string;
    commitMessage?: string;
  }) => Promise<{
    ok: boolean;
    versionId?: string;
    version?: string;
    versionNumber?: number;
    error?: string;
  }>;
  activateAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    skillSlug: string;
    versionNumber: number;
  }) => Promise<{ ok: boolean; error?: string }>;
  exportAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    skillSlug: string;
    versionNumber?: number;
  }) => Promise<{
    ok: boolean;
    content?: string;
    filename?: string;
    error?: string;
  }>;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SkillDetailPanel({
  orgSlug,
  workspaceSlug,
  skill,
  versions,
  canManage,
  editAction,
  activateAction,
  exportAction,
}: SkillDetailPanelProps) {
  const toast = useToast();

  // Edit state
  const [editing, setEditing] = React.useState(false);
  const [editContent, setEditContent] = React.useState(skill.content ?? "");
  const [commitMessage, setCommitMessage] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Pin-confirmation state: version number just saved as a draft, awaiting the
  // user's decision on whether it becomes the workspace default.
  const [pendingPin, setPendingPin] = React.useState<number | null>(null);
  const [pinning, setPinning] = React.useState(false);

  // Activate state (history rows)
  const [activating, setActivating] = React.useState<number | null>(null);

  // Download state
  const [downloading, setDownloading] = React.useState(false);

  const isBuiltin =
    skill.source === "builtin" || skill.installedFromSlug != null;

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!editContent.trim()) return;
    setSaving(true);
    try {
      const result = await editAction({
        orgSlug,
        workspaceSlug,
        skillSlug: skill.slug,
        content: editContent,
        commitMessage: commitMessage || undefined,
      });
      if (result.ok) {
        toast.add({
          title: "New version saved",
          description: `Version ${result.version ?? ""} created (not yet pinned)`,
        });
        setEditing(false);
        setCommitMessage("");
        if (result.versionNumber != null) setPendingPin(result.versionNumber);
      } else {
        toast.add({
          title: "Save failed",
          description: result.error,
          type: "error",
        });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(versionNumber: number) {
    setActivating(versionNumber);
    try {
      const result = await activateAction({
        orgSlug,
        workspaceSlug,
        skillSlug: skill.slug,
        versionNumber,
      });
      if (result.ok) {
        toast.add({ title: `v${versionNumber} is now the workspace default` });
      } else {
        toast.add({
          title: "Activation failed",
          description: result.error,
          type: "error",
        });
      }
      return result.ok;
    } finally {
      setActivating(null);
    }
  }

  async function handleConfirmPin() {
    if (pendingPin == null) return;
    setPinning(true);
    try {
      const ok = await handleActivate(pendingPin);
      if (ok) setPendingPin(null);
    } finally {
      setPinning(false);
    }
  }

  async function handleDownload(versionNumber?: number) {
    setDownloading(true);
    try {
      const result = await exportAction({
        orgSlug,
        workspaceSlug,
        skillSlug: skill.slug,
        versionNumber,
      });
      if (result.ok && result.content) {
        const blob = new Blob([result.content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename ?? `${skill.slug}.md`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.add({
          title: "Export failed",
          description: result.error,
          type: "error",
        });
      }
    } finally {
      setDownloading(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-8">
      {/* ── Skill meta ─────────────────────────────────────────────────── */}
      <div className="rounded-md border bg-card p-5 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{skill.name}</h3>
              <Badge
                variant={isBuiltin ? "secondary" : "default"}
                className="text-xs"
              >
                {isBuiltin ? "Built-in" : "Custom"}
              </Badge>
              {skill.activeVersion && (
                <Badge
                  variant="outline"
                  className="text-xs"
                  data-testid="skill-active-version-badge"
                >
                  {skill.activeVersion}
                  {skill.activeVersionIsPinned ? "" : " (latest, unpinned)"}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{skill.description}</p>
            <p className="text-xs font-mono text-muted-foreground">
              {skill.slug}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDownload()}
              disabled={downloading}
              data-testid="skill-download-btn"
              aria-label="Download active version"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Download
            </Button>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing((v) => !v)}
                data-testid="skill-edit-btn"
                aria-label="Edit skill content"
              >
                <Pencil className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                {editing ? "Cancel" : "Edit"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Editor ─────────────────────────────────────────────────────── */}
      {editing && canManage && (
        <div
          className="flex flex-col gap-3 rounded-md border bg-card p-5"
          data-testid="skill-editor"
        >
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Pencil
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            Edit Skill — creates a new version
          </h4>
          <Textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={20}
            className="font-mono text-sm resize-y"
            aria-label="Skill content"
            data-testid="skill-content-textarea"
            placeholder="# Skill content (Markdown / MDX)..."
          />
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message (optional)"
              className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Commit message"
              data-testid="skill-commit-message-input"
            />
            <Button
              onClick={handleSave}
              disabled={saving || !editContent.trim()}
              size="sm"
              data-testid="skill-save-btn"
            >
              {saving ? "Saving…" : "Save New Version"}
            </Button>
          </div>
        </div>
      )}

      {/* ── Pin confirmation ────────────────────────────────────────────── */}
      <Dialog
        open={pendingPin != null}
        onOpenChange={(next) => {
          if (!next) setPendingPin(null);
        }}
      >
        <DialogPopup className="max-w-md" data-testid="skill-pin-dialog">
          <DialogHeader>
            <DialogTitle>Pin v{pendingPin} as the default version?</DialogTitle>
            <DialogDescription>
              The pinned version is what agents load whenever{" "}
              <span className="font-mono">{skill.slug}</span> is referenced —
              across the web app, CLI, API, and MCP. Until you pin it, v
              {pendingPin} is saved in the version history but{" "}
              {skill.activeVersion ?? "the current version"} stays active.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingPin(null)}
              disabled={pinning}
              data-testid="skill-pin-dismiss-btn"
            >
              Not now
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmPin}
              disabled={pinning}
              data-testid="skill-pin-confirm-btn"
            >
              {pinning ? "Pinning…" : "Pin as default"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* ── Version history ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <History
            className="h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          Version History
        </h4>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions found.</p>
        ) : (
          <ul
            className="divide-y overflow-hidden rounded-md border"
            data-testid="skill-versions-table"
          >
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex flex-col gap-3 px-4 py-3 hover:bg-muted/20 sm:flex-row sm:items-center sm:gap-6"
                data-testid={`skill-version-row-${v.id}`}
              >
                {/* identity: version + commit message */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    {v.version}
                    {v.isActive && (
                      <Badge variant="default" className="text-xs px-1.5 py-0">
                        active
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 max-w-[240px] truncate text-xs text-muted-foreground">
                    {v.commitMessage ?? "—"}
                  </p>
                </div>
                <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Created
                    </dt>
                    <dd className="mt-0.5 whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(v.createdAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Author
                    </dt>
                    <dd className="mt-0.5 text-xs text-muted-foreground">
                      {v.createdByEmail ?? "—"}
                    </dd>
                  </div>
                </dl>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleDownload(v.versionNumber)}
                    aria-label={`Download version ${v.version}`}
                    data-testid={`skill-version-download-${v.id}`}
                  >
                    <Download className="h-3 w-3 mr-1" aria-hidden="true" />
                    Download
                  </Button>
                  {canManage && !v.isActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleActivate(v.versionNumber)}
                      disabled={activating === v.versionNumber}
                      aria-label={`Activate version ${v.version}`}
                      data-testid={`skill-version-activate-${v.id}`}
                    >
                      <CheckCircle
                        className="h-3 w-3 mr-1"
                        aria-hidden="true"
                      />
                      {activating === v.versionNumber
                        ? "Activating…"
                        : "Activate"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
