"use client";

/**
 * datasets-client.tsx — renders the workspace's eval datasets as a definition-list-based
 * item list (each dataset is an independent entity read across, not compared down columns).
 *
 * Write path: "New dataset" opens CreateDatasetDialog (manual or from-traces
 * creation), which calls router.refresh() on success so this server-fetched
 * list stays current. Read path: each dataset card is a `next/link` to the
 * full dataset detail page (route workspace.evals.dataset).
 */

import { useState } from "react";
import Link from "next/link";
import { FlaskConical, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardGrid } from "@/components/lists/card-grid";
import { ListToolbar } from "@/components/lists/list-toolbar";
import { ListPagination } from "@/components/lists/list-pagination";
import {
  useListControls,
  type ListSortOption,
} from "@/lib/lists/use-list-controls";
import { toCsv, downloadCsv, type CsvColumn } from "@/lib/lists/csv";
import { workspace } from "@/lib/routes";
import type { EvalDatasetListOutput } from "@oxagen/oxagen/contracts/eval.dataset.list";
import { CreateDatasetDialog } from "./create-dataset-dialog";

type Dataset = EvalDatasetListOutput["datasets"][number];

export interface DatasetsClientProps {
  datasets: Dataset[];
  orgSlug: string;
  workspaceSlug: string;
}

const SOURCE_LABEL: Record<Dataset["source"], string> = {
  manual: "Manual",
  traces: "From traces",
};

const SORT_OPTIONS: ListSortOption<Dataset>[] = [
  {
    id: "newest",
    label: "Newest",
    compare: (a, b) => b.createdAt.localeCompare(a.createdAt),
  },
  {
    id: "name",
    label: "Name A–Z",
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    id: "items",
    label: "Most items",
    compare: (a, b) => b.itemCount - a.itemCount,
  },
];

const CSV_COLUMNS: CsvColumn[] = [
  { key: "name", header: "Name" },
  { key: "slug", header: "Slug" },
  { key: "itemCount", header: "Items" },
  { key: "source", header: "Source" },
  { key: "createdAt", header: "Created" },
];

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

export function DatasetsClient({
  datasets,
  orgSlug,
  workspaceSlug,
}: DatasetsClientProps) {
  const controls = useListControls(datasets, {
    searchKeys: ["name", "slug", (d) => d.description ?? ""],
    sortOptions: SORT_OPTIONS,
    pageSize: 12,
  });

  const [createOpen, setCreateOpen] = useState(false);

  const newDatasetButton = (
    <Button
      type="button"
      size="sm"
      startIcon={<Plus aria-hidden="true" />}
      onClick={() => setCreateOpen(true)}
      data-testid="evals-new-dataset"
    >
      New dataset
    </Button>
  );

  if (datasets.length === 0) {
    return (
      <>
        <div
          className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-12 text-center"
          data-testid="evals-datasets-empty-state"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <FlaskConical
              className="h-6 w-6 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-foreground">
              No eval datasets yet
            </p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Create a dataset from manual examples or pull real inputs from
              historical traces, then run it against a target and grade the
              output with a judge model.
            </p>
          </div>
          {newDatasetButton}
        </div>

        <CreateDatasetDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="evals-datasets-grid">
      <ListToolbar
        query={controls.query}
        onQueryChange={controls.setQuery}
        searchPlaceholder="Search datasets…"
        sortOptions={SORT_OPTIONS}
        sortId={controls.sortId}
        onSortChange={controls.setSortId}
        onExport={() =>
          downloadCsv(
            "eval-datasets.csv",
            toCsv(
              CSV_COLUMNS,
              controls.allFilteredRows as unknown as Record<string, unknown>[],
            ),
          )
        }
      >
        {newDatasetButton}
      </ListToolbar>

      {controls.filteredTotal === 0 ? (
        <p className="rounded-md border bg-card py-10 text-center text-sm text-muted-foreground">
          No datasets match “{controls.query}”.
        </p>
      ) : (
        <CardGrid>
          {controls.pageRows.map((dataset) => (
            <Link
              key={dataset.datasetId}
              href={workspace.evals.dataset(
                { orgSlug, workspaceSlug },
                dataset.datasetId,
              )}
              className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-border-hover hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`dataset-card-${dataset.slug}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span
                  className="truncate font-medium text-foreground"
                  title={dataset.name}
                >
                  {dataset.name}
                </span>
                <Badge variant="outline" size="sm">
                  {SOURCE_LABEL[dataset.source]}
                </Badge>
              </div>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {dataset.slug}
              </span>
              {dataset.description ? (
                <p
                  className="line-clamp-2 text-xs text-muted-foreground"
                  title={dataset.description}
                >
                  {dataset.description}
                </p>
              ) : null}
              <div className="mt-auto flex items-center justify-between pt-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {dataset.itemCount} item{dataset.itemCount === 1 ? "" : "s"}
                </span>
                <span>{formatDate(dataset.createdAt)}</span>
              </div>
            </Link>
          ))}
        </CardGrid>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {controls.filteredTotal === controls.total
            ? `${controls.total} dataset${controls.total === 1 ? "" : "s"}`
            : `${controls.filteredTotal} of ${controls.total} datasets`}
        </p>
        <ListPagination
          page={controls.page}
          pageCount={controls.pageCount}
          onPageChange={controls.setPage}
        />
      </div>

      <CreateDatasetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
