"use client";
/**
 * new-automation-button.tsx — the list-header primary action. Owns the create
 * dialog's open state so the server page can slot a single client entry point
 * into PageHeader's `actions`.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NewAutomationDialog } from "./new-automation-dialog";

export interface NewAutomationButtonProps {
  /**
   * Overrides the default `new-automation` testid. The page header and the
   * table's empty state both render this button, and on an empty workspace
   * the two instances coexist - a shared testid made every e2e locator a
   * strict-mode violation, so the second render site names itself.
   */
  testId?: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function NewAutomationButton({
  orgSlug,
  workspaceSlug,
  testId = "new-automation",
}: NewAutomationButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid={testId}>
        <Plus className="size-4" /> New automation
      </Button>
      <NewAutomationDialog
        open={open}
        onOpenChange={setOpen}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </>
  );
}
