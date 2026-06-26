/**
 * edit-node-dialog.tsx — dialog for editing an existing knowledge graph node.
 *
 * Pre-populated with the node's current values. On submit, calls `upsertNode`
 * (which MERGEs by natural key) to update the node in place.
 */

"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxPopup,
  ComboboxItem,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import { upsertNode, type TenantSlugs } from "./api-client";
import type { ExplorerNode } from "./types";

export interface EditNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantSlugs;
  /** The node being edited. */
  node: ExplorerNode;
  /** Workspace vocabulary: labels already in use. */
  labels: string[];
  onUpdated: (nodeId: string) => void;
}

interface PropertyRow {
  key: string;
  value: string;
}

function propsToRows(properties: Record<string, unknown> | undefined): PropertyRow[] {
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([key]) => key !== "displayName" && key !== "publicId")
    .map(([key, value]) => ({ key, value: String(value ?? "") }));
}

export function EditNodeDialog({
  open,
  onOpenChange,
  tenant,
  node,
  labels,
  onUpdated,
}: EditNodeDialogProps) {
  const [label, setLabel] = React.useState<string | null>(node.label);
  const [customLabel, setCustomLabel] = React.useState("");
  const [displayName, setDisplayName] = React.useState(node.displayName);
  const [description, setDescription] = React.useState(node.description ?? "");
  const [properties, setProperties] = React.useState<PropertyRow[]>(propsToRows(node.properties));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Sync when the node prop changes (e.g. selecting a different node to edit).
  React.useEffect(() => {
    setLabel(node.label);
    setCustomLabel("");
    setDisplayName(node.displayName);
    setDescription(node.description ?? "");
    setProperties(propsToRows(node.properties));
    setError(null);
  }, [node]);

  const effectiveLabel = label ?? customLabel;

  const addProperty = () => setProperties((p) => [...p, { key: "", value: "" }]);
  const removeProperty = (idx: number) => setProperties((p) => p.filter((_, i) => i !== idx));
  const updateProperty = (idx: number, field: "key" | "value", val: string) => {
    setProperties((p) => p.map((row, i) => (i === idx ? { ...row, [field]: val } : row)));
  };

  const canSubmit = effectiveLabel.trim().length > 0 && displayName.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const props: Record<string, unknown> = {};
      for (const row of properties) {
        if (row.key.trim()) props[row.key.trim()] = row.value;
      }

      await upsertNode(tenant, {
        label: effectiveLabel.trim(),
        displayName: displayName.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(Object.keys(props).length > 0 ? { properties: props } : {}),
        // Use the node's existing id as externalId so the MERGE matches the
        // existing node rather than creating a new one.
        externalId: node.id,
      });

      onOpenChange(false);
      onUpdated(node.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update node");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit node</DialogTitle>
            <DialogDescription>
              Update the properties of &ldquo;{node.displayName}&rdquo;.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="mt-4 gap-4">
            {/* Label (type) */}
            <div className="space-y-1.5">
              <Label htmlFor="edit-node-label">Type (label)</Label>
              <Combobox value={label} onValueChange={setLabel}>
                <ComboboxTrigger id="edit-node-label" className="w-full">
                  <ComboboxValue placeholder="Select or type a label…" />
                </ComboboxTrigger>
                <ComboboxPopup searchPlaceholder="Search labels…">
                  {labels.map((l) => (
                    <ComboboxItem key={l} value={l}>
                      {l}
                    </ComboboxItem>
                  ))}
                </ComboboxPopup>
              </Combobox>
              <Input
                placeholder="Or type a new label…"
                value={customLabel}
                onChange={(e) => {
                  setCustomLabel(e.target.value);
                  if (e.target.value.trim()) setLabel(null);
                }}
                className="mt-1.5"
                aria-label="Custom label"
              />
            </div>

            {/* Display name */}
            <div className="space-y-1.5">
              <Label htmlFor="edit-node-name">Name</Label>
              <Input
                id="edit-node-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="edit-node-desc">Description</Label>
              <Textarea
                id="edit-node-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            {/* Properties */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Properties</Label>
                <Button type="button" variant="ghost" size="sm" onClick={addProperty}>
                  <Plus className="mr-1 size-3.5" />
                  Add
                </Button>
              </div>
              {properties.length > 0 && (
                <div className="space-y-2">
                  {properties.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        placeholder="Key"
                        value={row.key}
                        onChange={(e) => updateProperty(idx, "key", e.target.value)}
                        className="flex-1"
                        aria-label={`Property key ${idx + 1}`}
                      />
                      <Input
                        placeholder="Value"
                        value={row.value}
                        onChange={(e) => updateProperty(idx, "value", e.target.value)}
                        className="flex-1"
                        aria-label={`Property value ${idx + 1}`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeProperty(idx)}
                        aria-label={`Remove property ${idx + 1}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogPanel>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
