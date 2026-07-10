/**
 * node-dialog.tsx — dialog for creating or editing a knowledge graph node.
 *
 * Omit `node` to create a new node with empty fields; pass an `ExplorerNode`
 * to pre-fill and edit it in place. Both modes share the same field set
 * (label/displayName/description/properties) and submit through the same
 * `upsertNode` call — editing pins the MERGE to the existing node via
 * `externalId` so it updates rather than creating a duplicate.
 *
 * Fields:
 *  - Label (creatable select from workspace vocab)
 *  - Display name (text input)
 *  - Description (optional textarea)
 *  - Properties (dynamic key-value editor)
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

export interface NodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantSlugs;
  /** Workspace vocabulary: labels already in use. */
  labels: string[];
  /** The node being edited; omit to create a new node. */
  node?: ExplorerNode;
  /** Called with the created/updated node's id after a successful submit. */
  onSaved: (nodeId: string) => void;
}

interface PropertyRow {
  key: string;
  value: string;
}

function propsToRows(
  properties: Record<string, unknown> | undefined,
): PropertyRow[] {
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([key]) => key !== "displayName" && key !== "publicId")
    .map(([key, value]) => ({ key, value: String(value ?? "") }));
}

export function NodeDialog({
  open,
  onOpenChange,
  tenant,
  labels,
  node,
  onSaved,
}: NodeDialogProps) {
  const [label, setLabel] = React.useState<string | null>(node?.label ?? null);
  const [customLabel, setCustomLabel] = React.useState("");
  const [displayName, setDisplayName] = React.useState(node?.displayName ?? "");
  const [description, setDescription] = React.useState(node?.description ?? "");
  const [properties, setProperties] = React.useState<PropertyRow[]>(
    propsToRows(node?.properties),
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Re-sync when the edited node changes (e.g. selecting a different node to
  // edit while the dialog stays mounted). Create mode never receives a
  // `node` prop, so this effect is a no-op there.
  React.useEffect(() => {
    if (!node) return;
    setLabel(node.label);
    setCustomLabel("");
    setDisplayName(node.displayName);
    setDescription(node.description ?? "");
    setProperties(propsToRows(node.properties));
    setError(null);
  }, [node]);

  const effectiveLabel = label ?? customLabel;

  const reset = () => {
    setLabel(null);
    setCustomLabel("");
    setDisplayName("");
    setDescription("");
    setProperties([]);
    setError(null);
  };

  const addProperty = () =>
    setProperties((p) => [...p, { key: "", value: "" }]);
  const removeProperty = (idx: number) =>
    setProperties((p) => p.filter((_, i) => i !== idx));
  const updateProperty = (idx: number, field: "key" | "value", val: string) => {
    setProperties((p) =>
      p.map((row, i) => (i === idx ? { ...row, [field]: val } : row)),
    );
  };

  const canSubmit =
    effectiveLabel.trim().length > 0 &&
    displayName.trim().length > 0 &&
    !submitting;

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
        // Editing: pin the MERGE to the existing node via its id rather than
        // creating a new one.
        ...(node ? { externalId: node.id } : {}),
      });

      if (!node) reset();
      onOpenChange(false);
      onSaved(node ? node.id : result.nodeId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to ${node ? "update" : "create"} node`,
      );
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

  const labelFieldId = node ? "edit-node-label" : "node-label";
  const nameFieldId = node ? "edit-node-name" : "node-name";
  const descFieldId = node ? "edit-node-desc" : "node-desc";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{node ? "Edit node" : "Create node"}</DialogTitle>
            <DialogDescription>
              {node ? (
                <>Update the properties of &ldquo;{node.displayName}&rdquo;.</>
              ) : (
                "Add a new entity to the knowledge graph."
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="mt-4 gap-4">
            {/* Label (type) */}
            <div className="space-y-1.5">
              <Label htmlFor={labelFieldId}>Type (label)</Label>
              <Combobox value={label} onValueChange={setLabel}>
                <ComboboxTrigger id={labelFieldId} className="w-full">
                  <ComboboxValue placeholder="Select or type a label…" />
                </ComboboxTrigger>
                <ComboboxPopup
                  searchPlaceholder={
                    node ? "Search labels…" : "Search or create label…"
                  }
                >
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
              <Label htmlFor={nameFieldId}>Name</Label>
              <Input
                id={nameFieldId}
                placeholder={node ? undefined : "Human-readable name"}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor={descFieldId}>
                {node ? "Description" : "Description (optional)"}
              </Label>
              <Textarea
                id={descFieldId}
                placeholder={node ? undefined : "Brief description or summary"}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            {/* Properties */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Properties</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addProperty}
                >
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
                        onChange={(e) =>
                          updateProperty(idx, "key", e.target.value)
                        }
                        className="flex-1"
                        aria-label={`Property key ${idx + 1}`}
                      />
                      <Input
                        placeholder="Value"
                        value={row.value}
                        onChange={(e) =>
                          updateProperty(idx, "value", e.target.value)
                        }
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {node ? "Save changes" : "Create node"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
