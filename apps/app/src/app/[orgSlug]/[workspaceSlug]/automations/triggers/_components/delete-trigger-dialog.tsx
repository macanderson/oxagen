"use client";
/**
 * delete-trigger-dialog.tsx — confirm dialog before soft-deleting an agent
 * trigger. Mirrors automations/_components/enable-confirm-dialog.tsx's shape
 * (a plain controlled Dialog gating a destructive/irreversible-looking action
 * behind an explicit human confirmation).
 */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface DeleteTriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  triggerType: string;
  onConfirm: () => Promise<void>;
}

export function DeleteTriggerDialog({
  open,
  onOpenChange,
  agentName,
  triggerType,
  onConfirm,
}: DeleteTriggerDialogProps) {
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!pending ? onOpenChange(next) : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-error" aria-hidden="true" />
            Delete this trigger?
          </DialogTitle>
          <DialogDescription>
            The <span className="font-medium text-foreground">{triggerType}</span> trigger on{" "}
            <span className="font-medium text-foreground">{agentName}</span> will stop firing.
            This soft-deletes the trigger — the audit record is preserved.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            type="button"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
            type="button"
            data-testid="confirm-delete-trigger"
          >
            {pending ? "Deleting…" : "Delete trigger"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
