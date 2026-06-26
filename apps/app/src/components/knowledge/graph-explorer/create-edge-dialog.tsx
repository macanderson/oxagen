/**
 * create-edge-dialog.tsx — dialog for creating a relationship between two nodes.
 *
 * Fields:
 *  - Source node (similarity-search typeahead)
 *  - Target node (similarity-search typeahead)
 *  - Relationship type (creatable select from workspace vocab)
 *  - Properties (optional key-value editor)
 *
 * The node search inputs use the `similaritySearch` API endpoint so the user
 * can find nodes by approximate name rather than needing the exact publicId.
 */

"use client";

import * as React from "react";
import { Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxPopup,
  ComboboxItem,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import { upsertEdge, similaritySearch, type TenantSlugs } from "./api-client";
import type { ExplorerSimilaritySearchPayload } from "./types";

export interface CreateEdgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: TenantSlugs;
  /** Workspace vocabulary: relationship types already in use. */
  relationshipTypes: string[];
  /** Pre-fill source or target when creating from a selected node. */
  prefillSource?: { nodeId: string; displayName: string } | null;
  prefillTarget?: { nodeId: string; displayName: string } | null;
  onCreated: (edgeId: string) => void;
}

interface PropertyRow {
  key: string;
  value: string;
}

type NodeHit = ExplorerSimilaritySearchPayload["nodes"][number];

export function CreateEdgeDialog({
  open,
  onOpenChange,
  tenant,
  relationshipTypes,
  prefillSource,
  prefillTarget,
  onCreated,
}: CreateEdgeDialogProps) {
  const [sourceNode, setSourceNode] = React.useState<NodeHit | null>(
    prefillSource ? { nodeId: prefillSource.nodeId, displayName: prefillSource.displayName, label: "", score: 1 } : null,
  );
  const [targetNode, setTargetNode] = React.useState<NodeHit | null>(
    prefillTarget ? { nodeId: prefillTarget.nodeId, displayName: prefillTarget.displayName, label: "", score: 1 } : null,
  );
  const [relType, setRelType] = React.useState<string | null>(null);
  const [customRelType, setCustomRelType] = React.useState("");
  const [properties, setProperties] = React.useState<PropertyRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Sync prefills when they change
  React.useEffect(() => {
    if (prefillSource) setSourceNode({ nodeId: prefillSource.nodeId, displayName: prefillSource.displayName, label: "", score: 1 });
  }, [prefillSource]);
  React.useEffect(() => {
    if (prefillTarget) setTargetNode({ nodeId: prefillTarget.nodeId, displayName: prefillTarget.displayName, label: "", score: 1 });
  }, [prefillTarget]);

  const effectiveRelType = relType ?? customRelType.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

  const reset = () => {
    setSourceNode(null);
    setTargetNode(null);
    setRelType(null);
    setCustomRelType("");
    setProperties([]);
    setError(null);
  };

  const addProperty = () => setProperties((p) => [...p, { key: "", value: "" }]);
  const removeProperty = (idx: number) => setProperties((p) => p.filter((_, i) => i !== idx));
  const updateProperty = (idx: number, field: "key" | "value", val: string) => {
    setProperties((p) => p.map((row, i) => (i === idx ? { ...row, [field]: val } : row)));
  };

  const canSubmit =
    sourceNode !== null &&
    targetNode !== null &&
    effectiveRelType.length > 0 &&
    /^[A-Z][A-Z0-9_]{0,62}$/.test(effectiveRelType) &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !sourceNode || !targetNode) return;

    setSubmitting(true);
    setError(null);

    try {
      const props: Record<string, string> = {};
      for (const row of properties) {
        if (row.key.trim()) props[row.key.trim()] = row.value;
      }

      const result = await upsertEdge(tenant, {
        fromNodeId: sourceNode.nodeId,
        toNodeId: targetNode.nodeId,
        relationshipType: effectiveRelType,
        ...(Object.keys(props).length > 0 ? { properties: props } : {}),
      });

      reset();
      onOpenChange(false);
      onCreated(result.edgeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create relationship");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create relationship</DialogTitle>
            <DialogDescription>
              Connect two nodes with a typed relationship.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="mt-4 gap-4">
            {/* Source node */}
            <div className="space-y-1.5">
              <Label>Source node</Label>
              <NodeSearchInput
                tenant={tenant}
                selected={sourceNode}
                onSelect={setSourceNode}
                placeholder="Search for source node…"
              />
            </div>

            {/* Target node */}
            <div className="space-y-1.5">
              <Label>Target node</Label>
              <NodeSearchInput
                tenant={tenant}
                selected={targetNode}
                onSelect={setTargetNode}
                placeholder="Search for target node…"
              />
            </div>

            {/* Relationship type */}
            <div className="space-y-1.5">
              <Label htmlFor="edge-type">Relationship type</Label>
              <Combobox value={relType} onValueChange={setRelType}>
                <ComboboxTrigger id="edge-type" className="w-full">
                  <ComboboxValue placeholder="Select or type a relationship…" />
                </ComboboxTrigger>
                <ComboboxPopup searchPlaceholder="Search types…">
                  {relationshipTypes.map((t) => (
                    <ComboboxItem key={t} value={t}>
                      {t}
                    </ComboboxItem>
                  ))}
                </ComboboxPopup>
              </Combobox>
              <Input
                placeholder="Or type a new type (UPPER_SNAKE_CASE)…"
                value={customRelType}
                onChange={(e) => {
                  setCustomRelType(e.target.value);
                  if (e.target.value.trim()) setRelType(null);
                }}
                className="mt-1.5"
                aria-label="Custom relationship type"
              />
              {customRelType && !(/^[A-Z][A-Z0-9_]{0,62}$/.test(effectiveRelType)) && (
                <p className="text-xs text-muted-foreground">
                  Must start with a capital letter, only A-Z, 0-9, and underscore.
                </p>
              )}
            </div>

            {/* Properties */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Properties (optional)</Label>
                <Button type="button" variant="ghost" size="sm" onClick={addProperty}>
                  <Plus className="mr-1 size-3.5" />
                  Add
                </Button>
              </div>
              {properties.length > 0 && (
                <div className="space-y-2">
                  {properties.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        placeholder="Key"
                        value={row.key}
                        onChange={(e) => updateProperty(idx, "key", e.target.value)}
                        className="flex-1"
                        aria-label={`Property key ${idx + 1}`}
                      />
                      <Input
                        placeholder="Value"
                        value={row.value}
                        onChange={(e) => updateProperty(idx, "value", e.target.value)}
                        className="flex-1"
                        aria-label={`Property value ${idx + 1}`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeProperty(idx)}
                        aria-label={`Remove property ${idx + 1}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogPanel>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Create relationship
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// NodeSearchInput — debounced similarity search typeahead for node endpoints.
// ---------------------------------------------------------------------------

interface NodeSearchInputProps {
  tenant: TenantSlugs;
  selected: NodeHit | null;
  onSelect: (node: NodeHit | null) => void;
  placeholder?: string;
}

function NodeSearchInput({ tenant, selected, onSelect, placeholder }: NodeSearchInputProps) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<NodeHit[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [showResults, setShowResults] = React.useState(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const doSearch = React.useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const payload = await similaritySearch(tenant, q.trim(), 10);
        setResults(payload.nodes);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [tenant],
  );

  const handleChange = (value: string) => {
    setQuery(value);
    onSelect(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleSelect = (node: NodeHit) => {
    onSelect(node);
    setQuery(node.displayName);
    setShowResults(false);
  };

  // Close results on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={selected ? selected.displayName : query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setShowResults(true)}
          placeholder={placeholder}
          className="pl-8"
          aria-label={placeholder}
        />
        {searching && (
          <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {showResults && results.length > 0 && !selected && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
          <ul className="max-h-[200px] overflow-y-auto p-1">
            {results.map((node) => (
              <li key={node.nodeId}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted/60"
                  onClick={() => handleSelect(node)}
                >
                  <span className="min-w-0 flex-1 truncate">{node.displayName}</span>
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{node.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            onSelect(null);
            setQuery("");
            setResults([]);
          }}
        >
          Clear selection
        </button>
      )}
    </div>
  );
}
