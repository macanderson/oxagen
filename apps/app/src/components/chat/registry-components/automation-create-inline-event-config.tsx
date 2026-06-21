"use client";

/**
 * automation-create-inline-event-config.tsx — "Event configuration" section
 * rendered when the automation trigger type is "event".
 *
 * Owns: entity-type field, event-type selector, property-condition list.
 */

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EVENT_TYPE_OPTIONS,
  OPERATOR_OPTIONS,
  type PropertyCondition,
} from "./automation-create-inline-types";

// ── Props ──────────────────────────────────────────────────────────────────────

interface EventTriggerConfigProps {
  entityType: string;
  onEntityTypeChange: (value: string) => void;
  entityTypeId: string;

  eventType: "node.created" | "node.updated" | "node.deleted" | "";
  onEventTypeChange: (value: "node.created" | "node.updated" | "node.deleted") => void;
  eventTypeId: string;

  conditions: PropertyCondition[];
  onAddCondition: () => void;
  onRemoveCondition: (idx: number) => void;
  onUpdateCondition: (idx: number, patch: Partial<PropertyCondition>) => void;

  disabled: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function EventTriggerConfig({
  entityType,
  onEntityTypeChange,
  entityTypeId,
  eventType,
  onEventTypeChange,
  eventTypeId,
  conditions,
  onAddCondition,
  onRemoveCondition,
  onUpdateCondition,
  disabled,
}: EventTriggerConfigProps): React.ReactElement {
  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-muted/30 p-4">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Event configuration
      </p>

      <div className="grid grid-cols-2 gap-3">
        {/* Entity type */}
        <div className="space-y-1.5">
          <Label htmlFor={entityTypeId}>Entity type</Label>
          <Input
            id={entityTypeId}
            name="entityType"
            placeholder="e.g. Commit"
            value={entityType}
            onChange={(e) => onEntityTypeChange(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            data-testid="entity-type-input"
          />
        </div>

        {/* Event type */}
        <div className="space-y-1.5">
          <Label htmlFor={eventTypeId}>Event type</Label>
          <Select
            value={eventType !== "" ? eventType : undefined}
            onValueChange={(v) => {
              if (v !== null)
                onEventTypeChange(v as "node.created" | "node.updated" | "node.deleted");
            }}
            disabled={disabled}
            name="eventType"
            items={EVENT_TYPE_OPTIONS}
          >
            <SelectTrigger id={eventTypeId} aria-label="Event type" data-testid="event-type-select">
              <SelectValue placeholder="Select event" />
            </SelectTrigger>
            <SelectPopup>
              {EVENT_TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      {/* Property conditions */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Property conditions</p>
        {conditions.map((cond, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end"
            data-testid={`condition-row-${idx}`}
          >
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Property</Label>
              <Input
                name={`condition.${idx}.property`}
                placeholder="e.g. status"
                value={cond.property}
                onChange={(e) => onUpdateCondition(idx, { property: e.target.value })}
                disabled={disabled}
                autoComplete="off"
                data-testid={`condition-property-${idx}`}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Operator</Label>
              <Select
                value={cond.operator}
                onValueChange={(v) => {
                  if (v !== null)
                    onUpdateCondition(idx, {
                      operator: v as PropertyCondition["operator"],
                    });
                }}
                disabled={disabled}
                items={OPERATOR_OPTIONS}
              >
                <SelectTrigger
                  aria-label="Operator"
                  data-testid={`condition-operator-${idx}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {OPERATOR_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Value</Label>
              <Input
                name={`condition.${idx}.toValue`}
                placeholder="e.g. main"
                value={cond.toValue ?? ""}
                onChange={(e) => onUpdateCondition(idx, { toValue: e.target.value })}
                disabled={disabled}
                autoComplete="off"
                data-testid={`condition-value-${idx}`}
              />
            </div>
            <button
              type="button"
              onClick={() => onRemoveCondition(idx)}
              disabled={disabled}
              className="mb-0.5 rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              aria-label={`Remove condition ${idx + 1}`}
              data-testid={`condition-remove-${idx}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onAddCondition}
          disabled={disabled}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="add-condition-btn"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add condition
        </button>
      </div>
    </div>
  );
}
