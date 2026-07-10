"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SecretKeySummary } from "@/app/[orgSlug]/[workspaceSlug]/workbench/environments/actions";
import {
  buildManifestInput,
  validateManifestInput,
  type TemplateFormState,
} from "./manifest-form-state";
import { ManifestErrorList } from "./manifest-error-list";

/**
 * Live JSON serialization of the form above, validated through the same
 * `sandboxTemplateManifestSchema` export/import uses — updates on every
 * keystroke so "what will this actually export as" is never a guess.
 */
export function ManifestPreviewPanel({
  state,
  secretKeys,
  downloadSlug,
}: {
  state: TemplateFormState;
  secretKeys: SecretKeySummary[];
  downloadSlug: string;
}) {
  const [copied, setCopied] = useState(false);

  const { json, result } = useMemo(() => {
    const input = buildManifestInput(state, { secretKeys });
    return {
      json: JSON.stringify(input, null, 2),
      result: validateManifestInput(input),
    };
  }, [state, secretKeys]);

  const copy = () => {
    void navigator.clipboard
      .writeText(json)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable — the JSON is still selectable/visible below */
      });
  };

  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sandbox-template-${downloadSlug || "draft"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Live manifest v1 document for the form on the Configure tab.
        </p>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="outline"
            size="xs"
            className="max-md:h-11"
            onClick={copy}
            data-testid="manifest-preview-copy"
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="max-md:h-11"
            onClick={download}
            data-testid="manifest-preview-download"
          >
            Download
          </Button>
        </div>
      </div>
      {result.ok ? (
        <p className="text-xs text-success">Valid manifest v1 document.</p>
      ) : (
        <ManifestErrorList errors={result.errors} />
      )}
      <pre
        className="max-h-64 overflow-auto rounded-md border border-border/40 bg-muted/30 p-2 text-xs"
        data-testid="manifest-preview-json"
      >
        {json}
      </pre>
    </div>
  );
}
