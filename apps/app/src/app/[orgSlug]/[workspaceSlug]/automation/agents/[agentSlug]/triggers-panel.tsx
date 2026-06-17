"use client";
/**
 * triggers-panel.tsx — add / edit / delete triggers for an agent.
 *
 * Lists existing triggers and exposes an inline editor (a draft row) for
 * creating a new trigger or editing an existing one. Manual/schedule/event
 * types are supported; the event form expresses the GitHub "fire on repo
 * source change" example (source=github_repo, eventType=push, branches,
 * pathGlobs). Validates against the shared agentTriggerSchema before submit.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { agentTriggerSchema, type AgentTrigger } from "@oxagen/oxagen/agent-schema";
import { TRIGGER_TYPE_LABEL, summarizeTrigger } from "../agent-ui";
import type { AgentTriggerListOutput } from "../agent-actions";
import {
  createTriggerAction,
  updateTriggerAction,
  deleteTriggerAction,
} from "../agent-actions";

type TriggerRow = AgentTriggerListOutput["triggers"][number];

export interface TriggersPanelProps {
  agentId: string;
  triggers: TriggerRow[];
  canEdit: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

interface TriggerDraft {
  type: AgentTrigger["type"];
  eventSource: string;
  eventType: string;
  schedule: string;
  branches: string;
  pathGlobs: string;
  enabled: boolean;
}

const EMPTY_DRAFT: TriggerDraft = {
  type: "manual",
  eventSource: "",
  eventType: "",
  schedule: "",
  branches: "",
  pathGlobs: "",
  enabled: false,
};

const TRIGGER_TYPES: AgentTrigger["type"][] = ["manual", "schedule", "event"];

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function rowToDraft(row: TriggerRow): TriggerDraft {
  const filter = row.filter as { branches?: string[]; pathGlobs?: string[] } | undefined;
  return {
    type: row.triggerType,
    eventSource: row.eventSource ?? "",
    eventType: row.eventType ?? "",
    schedule: row.schedule ?? "",
    branches: (filter?.branches ?? []).join(", "),
    pathGlobs: (filter?.pathGlobs ?? []).join(", "),
    enabled: row.enabled,
  };
}

function draftToTrigger(draft: TriggerDraft): AgentTrigger {
  const trigger: AgentTrigger = { type: draft.type, enabled: draft.enabled };
  if (draft.type === "schedule") {
    trigger.schedule = draft.schedule.trim();
  }
  if (draft.type === "event") {
    trigger.eventSource = draft.eventSource.trim();
    trigger.eventType = draft.eventType.trim();
    const branches = splitList(draft.branches);
    const pathGlobs = splitList(draft.pathGlobs);
    if (branches.length || pathGlobs.length) {
      trigger.filter = {
        ...(branches.length ? { branches } : {}),
        ...(pathGlobs.length ? { pathGlobs } : {}),
      };
    }
  }
  return trigger;
}

function TriggerEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
}: {
  draft: TriggerDraft;
  setDraft: (patch: Partial<TriggerDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-3 py-3">
      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="trigger-editor-type" className="text-xs text-muted-foreground">
            Type
          </Label>
          <select
            id="trigger-editor-type"
            value={draft.type}
            onChange={(e) => setDraft({ type: e.target.value as AgentTrigger["type"] })}
            disabled={saving}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
          >
            {TRIGGER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={draft.enabled}
            onCheckedChange={(checked) => setDraft({ enabled: checked })}
            disabled={saving}
            aria-label="Trigger enabled"
          />
          Enabled
        </label>
      </div>

      {draft.type === "schedule" && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="trigger-editor-schedule" className="text-xs text-muted-foreground">
            Cron schedule
          </Label>
          <Input
            id="trigger-editor-schedule"
            value={draft.schedule}
            onChange={(e) => setDraft({ schedule: e.target.value })}
            disabled={saving}
            placeholder="0 9 * * 1"
          />
        </div>
      )}

      {draft.type === "event" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="trigger-editor-source" className="text-xs text-muted-foreground">
              Event source
            </Label>
            <Input
              id="trigger-editor-source"
              value={draft.eventSource}
              onChange={(e) => setDraft({ eventSource: e.target.value })}
              disabled={saving}
              placeholder="github_repo"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="trigger-editor-event" className="text-xs text-muted-foreground">
              Event type
            </Label>
            <Input
              id="trigger-editor-event"
              value={draft.eventType}
              onChange={(e) => setDraft({ eventType: e.target.value })}
              disabled={saving}
              placeholder="push"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="trigger-editor-branches" className="text-xs text-muted-foreground">
              Branches (comma-separated)
            </Label>
            <Input
              id="trigger-editor-branches"
              value={draft.branches}
              onChange={(e) => setDraft({ branches: e.target.value })}
              disabled={saving}
              placeholder="main, release/*"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="trigger-editor-paths" className="text-xs text-muted-foreground">
              Path globs (comma-separated)
            </Label>
            <Input
              id="trigger-editor-paths"
              value={draft.pathGlobs}
              onChange={(e) => setDraft({ pathGlobs: e.target.value })}
              disabled={saving}
              placeholder="src/**, docs/**"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="gradient"
          size="sm"
          onClick={onSave}
          disabled={saving}
          startIcon={<Check className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {saving ? "Saving…" : "Save trigger"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
          startIcon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function TriggersPanel({
  agentId,
  triggers,
  canEdit,
  orgSlug,
  workspaceSlug,
}: TriggersPanelProps) {
  const router = useRouter();
  const { add: addToast } = useToast();

  // editing === "new" → adding; a triggerId → editing that row; null → idle.
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<TriggerDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = React.useState(false);

  function patchDraft(patch: Partial<TriggerDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function startAdd() {
    setDraft(EMPTY_DRAFT);
    setEditing("new");
  }

  function startEdit(row: TriggerRow) {
    setDraft(rowToDraft(row));
    setEditing(row.triggerId);
  }

  function cancel() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  }

  async function save() {
    const trigger = draftToTrigger(draft);
    const validation = agentTriggerSchema.safeParse(trigger);
    if (!validation.success) {
      addToast({
        title: "Invalid trigger",
        description: validation.error.issues[0]?.message ?? "Check the trigger fields.",
        type: "background",
      });
      return;
    }

    setSaving(true);
    try {
      const result =
        editing === "new"
          ? await createTriggerAction({ orgSlug, workspaceSlug, agentId, trigger: validation.data })
          : await updateTriggerAction({
              orgSlug,
              workspaceSlug,
              triggerId: editing as string,
              trigger: validation.data,
            });

      if (result.ok) {
        addToast({
          title: editing === "new" ? "Trigger added" : "Trigger updated",
          type: "background",
        });
        cancel();
        router.refresh();
      } else {
        addToast({ title: "Failed to save trigger", description: result.error, type: "background" });
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(triggerId: string) {
    setSaving(true);
    try {
      const result = await deleteTriggerAction({ orgSlug, workspaceSlug, triggerId });
      if (result.ok) {
        addToast({ title: "Trigger deleted", type: "background" });
        if (editing === triggerId) cancel();
        router.refresh();
      } else {
        addToast({ title: "Failed to delete trigger", description: result.error, type: "background" });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="agent-triggers-panel-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p
          id="agent-triggers-panel-heading"
          className="text-sm font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Triggers
        </p>
        {canEdit && editing !== "new" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={startAdd}
            disabled={saving}
            startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Add trigger
          </Button>
        )}
      </div>

      {triggers.length === 0 && editing !== "new" ? (
        <p className="text-xs text-muted-foreground">
          No triggers. Add a manual, schedule, or event trigger (e.g. fire on a GitHub repo source
          change).
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {triggers.map((row) =>
            editing === row.triggerId ? (
              <li key={row.triggerId}>
                <TriggerEditor
                  draft={draft}
                  setDraft={patchDraft}
                  onSave={save}
                  onCancel={cancel}
                  saving={saving}
                />
              </li>
            ) : (
              <li
                key={row.triggerId}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card px-4 py-3"
              >
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" size="sm">
                      {TRIGGER_TYPE_LABEL[row.triggerType] ?? row.triggerType}
                    </Badge>
                    {row.enabled ? (
                      <Badge variant="success" size="sm">
                        Enabled
                      </Badge>
                    ) : (
                      <Badge variant="outline" size="sm">
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    {summarizeTrigger(row)}
                  </span>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => startEdit(row)}
                      disabled={saving}
                      aria-label={`Edit trigger ${row.publicId}`}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="destructive-outline"
                      size="icon-sm"
                      onClick={() => remove(row.triggerId)}
                      disabled={saving}
                      aria-label={`Delete trigger ${row.publicId}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {editing === "new" && (
        <TriggerEditor
          draft={draft}
          setDraft={patchDraft}
          onSave={save}
          onCancel={cancel}
          saving={saving}
        />
      )}
    </section>
  );
}
