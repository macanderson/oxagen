"use client";
/**
 * RenameDialog — inline title editor opened from a conversation's action menu.
 * Reversible, low-risk, so no destructive styling; Enter submits.
 */
import { useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTitle: string;
  pending?: boolean;
  onSubmit: (title: string) => void;
}

export function RenameDialog({
  open,
  onOpenChange,
  initialTitle,
  pending = false,
  onSubmit,
}: RenameDialogProps) {
  const [value, setValue] = useState(initialTitle);

  // Re-seed the field on each open transition (the row may differ, or the user
  // may have typed then cancelled). "Adjust state during render" pattern, not
  // an effect — satisfies the React Compiler lint.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initialTitle);
  }

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  function submit() {
    if (!canSubmit) return;
    onSubmit(trimmed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          maxLength={200}
          placeholder="Conversation title"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
