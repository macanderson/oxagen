"use client";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Check, Plus } from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
} from "@/components/ui/menu";
import { Button } from "@/components/ui/button";

export interface WorkspaceOption {
  publicId: string;
  slug: string;
  name: string;
}

export function WorkspaceSwitcher({
  orgSlug,
  current,
  workspaces,
}: {
  orgSlug: string;
  current: WorkspaceOption;
  workspaces: WorkspaceOption[];
}) {
  const router = useRouter();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" className="gap-2" />}>
        <span className="truncate">{current.name}</span>
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
            {w.publicId === current.publicId ? <Check className="h-3.5 w-3.5" /> : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => router.push(`/${orgSlug}/new-workspace`)}>
          <Plus className="h-3.5 w-3.5" /> New workspace
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
