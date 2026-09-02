"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";

interface PinChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionId: string;
  versionNumber: number;
  onDispatch: (opts: { versionId: string; prune: boolean }) => Promise<void>;
}

export function PinChangeDialog({
  open,
  onOpenChange,
  versionId,
  versionNumber,
  onDispatch,
}: PinChangeDialogProps) {
  const [prune, setPrune] = React.useState(false);
  const [dispatching, setDispatching] = React.useState(false);

  const handleDispatch = async () => {
    setDispatching(true);
    try {
      await onDispatch({ versionId, prune });
      onOpenChange(false);
    } finally {
      setDispatching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Schema pinned — run reconciliation?</DialogTitle>
          <DialogDescription>
            Version {versionNumber} is now pinned. Worker agents can prune,
            improve, polish, and coerce existing graph nodes to match this
            schema.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-start gap-3">
            <Checkbox
              id="prune-toggle"
              checked={prune}
              onCheckedChange={(checked) => setPrune(Boolean(checked))}
              className="mt-0.5"
            />
            <Label
              htmlFor="prune-toggle"
              className="text-sm leading-snug cursor-pointer"
            >
              Prune properties not in the schema
            </Label>
          </div>
          {prune && (
            <Alert className="border-destructive/30 bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <AlertDescription className="text-destructive text-sm">
                Destructive: properties not in the schema will be permanently
                removed from existing nodes.
              </AlertDescription>
            </Alert>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={dispatching}
          >
            Skip
          </Button>
          <Button onClick={() => void handleDispatch()} disabled={dispatching}>
            {dispatching ? "Dispatching…" : "Run reconciliation"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
