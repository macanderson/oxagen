"use client";
import * as React from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  NewWorkspaceForm,
  type NewWorkspaceAction,
} from "./new-workspace-form";

export interface NewWorkspaceDialogProps {
  orgSlug: string;
  action: NewWorkspaceAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * NewWorkspaceDialog — controlled modal that wraps NewWorkspaceForm.
 *
 * The dialog is controlled externally (open / onOpenChange) so the caller
 * decides how to trigger it (switcher menu item, empty-state button, etc.).
 *
 * On success the form calls window.location.assign, which navigates away and
 * implicitly unmounts the dialog. The parent may also set open=false in response
 * to a success callback if it wires one; for now the hard navigation is the
 * single exit path (matching the new-workspace page behaviour).
 */
export function NewWorkspaceDialog({
  orgSlug,
  action,
  open,
  onOpenChange,
}: NewWorkspaceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create a workspace</DialogTitle>
          <DialogDescription>
            Workspaces scope the knowledge graph, data, and agents inside your
            organization. You&rsquo;ll be the workspace owner.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <NewWorkspaceForm orgSlug={orgSlug} action={action} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
