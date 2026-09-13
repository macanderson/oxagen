import * as React from "react";

interface SchemaMutationCardProps {
  schemaName: string;
  labelName?: string;
  action: "add" | "update" | "remove";
  summary: string;
}

const ACTION_BADGE: Record<
  SchemaMutationCardProps["action"],
  { label: string; className: string }
> = {
  add: {
    label: "Add",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  },
  update: {
    label: "Update",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  remove: {
    label: "Remove",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  },
};

export default function SchemaMutationCard({
  schemaName,
  labelName,
  action,
  summary,
}: SchemaMutationCardProps) {
  const badge = ACTION_BADGE[action];
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {schemaName}
        </span>
        {labelName && (
          <>
            <span className="text-xs text-muted-foreground">/</span>
            <span className="font-mono text-xs">{labelName}</span>
          </>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{summary}</p>
    </div>
  );
}
