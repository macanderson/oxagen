"use client";
/**
 * enable-confirm-dialog.tsx — the human activation gate for an automation.
 *
 * Enabling is the ONLY path from "configured" to "live", and the governance
 * rule is that it must cross an explicit human confirmation (an automation
 * created by an AI agent is forced to enabled:false; only a direct human action
 * against automation.enable flips it live). This dialog IS that gate — a plain
 * controlled Dialog rendered only from human-driven surfaces (the list table
 * and the editor header), never from an agent-rendered component.
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

export interface EnableConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name of the automation being enabled, shown in the confirmation copy. */
  automationName: string;
  /** Async confirm handler — should resolve once the enable action completes. */
  onConfirm: () => Promise<void>;
}

export function EnableConfirmDialog({
  open,
  onOpenChange,
  automationName,
  onConfirm,
}: EnableConfirmDialogProps) {
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
    <Dialog
      open={open}
      onOpenChange={(next) => (!pending ? onOpenChange(next) : undefined)}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
            Enable this automation?
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">
              {automationName}
            </span>{" "}
            will start firing live on its configured trigger. Enabling is a
            deliberate human action — it cannot be done by an agent on your
            behalf. You can disable it again at any time.
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
            onClick={handleConfirm}
            disabled={pending}
            type="button"
            data-testid="confirm-enable"
          >
            {pending ? "Enabling…" : "Enable automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
