"use client";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Plus, Check } from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
} from "@/components/ui/menu";
import { Button } from "@/components/ui/button";

export interface OrgOption {
  publicId: string;
  slug: string;
  name: string;
}

export function OrgSwitcher({ current, organizations }: { current: OrgOption; organizations: OrgOption[] }) {
  const router = useRouter();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" className="gap-2" />}>
        <span className="truncate font-medium">{current.name}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-56">
        <MenuGroupLabel>Organizations</MenuGroupLabel>
        {organizations.map((t) => (
          <MenuItem key={t.publicId} onClick={() => router.push(`/${t.slug}`)}>
            <span className="flex-1 truncate">{t.name}</span>
            {t.publicId === current.publicId ? <Check className="h-3.5 w-3.5" /> : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => router.push("/new-organization")}>
          <Plus className="h-3.5 w-3.5" /> New organization
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
