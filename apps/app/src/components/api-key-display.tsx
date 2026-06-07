"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

interface ApiKeyDisplayProps {
  keyId: string;
  publicId: string;
  name: string;
  rawKey: string;
  createdAt: string;
  expiresAt: string | null;
}

export function ApiKeyDisplay({ rawKey, name, createdAt, expiresAt }: ApiKeyDisplayProps) {
  const [copied, setCopied] = React.useState(false);
  const toast = useToast();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
      toast.add({
        title: "API key copied",
        description: "API key has been successfully copied to your clipboard.",
        type: "success",
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.add({
        title: "Failed to copy",
        description: "Could not copy the API key to clipboard.",
        type: "error",
      });
    }
  };

  const expiresDate = expiresAt ? new Date(expiresAt) : null;
  const createdDate = new Date(createdAt);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border/60 bg-card p-4">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">
          Created {createdDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          {expiresDate && ` • Expires ${expiresDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 overflow-hidden rounded-lg border border-border/40 bg-muted/50 p-3">
          <code className="break-all font-mono text-xs text-foreground">{rawKey}</code>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCopy}
          className="shrink-0"
          aria-label={copied ? "Copied" : "Copy API key"}
        >
          {copied ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="rounded-lg border border-amber-200/30 bg-amber-50/50 dark:bg-amber-950/20 p-3">
        <p className="text-xs text-amber-900 dark:text-amber-200">
          <strong>Save this key securely.</strong> You won't be able to see it again after you leave this page.
        </p>
      </div>
    </div>
  );
}
