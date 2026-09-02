"use client";

/**
 * dataset-items-panel.tsx — the dataset item list + add-item form.
 *
 * Seeded from the RSC-provided first page of items (avoids a load flash), then
 * paginates further pages via getDatasetAction's cursor ("Load more"). The
 * add-item form sends a single-item batch through addDatasetItemAction and
 * refreshes the RSC fetch on success so the header item count stays current.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { EvalDatasetGetOutput } from "@oxagen/oxagen/contracts/eval.dataset.get";
import { getDatasetAction, addDatasetItemAction } from "../../actions";

type DatasetItem = EvalDatasetGetOutput["items"][number];

export interface DatasetItemsPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  datasetPublicId: string;
  itemCount: number;
  initialItems: DatasetItem[];
  initialCursor: string | null;
}

export function DatasetItemsPanel({
  orgSlug,
  workspaceSlug,
  datasetPublicId,
  itemCount,
  initialItems,
  initialCursor,
}: DatasetItemsPanelProps) {
  const router = useRouter();
  const { add: addToast } = useToast();

  const [items, setItems] = React.useState<DatasetItem[]>(initialItems);
  const [nextCursor, setNextCursor] = React.useState<string | null>(
    initialCursor,
  );
  const [loadingMore, setLoadingMore] = React.useState(false);

  const [itemInput, setItemInput] = React.useState("");
  const [itemExpected, setItemExpected] = React.useState("");
  const [addingItem, setAddingItem] = React.useState(false);
  const [addItemError, setAddItemError] = React.useState<string | null>(null);

  const loadMore = React.useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const result = await getDatasetAction({
        orgSlug,
        workspaceSlug,
        datasetPublicId,
        cursor: nextCursor,
      });
      if (result.ok) {
        setItems((prev) => [...prev, ...result.items]);
        setNextCursor(result.nextCursor);
      } else {
        addToast({
          title: "Failed to load items",
          description: result.error,
          type: "background",
        });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, orgSlug, workspaceSlug, datasetPublicId, addToast]);

  const handleAddItem: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    const trimmedInput = itemInput.trim();
    if (!trimmedInput) {
      setAddItemError("Input is required.");
      return;
    }

    setAddItemError(null);
    setAddingItem(true);
    try {
      const result = await addDatasetItemAction({
        orgSlug,
        workspaceSlug,
        datasetPublicId,
        input: trimmedInput,
        expectedOutput: itemExpected.trim() || undefined,
      });
      if (result.ok) {
        setItemInput("");
        setItemExpected("");
        addToast({ title: "Item added", type: "background" });
        // Reload the first page so the newly added item appears, and refresh
        // the RSC fetch so the header item count updates.
        const reloaded = await getDatasetAction({
          orgSlug,
          workspaceSlug,
          datasetPublicId,
        });
        if (reloaded.ok) {
          setItems(reloaded.items);
          setNextCursor(reloaded.nextCursor);
        }
        router.refresh();
      } else {
        setAddItemError(result.error);
        addToast({
          title: "Failed to add item",
          description: result.error,
          type: "background",
        });
      }
    } finally {
      setAddingItem(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border/60 p-4"
      data-testid="evals-dataset-items"
    >
      <h3 className="text-sm font-semibold text-foreground">
        Items ({itemCount.toLocaleString()})
      </h3>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No items yet — add one below.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.itemId}
              className="rounded-md border border-border/60 p-2.5 text-xs"
              data-testid="evals-dataset-item"
            >
              <p className="line-clamp-2 text-foreground">{item.input}</p>
              {item.expectedOutput && (
                <p className="mt-1 line-clamp-2 text-muted-foreground">
                  Expected: {item.expectedOutput}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="w-fit"
          data-testid="evals-items-load-more"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}

      <form
        onSubmit={handleAddItem}
        className="flex flex-col gap-2 border-t border-border/60 pt-4"
        aria-label="Add item"
      >
        <Label htmlFor="item-input">Input</Label>
        <Textarea
          id="item-input"
          value={itemInput}
          onChange={(e) => setItemInput(e.target.value)}
          rows={2}
          disabled={addingItem}
          placeholder="What is 2+2?"
        />
        <Label htmlFor="item-expected">Expected output (optional)</Label>
        <Textarea
          id="item-expected"
          value={itemExpected}
          onChange={(e) => setItemExpected(e.target.value)}
          rows={2}
          disabled={addingItem}
          placeholder="4"
        />
        {addItemError && (
          <p className="text-xs text-destructive" role="alert">
            {addItemError}
          </p>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={addingItem}
          className="w-fit"
          data-testid="evals-add-item-submit"
        >
          {addingItem ? "Adding…" : "Add item"}
        </Button>
      </form>
    </section>
  );
}
