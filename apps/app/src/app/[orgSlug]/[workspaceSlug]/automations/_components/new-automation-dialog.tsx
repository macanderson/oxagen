"use client";
/**
 * new-automation-dialog.tsx — create an automation without going through chat.
 *
 * Name + description + trigger type + type-specific config (graph event / cron
 * schedule / API-manual), plus an optional scaffold-steps list. Submits to
 * createAutomationAction; the automation is always created DISABLED — the user
 * lands on its editor to enable it behind the human gate.
 *
 * Reuses the shared trigger/step option constants + factories from the chat
 * inline-create component so the two surfaces stay in lockstep.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { workspace } from "@/lib/routes";
import {
  TRIGGER_TYPE_OPTIONS,
  EVENT_TYPE_OPTIONS,
  STEP_TYPE_OPTIONS,
  emptyStep,
  type AutomationStep,
} from "@/components/chat/registry-components/automation-create-inline-types";
import { createAutomationAction } from "../actions";

type TriggerType = "event" | "schedule" | "api";
type EventType = "node.created" | "node.updated" | "node.deleted";

export interface NewAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
}

export function NewAutomationDialog({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
}: NewAutomationDialogProps) {
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerType>("event");
  const [entityType, setEntityType] = useState("");
  const [eventType, setEventType] = useState<EventType>("node.created");
  const [cronExpression, setCronExpression] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [steps, setSteps] = useState<AutomationStep[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setDescription("");
    setTriggerType("event");
    setEntityType("");
    setEventType("node.created");
    setCronExpression("");
    setTimezone("UTC");
    setSteps([]);
    setError(null);
  }

  function validate(): string | null {
    if (name.trim().length === 0) return "Name is required.";
    if (triggerType === "event" && entityType.trim().length === 0) {
      return "Graph-event triggers need an entity type to watch.";
    }
    if (triggerType === "schedule" && cronExpression.trim().length === 0) {
      return "Schedule triggers need a cron expression.";
    }
    return null;
  }

  async function handleCreate() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setPending(true);

    const triggerConfig =
      triggerType === "event"
        ? { entityType: entityType.trim(), eventType }
        : triggerType === "schedule"
          ? {
              cronExpression: cronExpression.trim(),
              timezone: timezone.trim() || "UTC",
            }
          : {};

    // finally: the dialog refuses to close while `pending` is true, so a
    // rejected action without this would trap the user in a dialog stuck on
    // "Creating…" until the page is reloaded.
    try {
      const res = await createAutomationAction({
        orgSlug,
        workspaceSlug,
        name: name.trim(),
        description: description.trim() || undefined,
        triggerType,
        triggerConfig,
        steps: steps
          .filter((s) => s.name.trim().length > 0)
          .map((s) => ({
            name: s.name.trim(),
            stepType: s.stepType,
            config: s.config ?? {},
          })),
      });

      if (res.ok) {
        toast.add({
          title: "Automation created",
          description: `${name.trim()} is disabled — enable it to go live.`,
          type: "success",
        });
        const id = res.automation.automation_id;
        reset();
        onOpenChange(false);
        router.push(
          workspace.automations.automation({ orgSlug, workspaceSlug }, id),
        );
        router.refresh();
      } else {
        setError(res.error);
      }
    } catch {
      setError("Creating the automation failed. Try again.");
    } finally {
      setPending(false);
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
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>
            Bind a playbook to a graph event, a schedule, or manual firing. It
            starts disabled — you enable it deliberately once it looks right.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Notify on high-value deal"
              maxLength={120}
              data-testid="automation-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="automation-description">
              Description (optional)
            </Label>
            <Textarea
              id="automation-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this automation does and when it fires."
              maxLength={500}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Trigger type</Label>
            <Select
              value={triggerType}
              onValueChange={(v) => setTriggerType(v as TriggerType)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TRIGGER_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          {triggerType === "event" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="entity-type">Entity type</Label>
                <Input
                  id="entity-type"
                  value={entityType}
                  onChange={(e) => setEntityType(e.target.value)}
                  placeholder="Contact"
                  data-testid="entity-type"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Event</Label>
                <Select
                  value={eventType}
                  onValueChange={(v) => setEventType(v as EventType)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {EVENT_TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
          )}

          {triggerType === "schedule" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cron">Cron expression</Label>
                <Input
                  id="cron"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="0 9 * * 1"
                  className="font-mono"
                  data-testid="cron"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="timezone">Timezone</Label>
                <Input
                  id="timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="UTC"
                />
              </div>
            </div>
          )}

          {triggerType === "api" && (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              An API / manual automation only fires when you use “Trigger now”
              or call the automation capability via the API, MCP, or CLI.
            </p>
          )}

          {/* Optional scaffold steps */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Steps (optional)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSteps((s) => [...s, emptyStep()])}
              >
                <Plus className="size-3.5" /> Add step
              </Button>
            </div>
            {steps.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Leave empty to scaffold a blank playbook you configure later.
              </p>
            ) : (
              <div className="space-y-2">
                {steps.map((step, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={step.name}
                      onChange={(e) =>
                        setSteps((prev) =>
                          prev.map((s, j) =>
                            j === i ? { ...s, name: e.target.value } : s,
                          ),
                        )
                      }
                      placeholder="Step name"
                      className="flex-1"
                    />
                    <Select
                      value={step.stepType}
                      onValueChange={(v) =>
                        setSteps((prev) =>
                          prev.map((s, j) =>
                            j === i
                              ? {
                                  ...s,
                                  stepType: v as AutomationStep["stepType"],
                                }
                              : s,
                          ),
                        )
                      }
                    >
                      <SelectTrigger size="sm" className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {STEP_TYPE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove step"
                      onClick={() =>
                        setSteps((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-error" data-testid="create-error">
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
            onClick={handleCreate}
            disabled={pending}
            type="button"
            data-testid="create-automation"
          >
            {pending ? "Creating…" : "Create automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
