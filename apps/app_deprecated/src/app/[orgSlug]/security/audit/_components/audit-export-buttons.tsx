"use client";

// audit-export-buttons.tsx — signed-export triggers for the audit viewer.
// Exports honor the in-page filters (it reads the live URL search params), and
// are disabled unless the caller is both on the Enterprise plan AND an
// owner/admin. The disabled state is cosmetic — the export route re-checks both
// gates server-side.

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { FileDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AuditExportButtonsProps {
  canExport: boolean;
  /** Reason shown on the disabled buttons' title (e.g. upgrade / role hint). */
  disabledReason: string;
}

export function AuditExportButtons({
  canExport,
  disabledReason,
}: AuditExportButtonsProps) {
  const pathname = usePathname();
  const params = useSearchParams();

  const hrefFor = (format: "ndjson" | "csv"): string => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("cursor"); // export the full filtered set, not one page
    sp.set("format", format);
    return `${pathname}/export?${sp.toString()}`;
  };

  if (!canExport) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled title={disabledReason}>
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Export NDJSON
        </Button>
        <Button variant="outline" size="sm" disabled title={disabledReason}>
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Export CSV
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        render={<a href={hrefFor("ndjson")} />}
      >
        <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
        Export NDJSON
      </Button>
      <Button variant="outline" size="sm" render={<a href={hrefFor("csv")} />}>
        <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
        Export CSV
      </Button>
    </div>
  );
}
