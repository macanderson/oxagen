"use client";
/**
 * trigger-form-dialog.tsx — shared create/edit dialog for an agent.trigger.*
 * binding.
 *
 * A minimal, self-contained form (type select; cron for schedule; source/
 * type/connection/branches/path-globs for event) — NOT a fork of the Agent
 * Builder's trigger step. That step (workbench/agents/agent-builder.tsx,
 * step "triggers") is wizard-local state with no standalone exported
 * component to reuse, and it supports even less than this form (no
 * branches/pathGlobs, no timezone — see the contract-gap note in
 * lib/automations/triggers.ts). `conditions`, the free-form predicate map
 * inside agentEventFilterSchema.filter, is intentionally not editable here —
 * arbitrary key/value JSON editing is out of scope for a minimal form; an
 * existing trigger's conditions (if any) are preserved untouched on edit.
 *
 * `mode="create"` shows an Agent select (pick which agent to attach to) and
 * submits via createTriggerAction; `mode="edit"` shows the agent name
 * read-only and submits via updateTriggerAction.
 */
import { useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { AgentOption } from "@/lib/automations/triggers";
import type { AgentTriggerType } from "@oxagen/oxagen/agent-schema";
import { createTriggerAction, updateTriggerAction } from "../actions";

export interface TriggerFormFilter {
  branches?: string[];
  pathGlobs?: string[];
  conditions?: Record<string, unknown>;
}

export interface TriggerFormInitial {
  type: AgentTriggerType;
  eventSource?: string;
  eventType?: string;
  connectionId?: string;
  filter?: TriggerFormFilter;
  schedule?: string;
  enabled: boolean;
}

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
}

export type TriggerFormDialogProps =
  | (BaseProps & {
      mode: "create";
      agents: AgentOption[];
      onCreated?: () => void;
    })
  | (BaseProps & {
      mode: "edit";
      agentName: string;
      triggerId: string;
      initial: TriggerFormInitial;
      onSaved?: () => void;
    });

function toList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fromList(v: string[] | undefined): string {
  return (v ?? []).join(", ");
}

export function TriggerFormDialog(props: TriggerFormDialogProps) {
  const { open, onOpenChange, orgSlug, workspaceSlug, mode } = props;
  const toast = useToast();

  const initial = mode === "edit" ? props.initial : undefined;

  const [agentId, setAgentId] = useState(
    mode === "create" ? (props.agents[0]?.agentId ?? "") : "",
  );
  const [type, setType] = useState<AgentTriggerType>(initial?.type ?? "manual");
  const [eventSource, setEventSource] = useState(initial?.eventSource ?? "");
  const [eventType, setEventType] = useState(initial?.eventType ?? "");
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? "");
  const [branches, setBranches] = useState(fromList(initial?.filter?.branches));
  const [pathGlobs, setPathGlobs] = useState(fromList(initial?.filter?.pathGlobs));
  const [schedule, setSchedule] = useState(initial?.schedule ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    if (mode === "create") setAgentId(props.agents[0]?.agentId ?? "");
    setType(initial?.type ?? "manual");
    setEventSource(initial?.eventSource ?? "");
    setEventType(initial?.eventType ?? "");
    setConnectionId(initial?.connectionId ?? "");
    setBranches(fromList(initial?.filter?.branches));
    setPathGlobs(fromList(initial?.filter?.pathGlobs));
    setSchedule(initial?.schedule ?? "");
    setEnabled(initial?.enabled ?? false);
    setError(null);
  }

  function validate(): string | null {
    if (mode === "create" && !agentId) return "Pick an agent.";
    if (type === "schedule" && schedule.trim().length === 0) {
      return "Schedule triggers need a cron expression.";
    }
    if (type === "event" && (eventSource.trim().length === 0 || eventType.trim().length === 0)) {
      return "Event triggers need both an event source and an event type.";
    }
    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setPending(true);

    const filter: TriggerFormFilter | undefined =
      type === "event"
        ? {
            branches: toList(branches),
            pathGlobs: toList(pathGlobs),
            ...(initial?.filter?.conditions ? { conditions: initial.filter.conditions } : {}),
          }
        : undefined;

    const trigger = {
      type,
      eventSource: type === "event" ? eventSource.trim() : undefined,
      eventType: type === "event" ? eventType.trim() : undefined,
      connectionId: type === "event" && connectionId.trim() ? connectionId.trim() : undefined,
      filter,
      schedule: type === "schedule" ? schedule.trim() : undefined,
      enabled,
    };

    const res =
      mode === "create"
        ? await createTriggerAction({ orgSlug, workspaceSlug, agentId, trigger })
        : await updateTriggerAction({
            orgSlug,
            workspaceSlug,
            triggerId: props.triggerId,
            trigger,
          });

    setPending(false);

    if (res.ok) {
      toast.add({
        title: mode === "create" ? "Trigger created" : "Trigger updated",
        type: "success",
      });
      reset();
      onOpenChange(false);
      if (mode === "create") props.onCreated?.();
      else props.onSaved?.();
    } else {
      setError(res.error);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New trigger" : "Edit trigger"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Bind a manual, schedule, or event trigger to an agent."
              : `Editing the trigger on ${props.agentName}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === "create" ? (
            <div className="space-y-1.5">
              <Label>Agent</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger className="w-full" data-testid="trigger-agent-select">
                  <SelectValue placeholder="Select an agent" />
                </SelectTrigger>
                <SelectPopup>
                  {props.agents.map((a) => (
                    <SelectItem key={a.agentId} value={a.agentId}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {props.agents.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No agents available to attach a trigger to yet.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Agent</Label>
              <p className="text-sm text-foreground">{props.agentName}</p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as AgentTriggerType)}>
              <SelectTrigger className="w-full" data-testid="trigger-type-select">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="schedule">Schedule</SelectItem>
                <SelectItem value="event">Event</SelectItem>
              </SelectPopup>
            </Select>
          </div>

          {type === "schedule" && (
            <div className="space-y-1.5">
              <Label htmlFor="trigger-cron">Cron expression</Label>
              <Input
                id="trigger-cron"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="0 9 * * 1"
                className="font-mono"
                data-testid="trigger-cron-input"
              />
              <p className="text-xs text-muted-foreground">
                Standard 5-field cron. Runs UTC — agentTriggerSchema has no timezone field yet.
              </p>
            </div>
          )}

          {type === "event" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="trigger-event-source">Event source</Label>
                  <Input
                    id="trigger-event-source"
                    value={eventSource}
                    onChange={(e) => setEventSource(e.target.value)}
                    placeholder="github_repo"
                    data-testid="trigger-event-source"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="trigger-event-type">Event type</Label>
                  <Input
                    id="trigger-event-type"
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value)}
                    placeholder="push"
                    data-testid="trigger-event-type"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trigger-connection">Connection id (optional)</Label>
                <Input
                  id="trigger-connection"
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  placeholder="conn_…"
                  className="font-mono"
                  data-testid="trigger-connection"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="trigger-branches">Branches (optional)</Label>
                  <Input
                    id="trigger-branches"
                    value={branches}
                    onChange={(e) => setBranches(e.target.value)}
                    placeholder="main, release/*"
                    data-testid="trigger-branches"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="trigger-path-globs">Path globs (optional)</Label>
                  <Input
                    id="trigger-path-globs"
                    value={pathGlobs}
                    onChange={(e) => setPathGlobs(e.target.value)}
                    placeholder="src/**, docs/**"
                    data-testid="trigger-path-globs"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Comma-separated. Empty matches every event of this type.
              </p>
            </div>
          )}

          <div className="flex items-start gap-2 border-t pt-4">
            <Checkbox
              id="trigger-enabled"
              checked={enabled}
              onCheckedChange={(v) => setEnabled(v === true)}
              data-testid="trigger-enabled"
            />
            <div>
              <Label htmlFor="trigger-enabled">Enabled</Label>
              <p className="text-xs text-muted-foreground">
                Live triggers fire the agent automatically once it&apos;s deployed active.
              </p>
            </div>
          </div>

          {error && (
            <p className="text-sm text-error" data-testid="trigger-form-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            type="button"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={pending}
            type="button"
            data-testid="trigger-form-submit"
          >
            {pending
              ? mode === "create"
                ? "Creating…"
                : "Saving…"
              : mode === "create"
                ? "Create trigger"
                : "Save trigger"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
