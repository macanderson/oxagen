"use client";
/**
 * editor-header.tsx — the automation editor's header: inline-editable name +
 * description, trigger-type badge, the enabled toggle (behind the human confirm
 * gate on enable), and Trigger-now. All mutations gate on `canManage`.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { workspace } from "@/lib/routes";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";
import { EnableConfirmDialog } from "../../_components/enable-confirm-dialog";
import { TriggerNowDialog } from "../../_components/trigger-now-dialog";
import {
  updateAutomationAction,
  enableAutomationAction,
  disableAutomationAction,
  triggerAutomationAction,
} from "../../actions";

const TRIGGER_LABEL: Record<string, string> = {
  event: "Graph event",
  schedule: "Schedule",
  api: "API / manual",
};

export interface EditorHeaderProps {
  orgSlug: string;
  workspaceSlug: string;
  automation: AutomationGetOutput;
  canManage: boolean;
}

export function EditorHeader({
  orgSlug,
  workspaceSlug,
  automation,
  canManage,
}: EditorHeaderProps) {
  const router = useRouter();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(automation.name);
  const [description, setDescription] = useState(automation.description ?? "");
  const [busy, setBusy] = useState(false);
  const [enableOpen, setEnableOpen] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);

  const enabled = automation.enabled;

  async function handleSaveDetails() {
    if (name.trim().length === 0) {
      toast.add({ title: "Name is required", type: "error" });
      return;
    }
    setBusy(true);
    // finally: `busy` disables Save, Cancel and the enabled switch, so a
    // rejected action without this would freeze the header until a reload.
    try {
      const res = await updateAutomationAction({
        orgSlug,
        workspaceSlug,
        automationId: automation.automation_id,
        name: name.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
      });
      if (res.ok) {
        toast.add({ title: "Automation updated", type: "success" });
        setEditing(false);
        router.refresh();
      } else {
        toast.add({
          title: "Couldn't save",
          description: res.error,
          type: "error",
        });
      }
    } catch {
      toast.add({ title: "Couldn't save", type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    // finally: `busy` disables the enabled switch — see handleSaveDetails.
    try {
      const res = await disableAutomationAction({
        orgSlug,
        workspaceSlug,
        automationId: automation.automation_id,
      });
      if (res.ok) {
        toast.add({ title: "Automation disabled", type: "success" });
        router.refresh();
      } else {
        toast.add({
          title: "Couldn't disable",
          description: res.error,
          type: "error",
        });
      }
    } catch {
      toast.add({ title: "Couldn't disable", type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={workspace.automations.root({ orgSlug, workspaceSlug })}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All automations
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          {editing ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  data-testid="edit-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-description">Description</Label>
                <Textarea
                  id="edit-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  rows={2}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSaveDetails}
                  disabled={busy}
                  data-testid="save-details"
                >
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setName(automation.name);
                    setDescription(automation.description ?? "");
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                  {automation.name}
                </h1>
                <Badge variant="muted" size="sm">
                  {TRIGGER_LABEL[automation.triggerType] ??
                    automation.triggerType}
                </Badge>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit name and description"
                    onClick={() => setEditing(true)}
                    data-testid="edit-details"
                  >
                    <Pencil className="size-4" />
                  </Button>
                )}
              </div>
              {automation.description ? (
                <p className="text-sm text-muted-foreground">
                  {automation.description}
                </p>
              ) : (
                <p className="text-sm italic text-muted-foreground/70">
                  No description
                </p>
              )}
            </>
          )}
        </div>

        {/* Right rail: enable toggle + trigger-now */}
        <div className="flex shrink-0 items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              disabled={!canManage || busy}
              onCheckedChange={(next) => {
                if (next) {
                  setEnableOpen(true); // enable crosses the human gate
                } else {
                  void handleDisable();
                }
              }}
              aria-label={enabled ? "Disable automation" : "Enable automation"}
              data-testid="enabled-switch"
            />
            <span className="text-sm text-muted-foreground">
              {enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTriggerOpen(true)}
              data-testid="trigger-now"
            >
              <Play className="size-4" /> Trigger now
            </Button>
          )}
        </div>
      </div>

      <EnableConfirmDialog
        open={enableOpen}
        onOpenChange={setEnableOpen}
        automationName={automation.name}
        onConfirm={async () => {
          const res = await enableAutomationAction({
            orgSlug,
            workspaceSlug,
            automationId: automation.automation_id,
          });
          if (res.ok) {
            toast.add({
              title: "Automation enabled",
              description: `${automation.name} is now live.`,
              type: "success",
            });
            setEnableOpen(false);
            router.refresh();
          } else {
            toast.add({
              title: "Couldn't enable",
              description: res.error,
              type: "error",
            });
            setEnableOpen(false);
          }
        }}
      />

      <TriggerNowDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        automationName={automation.name}
        onTrigger={async (payload) => {
          const res = await triggerAutomationAction({
            orgSlug,
            workspaceSlug,
            automationId: automation.automation_id,
            payload,
          });
          if (res.ok) {
            router.refresh();
            return {
              ok: true,
              executionId: res.result.execution_id,
              status: res.result.status,
            };
          }
          return { ok: false, error: res.error };
        }}
      />
    </div>
  );
}
