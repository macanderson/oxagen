"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PropertyTable } from "./property-table";
import type { LabelItem, PropertyItem } from "./types";
import type { SchemaLabelUpsertInput } from "./schema-service";

interface LabelEditorProps {
  schemaName: string;
  initial?: LabelItem;
  onSave: (input: SchemaLabelUpsertInput) => Promise<void>;
  onCancel: () => void;
}

export function LabelEditor({
  schemaName,
  initial,
  onSave,
  onCancel,
}: LabelEditorProps) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [displayName, setDisplayName] = React.useState(
    initial?.displayName ?? "",
  );
  const [description, setDescription] = React.useState(
    initial?.description ?? "",
  );
  const [naturalKeyProps, setNaturalKeyProps] = React.useState(
    initial?.naturalKeyProps?.join(", ") ?? "",
  );
  const [properties, setProperties] = React.useState<PropertyItem[]>(
    initial?.properties ?? [],
  );
  const [saving, setSaving] = React.useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        schemaName,
        name,
        displayName,
        description: description || undefined,
        naturalKeyProps: naturalKeyProps
          ? naturalKeyProps
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        properties,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="label-name">Name</Label>
          <Input
            id="label-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Person"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="label-display-name">Display Name</Label>
          <Input
            id="label-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Person"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="label-description">Description</Label>
        <Textarea
          id="label-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A human individual in the workspace."
          rows={2}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="label-natural-key">
          Natural Key Properties{" "}
          <span className="text-muted-foreground font-normal">
            (comma-separated)
          </span>
        </Label>
        <Input
          id="label-natural-key"
          value={naturalKeyProps}
          onChange={(e) => setNaturalKeyProps(e.target.value)}
          placeholder="email, externalId"
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
          {saving ? "Saving…" : "Save label"}
        </Button>
      </div>
    </div>
  );
}
