"use client";
/**
 * authenticate-dialog.tsx — post-install OAuth prompt.
 *
 * Shown immediately after an OAuth-protected MCP server is installed: the
 * install itself succeeded (success toast already fired), but the server is
 * unusable until the user authenticates with the provider. "Authenticate"
 * performs a full-page navigation into the authorize route, which redirects
 * to the provider's consent screen (where fine-grained permissions are
 * granted) and returns to the MCP Servers page.
 */
import * as React from "react";
import { ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { mcpAuthorizeUrl } from "@/lib/mcp-oauth/authorize-url";

export interface AuthenticateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
  orgListingId: string;
  /** Human-readable server name, e.g. "Stripe". */
  serverTitle: string;
  /** Path to land on after the OAuth flow (defaults to the MCP Servers page). */
  returnTo?: string;
}

export function AuthenticateDialog({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  orgListingId,
  serverTitle,
  returnTo,
}: AuthenticateDialogProps) {
  const [redirecting, setRedirecting] = React.useState(false);

  const handleAuthenticate = () => {
    setRedirecting(true);
    window.location.assign(
      mcpAuthorizeUrl({ orgSlug, workspaceSlug, orgListingId, returnTo }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup data-testid="mcp-authenticate-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />
            Authentication required
          </DialogTitle>
          <DialogDescription>
            {serverTitle} was installed successfully, but it will not work until
            you authenticate with your {serverTitle} credentials.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            You&apos;ll be sent to {serverTitle} to sign in and choose exactly
            which permissions Oxagen&apos;s agents get. When you finish,
            you&apos;ll come back here and the server will show as connected.
          </p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="ghost" data-testid="mcp-authenticate-later" />
            }
          >
            Later
          </DialogClose>
          <Button
            onClick={handleAuthenticate}
            disabled={redirecting}
            data-testid="mcp-authenticate-now"
          >
            {redirecting ? "Redirecting…" : `Authenticate with ${serverTitle}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
