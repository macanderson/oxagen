"use client";
// The page's name for the route error boundaries (audit-prompt check 22). The
// shell frame wraps every page it draws in this provider, above the `[org]`
// and `[org]/[ws]` `error.tsx` boundaries, so a page that throws is titled
// "Fleet could not be loaded" as the mock's `errorState("Fleet", …)` is.
// It hands the boundary a resolver rather than a name: reading the path here,
// above every page and outside any <Suspense>, stops Next.js prerendering a
// static route. The boundary reads the path itself, only once a page has
// thrown, and names it the way the sidebar lights its current item.
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback } from "react";
import { RoutePageName } from "@/ui/page-states";
import { currentNavKey } from "./nav";

export function ShellRoutePageName({ children }: { children: ReactNode }) {
  const t = useTranslations("shell.nav");
  const nameOf = useCallback(
    (pathname: string) => {
      const key = currentNavKey(pathname);
      return key === null ? null : t(key);
    },
    [t],
  );
  return <RoutePageName value={nameOf}>{children}</RoutePageName>;
}
