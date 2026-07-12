"use client";
/**
 * cancel-fanout-dialog.tsx — confirmation gate for cancelling an in-progress
 * subagent fan-out. Mirrors components/conversations/delete-confirm-dialog.tsx
 * (the house pattern for a destructive/irreversible action gate).
 */
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface CancelFanoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fanoutId: string;
  pending?: boolean;
  onConfirm: () => void;
}

export function CancelFanoutDialog({
  open,
  onOpenChange,
  fanoutId,
  pending = false,
  onConfirm,
}: CancelFanoutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm" data-testid="cancel-fanout-dialog">
        <DialogHeader>
          <DialogTitle>Cancel this fan-out?</DialogTitle>
          <DialogDescription>
            Every pending or running child of {fanoutId} will be stopped. Completed
            children keep their results — this cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-testid="cancel-fanout-dismiss"
          >
            Keep running
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
            data-testid="cancel-fanout-confirm"
          >
            {pending ? "Cancelling…" : "Cancel fan-out"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
