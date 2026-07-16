"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Check, Plus, Settings } from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
} from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { NewWorkspaceDialog } from "./new-workspace-dialog";
import type { NewWorkspaceAction } from "./new-workspace-form";

export interface WorkspaceOption {
  publicId: string;
  slug: string;
  name: string;
}

export interface WorkspaceSwitcherProps {
  orgSlug: string;
  current: WorkspaceOption;
  workspaces: WorkspaceOption[];
  /**
   * When provided, clicking "New workspace" opens the inline creation dialog
   * instead of navigating to the /new-workspace route. Pass a bound server
   * action: `createWorkspaceAction.bind(null, orgSlug)`.
   */
  createWorkspaceAction?: NewWorkspaceAction;
}

export function WorkspaceSwitcher({
  orgSlug,
  current,
  workspaces,
  createWorkspaceAction,
}: WorkspaceSwitcherProps) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              // min-w-0 lets this flex item shrink below its content width so
              // the inner `truncate` span can actually truncate; without it the
              // header's right cluster paints over the overflowing label on
              // narrow (375px) viewports.
              className="min-w-0 gap-2 max-md:min-h-11"
            />
          }
        >
          {/* min-w floor keeps at least a few characters legible when the
              header squeezes; below that the shell clips rather than letting
              siblings paint over the label. */}
          <span className="min-w-12 truncate">{current.name}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-56">
          <MenuGroupLabel>Workspaces</MenuGroupLabel>
          {workspaces.map((w) => (
            <MenuItem
              key={w.publicId}
              onClick={() => router.push(`/${orgSlug}/${w.slug}`)}
            >
              <span className="flex-1">{w.name}</span>
              {w.publicId === current.publicId ? (
                <Check className="h-3.5 w-3.5" />
              ) : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          {/* Settings for the active workspace */}
          <MenuItem
            onClick={() => router.push(`/${orgSlug}/${current.slug}/settings`)}
          >
            <Settings className="h-3.5 w-3.5" /> Workspace settings
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              if (createWorkspaceAction) {
                setDialogOpen(true);
              } else {
                router.push(`/${orgSlug}/new-workspace`);
              }
            }}
          >
            <Plus className="h-3.5 w-3.5" /> New workspace
          </MenuItem>
        </MenuPopup>
      </Menu>

      {createWorkspaceAction ? (
        <NewWorkspaceDialog
          orgSlug={orgSlug}
          action={createWorkspaceAction}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      ) : null}
    </>
  );
}
