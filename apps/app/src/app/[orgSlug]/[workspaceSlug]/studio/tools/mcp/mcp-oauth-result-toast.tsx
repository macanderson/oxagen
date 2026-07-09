"use client";
/**
 * mcp-oauth-result-toast.tsx — surfaces the OAuth flow outcome.
 *
 * The authorize/callback routes land back on this page with
 * ?mcp=connected|already-connected|error (&listing=<orgListingId>). This
 * component fires the matching toast exactly once, strips the params from the
 * URL, and refreshes the server-rendered install list so the new credential
 * status shows without a manual reload.
 */
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/toast";

export function McpOauthResultToast({
  serverNames,
}: {
  /** orgListingId → display name, for a personalised toast. */
  serverNames: Record<string, string>;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const handled = React.useRef(false);

  const result = searchParams.get("mcp");
  const listingId = searchParams.get("listing");

  React.useEffect(() => {
    if (!result || handled.current) return;
    handled.current = true;

    const name = (listingId && serverNames[listingId]) || "The MCP server";
    if (result === "connected") {
      toast.add({
        title: `${name} connected`,
        description: "Authentication complete — your agents can use it now.",
        type: "success",
      });
    } else if (result === "already-connected") {
      toast.add({
        title: `${name} is already connected`,
        description: "No re-authentication was needed.",
        type: "info",
      });
    } else if (result === "error") {
      toast.add({
        title: "Authentication failed",
        description: `${name} could not be connected. Try authenticating again.`,
        type: "error",
      });
    }

    // Strip the one-shot params, then refresh so the server-rendered install
    // list re-reads credential statuses.
    router.replace(pathname, { scroll: false });
    router.refresh();
  }, [result, listingId, serverNames, toast, router, pathname]);

  return null;
}
