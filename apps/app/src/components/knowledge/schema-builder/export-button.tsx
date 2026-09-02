"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportSchema } from "./schema-service";
import type { TenantSlugs } from "./types";

interface ExportButtonProps {
  slugs: TenantSlugs;
  versionId?: string;
}

export function ExportButton({ slugs, versionId }: ExportButtonProps) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await exportSchema(slugs, { versionId });
      window.location.href = result.serveUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleExport()}
        disabled={loading}
        className="gap-1.5"
      >
        <Download className="h-3.5 w-3.5" />
        {loading ? "Exporting…" : "Export schema"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
