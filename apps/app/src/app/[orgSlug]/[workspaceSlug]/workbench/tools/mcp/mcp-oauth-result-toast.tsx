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
    case "not_permitted":
      return (
        "You don't have permission to connect MCP servers for this " +
        "organization. Ask an organization owner or admin to authenticate " +
        `${name}.`
      );
    case "not_found":
      return (
        `${name} could not be found in this workspace. It may have been ` +
        "uninstalled — try installing it again."
      );
    case "dcr_unsupported":
      // This provider (e.g. GitHub) can't self-register an OAuth client, so it
      // needs a one-time setup on the Oxagen platform side before sign-in works.
      // That's an Oxagen-operator action, NOT something the customer's own admin
      // can do — keep the internal env-var name out of this end-user copy (it's
      // logged server-side in the authorize route for operators instead).
      return (
        `${name} isn't available for OAuth sign-in yet. ` +
        "This provider needs a one-time setup on Oxagen before it can be connected — " +
        "please contact Oxagen support to enable it."
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
