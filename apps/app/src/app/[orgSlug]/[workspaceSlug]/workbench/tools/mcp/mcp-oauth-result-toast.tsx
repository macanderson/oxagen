"use client";
/**
 * mcp-oauth-result-toast.tsx — surfaces the OAuth flow outcome.
 *
 * The authorize/callback routes land back on this page with
 * ?mcp=connected|already-connected|error (&listing=<orgListingId>
 * &reason=<code>). This component fires the matching toast exactly once,
 * strips the params from the URL, and refreshes the server-rendered install
 * list so the new credential status shows without a manual reload.
 */
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/toast";

/**
 * Reason code (set by the authorize route's classifyAuthError) → actionable
 * copy. Pure and exported for unit tests.
 */
export function oauthErrorDescription(
  reason: string | null,
  name: string,
): string {
  switch (reason) {
    case "dcr_unsupported":
      return (
        `${name} doesn't support automatic client registration. ` +
        "A platform administrator must configure a pre-registered OAuth client " +
        "for this provider (MCP_OAUTH_PREREGISTERED_CLIENTS) before it can be connected."
      );
    case "provider_error":
      return (
        `${name}'s authorization server returned an unexpected response. ` +
        "Check that the endpoint URL is the server's real MCP endpoint and that it supports OAuth."
      );
    case "no_redirect":
      return (
        `${name}'s authorization server did not provide a sign-in page to redirect to. ` +
        "The server may not support OAuth — check its endpoint URL."
      );
    default:
      return `${name} could not be connected. Try authenticating again.`;
  }
}

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
  const reason = searchParams.get("reason");

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
        description: oauthErrorDescription(reason, name),
        type: "error",
      });
    }

    // Strip the one-shot params, then refresh so the server-rendered install
    // list re-reads credential statuses.
    router.replace(pathname, { scroll: false });
    router.refresh();
  }, [result, listingId, reason, serverNames, toast, router, pathname]);

  return null;
}
