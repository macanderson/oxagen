/**
 * create-node-dialog.tsx — dialog for creating a new knowledge graph node.
 *
 * Fields:
 *  - Label (creatable select from workspace vocab)
 *  - Display name (text input)
 *  - Description (optional textarea)
 *  - Properties (dynamic key-value editor)
 *
 * On submit, calls `upsertNode` via the api-client and notifies the parent
 * so the explorer state can be refreshed.
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

export interface CreateNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantSlugs;
  /** Workspace vocabulary: labels already in use. */
  labels: string[];
  onCreated: (nodeId: string) => void;
}

interface PropertyRow {
  key: string;
  value: string;
}

export function CreateNodeDialog({
  open,
  onOpenChange,
  tenant,
  labels,
  onCreated,
}: CreateNodeDialogProps) {
  const [label, setLabel] = React.useState<string | null>(null);
  const [customLabel, setCustomLabel] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [properties, setProperties] = React.useState<PropertyRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const effectiveLabel = label ?? customLabel;

  const reset = () => {
    setLabel(null);
    setCustomLabel("");
    setDisplayName("");
    setDescription("");
    setProperties([]);
    setError(null);
  };

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

      const result = await upsertNode(tenant, {
        label: effectiveLabel.trim(),
        displayName: displayName.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(Object.keys(props).length > 0 ? { properties: props } : {}),
      });

      reset();
      onOpenChange(false);
      onCreated(result.nodeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create node");
    } finally {
      setSubmitting(false);
    }
  };

  // Combine existing workspace labels with the custom typed one for the select.
  const allLabels = React.useMemo(() => {
    const set = new Set(labels);
    if (customLabel.trim() && !set.has(customLabel.trim())) {
      return [customLabel.trim(), ...labels];
    }
    return labels;
  }, [labels, customLabel]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create node</DialogTitle>
            <DialogDescription>
              Add a new entity to the knowledge graph.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="mt-4 gap-4">
            {/* Label (type) */}
            <div className="space-y-1.5">
              <Label htmlFor="node-label">Type (label)</Label>
              <Combobox value={label} onValueChange={setLabel}>
                <ComboboxTrigger id="node-label" className="w-full">
                  <ComboboxValue placeholder="Select or type a label…" />
                </ComboboxTrigger>
                <ComboboxPopup searchPlaceholder="Search or create label…">
                  {allLabels.map((l) => (
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
              <Label htmlFor="node-name">Name</Label>
              <Input
                id="node-name"
                placeholder="Human-readable name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="node-desc">Description (optional)</Label>
              <Textarea
                id="node-desc"
                placeholder="Brief description or summary"
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
              Create node
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
