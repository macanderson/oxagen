"use client";
/**
 * use-schema-labels.ts — client hook that fetches the workspace schema registry
 * and flattens it to the list of node labels (across enabled + all schemas)
 * available as entity types for an automation trigger.
 *
 * Reuses the schema-builder's `fetchRegistry` service (POST /api/schema/registry/get)
 * — the single read path for the registry — rather than inventing a new contract.
 * "Schema is defined" ⇔ ≥1 node label resolves.
 */
import * as React from "react";
import { fetchRegistry } from "@/components/knowledge/schema-builder/schema-service";
import type {
  LabelItem,
  TenantSlugs,
} from "@/components/knowledge/schema-builder/types";

export interface SchemaLabelsState {
  labels: LabelItem[];
  loading: boolean;
  error: string | null;
}

/**
 * Flatten every schema's node labels into a single, de-duplicated list
 * (first occurrence of a label name wins). This is the entity-type universe an
 * automation may watch.
 */
export function flattenLabels(schemas: { labels: LabelItem[] }[]): LabelItem[] {
  const byName = new Map<string, LabelItem>();
  for (const schema of schemas) {
    for (const label of schema.labels) {
      if (!byName.has(label.name)) byName.set(label.name, label);
    }
  }
  return [...byName.values()];
}

export function useSchemaLabels(
  slugs: TenantSlugs | null | undefined,
): SchemaLabelsState {
  const [state, setState] = React.useState<SchemaLabelsState>({
    labels: [],
    loading: Boolean(slugs),
    error: null,
  });

  const orgSlug = slugs?.orgSlug;
  const workspaceSlug = slugs?.workspaceSlug;

  React.useEffect(() => {
    if (!orgSlug || !workspaceSlug) {
      setState({ labels: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetchRegistry({ orgSlug, workspaceSlug })
      .then((registry) => {
        if (cancelled) return;
        setState({
          labels: flattenLabels(registry.schemas),
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          labels: [],
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load schema.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug, workspaceSlug]);

  return state;
}
