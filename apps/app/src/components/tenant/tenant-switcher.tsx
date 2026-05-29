"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, Plus, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export interface TenantOption {
  publicId: string;
  slug: string;
  name: string;
}

export function TenantSwitcher({ current, tenants }: { current: TenantOption; tenants: TenantOption[] }) {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="glass" size="sm" className="gap-2">
          <span className="font-semibold">{current.name}</span>
          <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {tenants.map((t) => (
          <DropdownMenuItem key={t.publicId} onSelect={() => router.push(`/${t.slug}`)}>
            <span className="flex-1">{t.name}</span>
            {t.publicId === current.publicId ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/new-tenant" className="flex items-center gap-2">
            <Plus className="h-3.5 w-3.5" /> New organization
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
