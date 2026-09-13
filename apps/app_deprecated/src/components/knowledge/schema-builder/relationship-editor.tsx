"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PropertyTable } from "./property-table";
import type { RelationshipItem, PropertyItem } from "./types";
import type { SchemaRelationshipUpsertInput } from "./schema-service";

interface RelationshipEditorProps {
  schemaName: string;
  availableLabels: string[];
  initial?: RelationshipItem;
  onSave: (input: SchemaRelationshipUpsertInput) => Promise<void>;
  onCancel: () => void;
}

const CARDINALITY_OPTIONS = [
  { value: "one_to_one", label: "One to One" },
  { value: "one_to_many", label: "One to Many" },
  { value: "many_to_many", label: "Many to Many" },
] as const;

export function RelationshipEditor({
  schemaName,
  availableLabels,
  initial,
  onSave,
  onCancel,
}: RelationshipEditorProps) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [displayName, setDisplayName] = React.useState(
    initial?.displayName ?? "",
  );
  const [startLabel, setStartLabel] = React.useState(initial?.startLabel ?? "");
  const [endLabel, setEndLabel] = React.useState(initial?.endLabel ?? "");
  const [cardinality, setCardinality] = React.useState<
    RelationshipItem["cardinality"] | ""
  >(initial?.cardinality ?? "");
  const [description, setDescription] = React.useState(
    initial?.description ?? "",
  );
  const [properties, setProperties] = React.useState<PropertyItem[]>(
    initial?.properties ?? [],
  );
  const [saving, setSaving] = React.useState(false);

  // Enforce uppercase for relationship type names
  const handleNameChange = (v: string) =>
    setName(v.toUpperCase().replace(/[^A-Z0-9_]/g, ""));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        schemaName,
        name,
        displayName,
        startLabel: startLabel || undefined,
        endLabel: endLabel || undefined,
        cardinality: cardinality || undefined,
        description: description || undefined,
        properties: properties.length > 0 ? properties : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const labelOptions = ["Any", ...availableLabels];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rel-name">Name</Label>
          <Input
            id="rel-name"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="WORKS_FOR"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Uppercase only, e.g. WORKS_FOR
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rel-display-name">Display Name</Label>
          <Input
            id="rel-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Works For"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label>Start Label</Label>
          <Select
            value={startLabel || "Any"}
            onValueChange={(v) =>
              setStartLabel(v == null || v === "Any" ? "" : v)
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              {labelOptions.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>End Label</Label>
          <Select
            value={endLabel || "Any"}
            onValueChange={(v) =>
              setEndLabel(v == null || v === "Any" ? "" : v)
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              {labelOptions.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Cardinality</Label>
          <Select
            value={cardinality || ""}
            onValueChange={(v) =>
              setCardinality(v as RelationshipItem["cardinality"] | "")
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Not set" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Not set</SelectItem>
              {CARDINALITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rel-description">Description</Label>
        <Textarea
          id="rel-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Indicates employment relationship."
          rows={2}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Properties</Label>
        <PropertyTable
          properties={properties}
          onAdd={(p) => setProperties((prev) => [...prev, p])}
          onUpdate={(i, p) =>
            setProperties((prev) => prev.map((x, idx) => (idx === i ? p : x)))
          }
          onRemove={(i) =>
            setProperties((prev) => prev.filter((_, idx) => idx !== i))
          }
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || !name || !displayName}>
          {saving ? "Saving…" : "Save relationship"}
        </Button>
      </div>
    </div>
  );
}
