"use client";
/**
 * trigger-config-panel.tsx — view + edit the automation's trigger configuration.
 *
 * event   → entity type (node label) + event type + a schema-driven nested
 *           condition tree (`1 AND (2 OR 3)`) built from the workspace schema
 *           registry. On save we write `{ entityType, eventType, conditionTree }`
 *           and drop the legacy flat `propertyConditions` — the contract accepts
 *           the tree and the runtime normalizes any remaining legacy rows.
 * schedule → cron expression + IANA timezone.
 * api      → read-only note: fires only via Trigger-now or the API/MCP/CLI.
 *
 * Saving replaces the whole triggerConfig via update_automation (canManage-gated).
 */
import { useId, useState } from "react";
import { Pencil } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";
import {
  resolveConditionTree,
  type ConditionNode,
  type ConditionLeaf,
} from "@oxagen/oxagen/trigger-conditions";
import {
  SchemaConditionSection,
  type EventType,
} from "@/components/automations/condition-builder";
import { updateAutomationAction } from "../../actions";

export interface TriggerConfigPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  automationId: string;
  triggerType: "event" | "schedule" | "api";
  triggerConfig: Record<string, unknown>;
  canManage: boolean;
}

interface LegacyPropertyCondition {
  property: string;
  operator?: string;
  toValue?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Flatten a condition tree into its leaves (for the read-mode summary). */
function collectConditionLeaves(node: ConditionNode): ConditionLeaf[] {
  if (node.kind === "group") {
    return node.children.flatMap(collectConditionLeaves);
  }
  return [node];
}

function formatConditionValue(value: ConditionLeaf["value"]): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
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
  const entityFieldId = useId();
  const eventFieldId = useId();

  const legacyConditions = Array.isArray(triggerConfig.propertyConditions)
    ? (triggerConfig.propertyConditions as LegacyPropertyCondition[])
    : [];

  // Read-mode summary: resolve whatever is persisted (an explicit
  // `conditionTree` or legacy flat `propertyConditions`) to a tree and flatten
  // its leaves. New saves persist only `conditionTree`, so summarizing from the
  // resolved tree keeps the collapsed view in sync with what was saved.
  const summaryLeaves = collectConditionLeaves(
    resolveConditionTree({
      conditionTree:
        (triggerConfig.conditionTree as ConditionNode | undefined) ?? null,
      propertyConditions: legacyConditions.map((c) => ({
        property: c.property,
        operator: c.operator as "eq" | "gt" | "lt" | "changed" | undefined,
        toValue: c.toValue,
      })),
    }),
  );

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [entityType, setEntityType] = useState(
    asString(triggerConfig.entityType),
  );
  const [eventType, setEventType] = useState<EventType>(
    (asString(triggerConfig.eventType) as EventType) || "node.created",
  );
  // Seed the tree from whatever is stored — an explicit conditionTree, else the
  // legacy flat conditions lifted into an AND-group (via resolveConditionTree).
  const [conditionTree, setConditionTree] = useState<ConditionNode>(() =>
    resolveConditionTree({
      conditionTree:
        (triggerConfig.conditionTree as ConditionNode | undefined) ?? null,
      propertyConditions: legacyConditions.map((c) => ({
        property: c.property,
        operator: c.operator as "eq" | "gt" | "lt" | "changed" | undefined,
        toValue: c.toValue,
      })),
    }),
  );
  const [cron, setCron] = useState(asString(triggerConfig.cronExpression));
  const [timezone, setTimezone] = useState(
    asString(triggerConfig.timezone) || "UTC",
  );

  async function handleSave() {
    setBusy(true);
    const nextConfig =
      triggerType === "event"
        ? {
            entityType: entityType.trim(),
            eventType,
            // New saves persist the schema-driven tree and drop the legacy flat
            // propertyConditions entirely.
            conditionTree,
          }
        : triggerType === "schedule"
          ? { cronExpression: cron.trim(), timezone: timezone.trim() || "UTC" }
          : {};

    // finally: `busy` disables Save AND Cancel, so a rejected action without
    // this would strand the panel in edit mode until the page is reloaded.
    try {
      const res = await updateAutomationAction({
        orgSlug,
        workspaceSlug,
        automationId,
        triggerConfig: nextConfig,
      });
      if (res.ok) {
        toast.add({ title: "Trigger updated", type: "success" });
        setEditing(false);
        router.refresh();
      } else {
        toast.add({
          title: "Couldn't update trigger",
          description: res.error,
          type: "error",
        });
      }
    } catch {
      toast.add({ title: "Couldn't update trigger", type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          Trigger configuration
        </h2>
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
          This automation only fires when you use “Trigger now” or call the
          automation capability via the API, MCP, or CLI. There is no automatic
          trigger to configure.
        </p>
      )}

      {triggerType === "event" &&
        (editing ? (
          <SchemaConditionSection
            slugs={{ orgSlug, workspaceSlug }}
            entityType={entityType}
            onEntityTypeChange={setEntityType}
            eventType={eventType}
            onEventTypeChange={setEventType}
            conditionTree={conditionTree}
            onConditionTreeChange={setConditionTree}
            entityFieldId={entityFieldId}
            eventFieldId={eventFieldId}
            disabled={busy}
          />
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
            {summaryLeaves.length > 0 && (
              <>
                <dt className="text-muted-foreground">Conditions</dt>
                <dd className="text-foreground">
                  {summaryLeaves.map((leaf, i) => (
                    <div key={leaf.id ?? i} className="font-mono text-xs">
                      {leaf.property} {leaf.operator}{" "}
                      {formatConditionValue(leaf.value)}
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
              <Input
                id="cfg-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
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
          <Button
            size="sm"
            onClick={handleSave}
            disabled={busy}
            data-testid="save-trigger"
          >
            {busy ? "Saving…" : "Save trigger"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}
