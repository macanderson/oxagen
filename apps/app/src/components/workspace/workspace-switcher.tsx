"use client";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="glass" size="sm" className="gap-2">
          <span>{current.name}</span>
          <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.publicId}
            onSelect={() => router.push(`/${orgSlug}/${w.slug}`)}
          >
            <span className="flex-1">{w.name}</span>
            {w.publicId === current.publicId ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push(`/${orgSlug}/settings/members`)}>
          <Plus className="h-3.5 w-3.5" /> New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
