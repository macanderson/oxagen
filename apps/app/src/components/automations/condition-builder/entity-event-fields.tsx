"use client";
/**
 * entity-event-fields.tsx — the entity-type (node label) Select + event-type
 * Select rendered ABOVE the ConditionBuilder. The chosen label scopes which
 * properties the builder offers, so this pair drives the whole section.
 *
 * The entity-type picker is schema-driven (labels from the workspace registry),
 * never free text. Pure & controlled.
 */
import * as React from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LabelItem } from "@/components/knowledge/schema-builder/types";
import { EVENT_TYPE_OPTIONS } from "@/components/chat/registry-components/automation-create-inline-types";

export type EventType = "node.created" | "node.updated" | "node.deleted";

interface EntityEventFieldsProps {
  labels: LabelItem[];
  entityType: string;
  onEntityTypeChange: (value: string) => void;
  eventType: EventType | "";
  onEventTypeChange: (value: EventType) => void;
  entityFieldId: string;
  eventFieldId: string;
  disabled?: boolean;
}

export function EntityEventFields({
  labels,
  entityType,
  onEntityTypeChange,
  eventType,
  onEventTypeChange,
  entityFieldId,
  eventFieldId,
  disabled,
}: EntityEventFieldsProps): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3">
      {/* Entity type (node label) */}
      <div className="space-y-1.5">
        <Label htmlFor={entityFieldId}>Entity type</Label>
        <Select
          value={entityType !== "" ? entityType : undefined}
          onValueChange={(v) => {
            if (v !== null) onEntityTypeChange(v as string);
          }}
          disabled={disabled}
          name="entityType"
          items={labels.map((l) => ({
            value: l.name,
            label: l.displayName || l.name,
          }))}
        >
          <SelectTrigger
            id={entityFieldId}
            aria-label="Entity type"
            data-testid="entity-type-select"
          >
            <SelectValue placeholder="Select entity type" />
          </SelectTrigger>
          <SelectPopup>
            {labels.map((l) => (
              <SelectItem key={l.name} value={l.name}>
                {l.displayName || l.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {/* Event type */}
      <div className="space-y-1.5">
        <Label htmlFor={eventFieldId}>Event type</Label>
        <Select
          value={eventType !== "" ? eventType : undefined}
          onValueChange={(v) => {
            if (v !== null) onEventTypeChange(v as EventType);
          }}
          disabled={disabled}
          name="eventType"
          items={EVENT_TYPE_OPTIONS}
        >
          <SelectTrigger
            id={eventFieldId}
            aria-label="Event type"
            data-testid="event-type-select"
          >
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
  );
}
