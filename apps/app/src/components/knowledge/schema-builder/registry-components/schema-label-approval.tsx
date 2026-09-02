import * as React from "react";
import { Button } from "@/components/ui/button";

interface SchemaLabelApprovalProps {
  schemaName: string;
  labelName: string;
  properties: Array<{ key: string; dataType: string }>;
}

export default function SchemaLabelApproval({
  schemaName,
  labelName,
  properties,
}: SchemaLabelApprovalProps) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-3">
      <div>
        <p className="font-medium text-sm">{labelName}</p>
        <p className="text-xs text-muted-foreground">Schema: {schemaName}</p>
      </div>
      {properties.length > 0 && (
        <div className="space-y-1">
          {properties.map((p) => (
            <div key={p.key} className="flex items-center gap-2 text-xs">
              <span className="font-mono">{p.key}</span>
              <span className="text-muted-foreground">({p.dataType})</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        {/* Buttons are display-only — approval flow is via the chat stream */}
        <Button size="sm" variant="default">
          Accept
        </Button>
        <Button size="sm" variant="outline">
          Dismiss
        </Button>
      </div>
    </div>
  );
}
