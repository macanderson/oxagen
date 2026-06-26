/**
 * edit-edge-dialog.tsx — dialog for editing or deleting an existing relationship.
 *
 * Edges in Neo4j cannot change their type in place (you'd need to delete + recreate),
 * so this dialog allows editing the properties only, or deleting the edge entirely.
 */

"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import { upsertEdge, deleteEdge, type TenantSlugs } from "./api-client";
import type { ExplorerEdge, ExplorerNode } from "./types";

export interface EditEdgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantSlugs;
  edge: ExplorerEdge;
  sourceNode?: ExplorerNode;
  targetNode?: ExplorerNode;
  onUpdated: () => void;
  onDeleted: () => void;
}

interface PropertyRow {
  key: string;
  value: string;
}

export function EditEdgeDialog({
  open,
  onOpenChange,
  tenant,
  edge,
  sourceNode,
  targetNode,
  onUpdated,
  onDeleted,
}: EditEdgeDialogProps) {
  const [properties, setProperties] = React.useState<PropertyRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    setProperties([]);
    setError(null);
    setConfirmDelete(false);
  }, [edge]);

  const addProperty = () => setProperties((p) => [...p, { key: "", value: "" }]);
  const removeProperty = (idx: number) => setProperties((p) => p.filter((_, i) => i !== idx));
  const updateProperty = (idx: number, field: "key" | "value", val: string) => {
    setProperties((p) => p.map((row, i) => (i === idx ? { ...row, [field]: val } : row)));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const props: Record<string, string> = {};
      for (const row of properties) {
        if (row.key.trim()) props[row.key.trim()] = row.value;
      }

      await upsertEdge(tenant, {
        fromNodeId: edge.source,
        toNodeId: edge.target,
        relationshipType: edge.type,
        ...(Object.keys(props).length > 0 ? { properties: props } : {}),
      });

      onOpenChange(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update relationship");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    try {
      await deleteEdge(tenant, {
        fromNodeId: edge.source,
        toNodeId: edge.target,
        edgeType: edge.type,
      });

      onOpenChange(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete relationship");
    } finally {
      setDeleting(false);
    }
  };

  const sourceName = sourceNode?.displayName ?? edge.source;
  const targetName = targetNode?.displayName ?? edge.target;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <form onSubmit={handleSave}>
          <DialogHeader>
            <DialogTitle>Edit relationship</DialogTitle>
            <DialogDescription>
              {sourceName} &rarr; <span className="font-mono text-xs">{edge.type}</span> &rarr; {targetName}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="mt-4 gap-4">
            {/* Relationship type (read-only — can't change in place) */}
            <div className="space-y-1.5">
              <Label>Relationship type</Label>
              <Input value={edge.type} disabled className="font-mono" />
              <p className="text-xs text-muted-foreground">
                Type cannot be changed. Delete and recreate to change it.
              </p>
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
              {properties.length > 0 ? (
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
              ) : (
                <p className="text-xs text-muted-foreground">No properties. Add one above.</p>
              )}
            </div>

            {/* Delete section */}
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              {confirmDelete ? (
                <div className="space-y-2">
                  <p className="text-sm text-destructive">
                    This will permanently remove this relationship. Are you sure?
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleDelete}
                      disabled={deleting}
                    >
                      {deleting && <Loader2 className="mr-2 size-3.5 animate-spin" />}
                      Confirm delete
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="mr-1.5 size-3.5" />
                  Delete this relationship
                </Button>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogPanel>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting || deleting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || deleting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save properties
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
