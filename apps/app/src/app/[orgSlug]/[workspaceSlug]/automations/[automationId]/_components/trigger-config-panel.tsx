"use client";
/**
 * trigger-config-panel.tsx — view + edit the automation's trigger configuration.
 *
 * event   → entity type + event type (+ read-only property conditions, preserved
 *           unchanged on save so an edit never silently drops them).
 * schedule → cron expression + IANA timezone.
 * api      → read-only note: fires only via Trigger-now or the API/MCP/CLI.
 *
 * Saving replaces the whole triggerConfig via update_automation (canManage-gated).
 */
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";
import { EVENT_TYPE_OPTIONS } from "@/components/chat/registry-components/automation-create-inline-types";
import { updateAutomationAction } from "../../actions";

type EventType = "node.created" | "node.updated" | "node.deleted";

interface PropertyCondition {
  property: string;
  operator?: string;
  toValue?: unknown;
  fromValue?: unknown;
}

export interface TriggerConfigPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  automationId: string;
  triggerType: "event" | "schedule" | "api";
  triggerConfig: Record<string, unknown>;
  canManage: boolean;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function TriggerConfigPanel({
  orgSlug,
  workspaceSlug,
  automationId,
  triggerType,
  triggerConfig,
  canManage,
}: TriggerConfigPanelProps) {
  const router = useRouter();
  const toast = useToast();

  const conditions = Array.isArray(triggerConfig.propertyConditions)
    ? (triggerConfig.propertyConditions as PropertyCondition[])
    : [];

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [entityType, setEntityType] = useState(asString(triggerConfig.entityType));
  const [eventType, setEventType] = useState<EventType>(
    (asString(triggerConfig.eventType) as EventType) || "node.created",
  );
  const [cron, setCron] = useState(asString(triggerConfig.cronExpression));
  const [timezone, setTimezone] = useState(asString(triggerConfig.timezone) || "UTC");

  async function handleSave() {
    setBusy(true);
    const nextConfig =
      triggerType === "event"
        ? {
            entityType: entityType.trim(),
            eventType,
            // Preserve existing conditions verbatim — the panel doesn't author them.
            propertyConditions: conditions.map((c) => ({
              property: c.property,
              operator: (c.operator as "eq" | "gt" | "lt" | "changed") ?? "eq",
              toValue: c.toValue === undefined ? undefined : String(c.toValue),
            })),
          }
        : triggerType === "schedule"
          ? { cronExpression: cron.trim(), timezone: timezone.trim() || "UTC" }
          : {};

    const res = await updateAutomationAction({
      orgSlug,
      workspaceSlug,
      automationId,
      triggerConfig: nextConfig,
    });
    setBusy(false);
    if (res.ok) {
      toast.add({ title: "Trigger updated", type: "success" });
      setEditing(false);
      router.refresh();
    } else {
      toast.add({ title: "Couldn't update trigger", description: res.error, type: "error" });
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Trigger configuration</h2>
        {canManage && triggerType !== "api" && !editing && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Edit trigger configuration"
            onClick={() => setEditing(true)}
            data-testid="edit-trigger"
          >
            <Pencil className="size-4" />
          </Button>
        )}
      </div>

      {triggerType === "api" && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          This automation only fires when you use “Trigger now” or call the automation capability
          via the API, MCP, or CLI. There is no automatic trigger to configure.
        </p>
      )}

      {triggerType === "event" &&
        (editing ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfg-entity">Entity type</Label>
              <Input
                id="cfg-entity"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                data-testid="cfg-entity"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Event</Label>
              <Select value={eventType} onValueChange={(v) => setEventType(v as EventType)}>
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
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Entity type</dt>
            <dd className="font-medium text-foreground">
              {asString(triggerConfig.entityType) || "—"}
            </dd>
            <dt className="text-muted-foreground">Event</dt>
            <dd className="font-medium text-foreground">
              {asString(triggerConfig.eventType) || "—"}
            </dd>
            {conditions.length > 0 && (
              <>
                <dt className="text-muted-foreground">Conditions</dt>
                <dd className="text-foreground">
                  {conditions.map((c, i) => (
                    <div key={i} className="font-mono text-xs">
                      {c.property} {c.operator ?? "eq"}{" "}
                      {c.toValue !== undefined ? String(c.toValue) : ""}
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>
        ))}

      {triggerType === "schedule" &&
        (editing ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfg-cron">Cron expression</Label>
              <Input
                id="cfg-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                className="font-mono"
                data-testid="cfg-cron"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfg-tz">Timezone</Label>
              <Input id="cfg-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Cron</dt>
            <dd className="font-mono text-foreground">
              {asString(triggerConfig.cronExpression) || "—"}
            </dd>
            <dt className="text-muted-foreground">Timezone</dt>
            <dd className="font-medium text-foreground">
              {asString(triggerConfig.timezone) || "UTC"}
            </dd>
          </dl>
        ))}

      {editing && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={busy} data-testid="save-trigger">
            {busy ? "Saving…" : "Save trigger"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}
