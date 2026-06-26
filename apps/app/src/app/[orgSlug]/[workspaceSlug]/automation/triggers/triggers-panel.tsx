"use client";

import { useState, useTransition } from "react";
import {
  Zap,
  Plus,
  Calendar,
  Play,
  Radio,
  Trash2,
  Power,
  PowerOff,
} from "lucide-react";
import {
  createTriggerAction,
  updateTriggerAction,
  deleteTriggerAction,
} from "@/lib/actions/triggers";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TriggerRow {
  triggerId: string;
  publicId: string;
  triggerType: "manual" | "schedule" | "event";
  eventSource: string | null;
  eventType: string | null;
  connectionId: string | null;
  filter: Record<string, unknown>;
  schedule: string | null;
  enabled: boolean;
}

interface TriggersPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  agentId: string;
  agentName: string;
  triggers: TriggerRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const KIND_CONFIG: Record<
  string,
  { icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; label: string }
> = {
  schedule: { icon: Calendar, label: "Schedule" },
  event: { icon: Radio, label: "Event" },
  manual: { icon: Play, label: "Manual" },
};

// ── Create dialog ─────────────────────────────────────────────────────────────

function CreateTriggerForm({
  orgSlug,
  workspaceSlug,
  agentId,
  onDone,
}: {
  orgSlug: string;
  workspaceSlug: string;
  agentId: string;
  onDone: () => void;
}) {
  const [type, setType] = useState<"manual" | "schedule" | "event">("manual");
  const [schedule, setSchedule] = useState("");
  const [eventSource, setEventSource] = useState("");
  const [eventType, setEventType] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      await createTriggerAction({
        orgSlug,
        workspaceSlug,
        agentId,
        trigger: {
          type,
          ...(type === "schedule" ? { schedule } : {}),
          ...(type === "event" ? { eventSource, eventType } : {}),
          enabled: true,
        },
      });
      onDone();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-4 py-4"
    >
      <p className="text-sm font-semibold text-foreground">New trigger</p>
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-muted-foreground">
          Type
        </label>
        <div className="flex gap-2">
          {(["manual", "schedule", "event"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                type === t
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {type === "schedule" && (
        <div className="flex flex-col gap-1">
          <label
            htmlFor="cron"
            className="text-xs font-medium text-muted-foreground"
          >
            Cron expression
          </label>
          <input
            id="cron"
            type="text"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="0 9 * * MON"
            className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={isPending}
          />
        </div>
      )}

      {type === "event" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="event-source"
              className="text-xs font-medium text-muted-foreground"
            >
              Event source
            </label>
            <input
              id="event-source"
              type="text"
              value={eventSource}
              onChange={(e) => setEventSource(e.target.value)}
              placeholder="github_repo"
              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={isPending}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="event-type"
              className="text-xs font-medium text-muted-foreground"
            >
              Event type
            </label>
            <input
              id="event-type"
              type="text"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="push"
              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={isPending}
            />
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Creating…" : "Create trigger"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Trigger row ───────────────────────────────────────────────────────────────

function TriggerCard({
  trigger,
  orgSlug,
  workspaceSlug,
}: {
  trigger: TriggerRow;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const kind = KIND_CONFIG[trigger.triggerType] ?? {
    icon: Play,
    label: "Manual",
  };
  const KindIcon = kind.icon;

  function handleToggle() {
    startTransition(async () => {
      await updateTriggerAction({
        orgSlug,
        workspaceSlug,
        triggerId: trigger.triggerId,
        trigger: {
          type: trigger.triggerType,
          ...(trigger.schedule ? { schedule: trigger.schedule } : {}),
          ...(trigger.eventSource ? { eventSource: trigger.eventSource } : {}),
          ...(trigger.eventType ? { eventType: trigger.eventType } : {}),
          enabled: !trigger.enabled,
        },
      });
    });
  }

  function handleDelete() {
    startTransition(async () => {
      await deleteTriggerAction({
        orgSlug,
        workspaceSlug,
        triggerId: trigger.triggerId,
      });
      setConfirmDelete(false);
    });
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/60">
            <KindIcon
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">
                {trigger.triggerType.charAt(0).toUpperCase() +
                  trigger.triggerType.slice(1)}{" "}
                trigger
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  trigger.enabled
                    ? "bg-success/12 text-success"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {trigger.enabled ? "Enabled" : "Disabled"}
              </span>
              <span className="rounded border border-border/50 px-1 py-0.5 text-[10px] text-muted-foreground">
                {kind.label}
              </span>
            </div>
            <p className="text-[11px] font-mono text-muted-foreground">
              {trigger.publicId}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggle}
            disabled={isPending}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
            title={trigger.enabled ? "Disable" : "Enable"}
          >
            {trigger.enabled ? (
              <PowerOff className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Power className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
          {confirmDelete ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={handleDelete}
                disabled={isPending}
                className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 transition-colors"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
              >
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={isPending}
              className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Cause detail */}
      <div className="pl-9 text-[11px] text-muted-foreground">
        {trigger.schedule && (
          <p>
            Cron: <code className="font-mono">{trigger.schedule}</code>
          </p>
        )}
        {trigger.eventSource && trigger.eventType && (
          <p>
            <code className="font-mono">{trigger.eventSource}</code> →{" "}
            <code className="font-mono">{trigger.eventType}</code>
          </p>
        )}
        {trigger.triggerType === "manual" && <p>Run manually via API or UI</p>}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function TriggersPanel({
  orgSlug,
  workspaceSlug,
  agentId,
  agentName,
  triggers,
}: TriggersPanelProps) {
  const [showCreate, setShowCreate] = useState(false);
  const enabledCount = triggers.filter((t) => t.enabled).length;

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Zap
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-foreground">Triggers</p>
            <p className="text-xs text-muted-foreground">
              Automation triggers for{" "}
              <span className="font-medium text-foreground">{agentName}</span>.{" "}
              {enabledCount} of {triggers.length} enabled.
            </p>
          </div>
        </div>
        {!showCreate && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New trigger
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <CreateTriggerForm
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          agentId={agentId}
          onDone={() => setShowCreate(false)}
        />
      )}

      {/* Trigger cards */}
      {triggers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No triggers configured. Create one to automate agent runs.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {triggers.map((trigger) => (
            <TriggerCard
              key={trigger.triggerId}
              trigger={trigger}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          ))}
        </div>
      )}
    </div>
  );
}
