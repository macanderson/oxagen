"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SchemaItem } from "./types";
import type { SchemaToggleOutput } from "./schema-service";

interface SchemaListProps {
  schemas: SchemaItem[];
  onToggle: (schemaName: string, enabled: boolean) => Promise<SchemaToggleOutput>;
  onSelect: (schemaName: string) => void;
  onReconcile: (schemaName: string) => void;
  selectedSchemaName: string | null;
  isAdmin: boolean;
}

const SOURCE_BADGE: Record<SchemaItem["source"], { label: string; className: string }> = {
  connector: { label: "Connector", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" },
  user: { label: "User", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" },
  recommended: { label: "Recommended", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" },
};

export function SchemaList({
  schemas,
  onToggle,
  onSelect,
  onReconcile,
  selectedSchemaName,
  isAdmin,
}: SchemaListProps) {
  const [togglingSchema, setTogglingSchema] = React.useState<string | null>(null);
  const [reconcileSchema, setReconcileSchema] = React.useState<string | null>(null);

  const handleToggle = async (schemaName: string, enabled: boolean) => {
    setTogglingSchema(schemaName);
    try {
      const result = await onToggle(schemaName, enabled);
      if (result.reconcileRecommended) {
        setReconcileSchema(schemaName);
      }
    } finally {
      setTogglingSchema(null);
    }
  };

  if (schemas.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-muted-foreground">No schemas defined yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {reconcileSchema && (
        <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10">
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <AlertDescription className="flex items-center justify-between">
            <span className="text-amber-800 dark:text-amber-300 text-sm">
              Schema changes detected. Consider running reconciliation to re-label existing nodes.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-4 shrink-0 border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300"
              onClick={() => {
                onReconcile(reconcileSchema);
                setReconcileSchema(null);
              }}
            >
              Reconcile
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="rounded-xl border border-border overflow-hidden">
        {schemas.map((schema, idx) => {
          const sourceBadge = SOURCE_BADGE[schema.source];
          const isSelected = selectedSchemaName === schema.schemaName;
          const isToggling = togglingSchema === schema.schemaName;
          const canToggle = isAdmin && !isToggling;

          return (
            <div
              key={schema.schemaName}
              className={cn(
                "flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors",
                idx > 0 && "border-t border-border",
                isSelected && "bg-muted/60",
              )}
              onClick={() => onSelect(schema.schemaName)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{schema.displayName}</span>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                        sourceBadge.className,
                      )}
                    >
                      {sourceBadge.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {schema.labels.length} label{schema.labels.length !== 1 ? "s" : ""}
                    {" · "}
                    {schema.relationshipTypes.length} relationship type
                    {schema.relationshipTypes.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0 ml-4">
                <Badge
                  variant={schema.enabled ? "default" : "secondary"}
                  className="text-xs"
                >
                  {schema.enabled ? "Active" : "Inactive"}
                </Badge>
                <div
                  className="flex flex-col gap-0.5"
                  onClick={(e) => e.stopPropagation()}
                  title={
                    !isAdmin
                      ? "Only admins can toggle schemas"
                      : schema.enabled
                        ? "Deactivating is non-destructive. Existing data is not changed."
                        : "Activating auto-publishes and pins this schema — ready for use."
                  }
                >
                  <Switch
                    checked={schema.enabled}
                    onCheckedChange={(checked) => void handleToggle(schema.schemaName, checked)}
                    disabled={!canToggle}
                    aria-label={schema.enabled ? "Deactivate schema" : "Activate schema"}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
