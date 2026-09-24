"use client";
// The page's name for the route error boundaries (audit-prompt check 22). The
// shell frame wraps every page it draws in this provider, above the `[org]`
// and `[org]/[ws]` `error.tsx` boundaries, so a page that throws is titled
// "Fleet could not be loaded" as the mock's `errorState("Fleet", …)` is. The
// name is read off the path the way the sidebar lights its current item.
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { RoutePageName } from "@/ui/page-states";
import { currentNavKey } from "./nav";

export function ShellRoutePageName({ children }: { children: ReactNode }) {
  const t = useTranslations("shell.nav");
  const key = currentNavKey(usePathname());
  return (
    <RoutePageName value={key === null ? null : t(key)}>
      {children}
    </RoutePageName>
  );
}
