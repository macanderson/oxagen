"use client";
/**
 * create-trigger-button.tsx — the Triggers board header's primary action.
 * Owns the create dialog's open state so the server page can slot a single
 * client entry point into AutomationsHeader's `actions`. The eligible agent
 * list (non-managed agents) is resolved once by the server page and passed
 * in — a single cheap agent.definition.list call, unlike the page's streamed
 * per-agent trigger fan-out.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentOption } from "@/lib/automations/triggers";
import { TriggerFormDialog } from "./trigger-form-dialog";

export interface CreateTriggerButtonProps {
  orgSlug: string;
  workspaceSlug: string;
  agents: AgentOption[];
}

export function CreateTriggerButton({ orgSlug, workspaceSlug, agents }: CreateTriggerButtonProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="new-trigger">
        <Plus className="size-4" /> New trigger
      </Button>
      <TriggerFormDialog
        mode="create"
        open={open}
        onOpenChange={setOpen}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        agents={agents}
        onCreated={() => router.refresh()}
      />
    </>
  );
}
