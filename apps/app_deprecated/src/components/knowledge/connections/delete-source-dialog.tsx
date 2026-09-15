"use client";

/**
 * delete-source-dialog.tsx — Destructive confirmation for removing a source
 * connection from the Knowledge → Sources tab.
 *
 * Surfaces the `connection.delete` capability (DELETE /connections/:id?mode=),
 * which queues an async Inngest job. The `mode` query param maps directly to
 * the radio choice:
 *   - connection_only → revoke auth + stop ingestion, KEEP every node/edge
 *     already stamped with this connection in the knowledge graph.
 *   - full            → also DETACH DELETE every :EntityNode stamped with this
 *     connectionId (cross-source aliases are promoted first, so shared entities
 *     survive). This is the "delete all nodes and edges" path.
 *
 * `data_only` (keep the connection, wipe its graph) is intentionally not offered
 * here — this dialog is about removing the *connection*; a pure re-ingest belongs
 * to a separate "resync from scratch" affordance.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, Radio } from "@/components/ui/radio-group";
import { useToast } from "@/components/ui/toast";
import { cn } from "@oxagen/ui";

const API_BASE = "/api";

type DeleteMode = "connection_only" | "full";

export interface DeleteSourceTarget {
  publicId: string;
  displayName: string;
  entityCount: number;
}

export interface DeleteSourceDialogProps {
  open: boolean;
  onClose: () => void;
  orgSlug: string;
  workspaceSlug: string;
  /** The connection being deleted. `null` while no row is targeted. */
  target: DeleteSourceTarget | null;
}

interface ModeOption {
  value: DeleteMode;
  label: string;
  description: string;
}

export function DeleteSourceDialog({
  open,
  onClose,
  orgSlug,
  workspaceSlug,
  target,
}: DeleteSourceDialogProps) {
  const router = useRouter();
  const { add: addToast } = useToast();
  const [mode, setMode] = React.useState<DeleteMode>("full");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset transient state whenever a new target is opened.
  React.useEffect(() => {
    if (open) {
      setMode("full");
      setError(null);
      setSubmitting(false);
    }
  }, [open, target?.publicId]);

  const recordCount = target?.entityCount ?? 0;
  const modeOptions: ModeOption[] = [
    {
      value: "full",
      label:
        recordCount > 0
          ? `Delete the connection and all ${recordCount.toLocaleString()} ingested records`
          : "Delete the connection and all ingested records",
      description:
        "Removes the connection and DETACH DELETEs every knowledge-graph node and edge stamped with this source. Entities also seen by other sources are preserved.",
    },
    {
      value: "connection_only",
      label: "Delete the connection only — keep ingested knowledge",
      description:
        "Revokes access and stops syncing, but leaves every node and edge already in the graph intact.",
    },
  ];

  const handleConfirm = React.useCallback(async () => {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/${target.publicId}?mode=${mode}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed (${res.status})`);
      }
      addToast({
        title: "Source deletion started",
        description:
          mode === "full"
            ? `"${target.displayName}" and its graph data are being removed.`
            : `"${target.displayName}" was disconnected. Ingested knowledge was kept.`,
        type: "success",
      });
      onClose();
      // Reflect the new "deleting"/removed status in the server-rendered list.
      router.refresh();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Failed to delete source";
      setError(message);
      addToast({ title: "Delete failed", description: message, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }, [target, orgSlug, workspaceSlug, mode, addToast, onClose, router]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogPopup className="max-w-lg" data-testid="delete-source-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle
              className="h-4 w-4 text-destructive"
              aria-hidden="true"
            />
            Delete source
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <>
                You&apos;re about to delete{" "}
                <span className="font-medium text-foreground">
                  {target.displayName}
                </span>
                . Choose what happens to the knowledge it ingested. This cannot
                be undone.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as DeleteMode)}
            className="gap-2"
          >
            {modeOptions.map((opt) => (
              <label
                key={opt.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                  mode === opt.value
                    ? opt.value === "full"
                      ? "border-destructive bg-destructive/5"
                      : "border-primary bg-primary/5"
                    : "border-border/60 hover:border-border hover:bg-muted/20",
                )}
                data-testid={`delete-mode-${opt.value}`}
              >
                <Radio value={opt.value} className="mt-0.5 shrink-0" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {opt.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                </div>
              </label>
            ))}
          </RadioGroup>

          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={submitting || !target}
            data-testid="confirm-delete-source-btn"
          >
            {submitting && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            )}
            {mode === "full" ? "Delete source & data" : "Delete source"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
