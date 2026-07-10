"use client";

/**
 * datasets-client.tsx — renders the workspace's eval datasets as a definition-list-based
 * item list (each dataset is an independent entity read across, not compared down columns).
 *
 * Read-only v1: no create/delete affordances yet (those are
 * eval.dataset.create / eval.dataset.from_traces, not wired to this UI).
 * Empty state handles both "no datasets yet" and an upstream handler failure
 * (datasets-section.tsx swallows errors and passes an empty array).
 */

import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EvalDatasetListOutput } from "@oxagen/oxagen/contracts/eval.dataset.list";

type Dataset = EvalDatasetListOutput["datasets"][number];

export interface DatasetsClientProps {
  datasets: Dataset[];
}

const SOURCE_LABEL: Record<Dataset["source"], string> = {
  manual: "Manual",
  traces: "From traces",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function DatasetsClient({ datasets }: DatasetsClientProps) {
  if (datasets.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-12 text-center"
        data-testid="evals-datasets-empty-state"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <FlaskConical className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-foreground">No eval datasets yet</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Create a dataset from manual examples or pull real inputs from historical traces, then
            run it against a target and grade the output with a judge model.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul
      className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60"
      data-testid="evals-datasets-table"
    >
      {datasets.map((dataset) => (
        <li
          key={dataset.datasetId}
          className="flex flex-col gap-3 px-4 py-2 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-6"
        >
          {/* identity: name + description */}
          <div className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground" title={dataset.name}>
              {dataset.name}
            </span>
            {dataset.description && (
              <span className="block truncate text-xs text-muted-foreground" title={dataset.description}>
                {dataset.description}
              </span>
            )}
          </div>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Slug</dt>
              <dd className="mt-0.5 font-mono text-xs text-muted-foreground">{dataset.slug}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Items</dt>
              <dd className="mt-0.5 tabular-nums text-sm text-foreground">{dataset.itemCount}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Source</dt>
              <dd className="mt-0.5">
                <Badge variant="outline" size="sm">
                  {SOURCE_LABEL[dataset.source]}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Created</dt>
              <dd className="mt-0.5 whitespace-nowrap text-xs text-muted-foreground">
                {formatDate(dataset.createdAt)}
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
