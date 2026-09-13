"use client";
/**
 * secret-dialog.tsx — API-key / static-secret entry for a secret-auth MCP server.
 *
 * The secret-auth counterpart to authenticate-dialog.tsx (OAuth). Servers like
 * Stripe authenticate with a static API key rather than an OAuth consent flow,
 * so there is nowhere to redirect the user — they paste the key here and it is
 * stored envelope-encrypted (set_plugin_secret → mcp.credentials.secret_enc).
 * On success the server flips to Connected and its tools become usable.
 *
 * The key is write-only: it is never rendered back, and the field is masked.
 */
import * as React from "react";
import { KeyRound } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
  orgListingId: string;
  /** Human-readable server name, e.g. "Stripe". */
  serverTitle: string;
  /** Persists the entered secret (server action). */
  saveAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
    secret: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Called after a successful save so the parent can refresh the row status. */
  onSaved?: () => void;
}

export function SecretDialog({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  orgListingId,
  serverTitle,
  saveAction,
  onSaved,
}: SecretDialogProps) {
  const [secret, setSecret] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret.trim()) {
      setError("Enter the API key or token.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await saveAction({
      orgSlug,
      workspaceSlug,
      orgListingId,
      secret: secret.trim(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Saving the key failed.");
      return;
    }
    setSecret("");
    onOpenChange(false);
    onSaved?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup data-testid="mcp-secret-dialog">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-warning" aria-hidden="true" />
              Add {serverTitle} API key
            </DialogTitle>
            <DialogDescription>
              {serverTitle} authenticates with a static API key. Paste it below
              — it&apos;s stored encrypted and never shown again.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1">
              <Label htmlFor="mcp-secret-input" className="text-xs">
                API key or token
              </Label>
              <Input
                id="mcp-secret-input"
                type="password"
                autoComplete="off"
                placeholder="sk_live_…"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                disabled={pending}
                data-testid="mcp-secret-input"
              />
              {error && (
                <p className="mt-1 text-xs text-destructive">{error}</p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="mcp-secret-cancel"
                />
              }
            >
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={pending}
              data-testid="mcp-secret-save"
            >
              {pending ? "Saving…" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
