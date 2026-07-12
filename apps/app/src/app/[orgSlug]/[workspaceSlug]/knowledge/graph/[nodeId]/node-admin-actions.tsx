"use client";

/**
 * node-admin-actions.tsx — admin-only mutation panel for the Knowledge →
 * Graph node-detail page (spec: docs/web-app-2.0/workspace/knowledge/graph/
 * node/spec.md).
 *
 * Rendered only when the caller is an org owner/admin — page.tsx computes
 * `isAdmin` via getOrgRole (apps/app does not bootstrap IAM, so this is the
 * UI-level gate; actions.ts re-asserts admin server-side on every call, so a
 * caller invoking the action directly still hits a real gate). Three
 * affordances:
 *   - Labels: add/remove a Neo4j label (multi-label tagging — distinct from
 *     the single domain `label` property shown in the header)
 *   - Outgoing relationship: add/remove a typed edge to another node by
 *     publicId
 *   - Delete node (destructive, two-step confirm, navigates back to
 *     Knowledge → Graph on success since the node no longer exists)
 *
 * Server actions are threaded in as props from page.tsx — the standard
 * RSC → client server-action pattern used by MemoriesClient
 * (components/knowledge/memories/memories-client.tsx). Result types are
 * mirrored locally (not imported from ./actions) to match that same
 * convention and keep this "use client" file decoupled from the actions
 * module's own type surface.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Link2, Plus, Tag, Trash2, Unlink, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { workspace } from "@/lib/routes";

// Client-side UX guards only — mirror LABEL_PATTERN / RELATIONSHIP_TYPE_PATTERN
// from packages/oxagen/src/lib/{label,relationship-type}-pattern.ts. Not
// imported directly: that would pull the contracts/zod graph into this
// "use client" bundle (see node-ref.tsx's identical note on memory-kinds.ts).
// The handler remains the sole authority; this only gives fast inline
// feedback before a round trip.
const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const RELATIONSHIP_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/;

type DeleteNodeResult = { ok: true; deleted: boolean } | { ok: false; error: string };
type AddNodeLabelResult =
  | { ok: true; labels: string[]; added: string[] }
  | { ok: false; error: string };
type RemoveNodeLabelResult =
  | { ok: true; labels: string[]; removed: string[] }
  | { ok: false; error: string };
type UpsertEdgeResult =
  | { ok: true; edgeId: string; created: boolean; superseded: number }
  | { ok: false; error: string };
type DeleteEdgeResult = { ok: true; deleted: boolean } | { ok: false; error: string };

export interface NodeAdminActionsProps {
  orgSlug: string;
  workspaceSlug: string;
  nodeId: string;
  initialLabels: string[];
  deleteNode: (input: {
    orgSlug: string;
    workspaceSlug: string;
    nodeId: string;
  }) => Promise<DeleteNodeResult>;
  addNodeLabel: (input: {
    orgSlug: string;
    workspaceSlug: string;
    nodeId: string;
    labels: string[];
  }) => Promise<AddNodeLabelResult>;
  removeNodeLabel: (input: {
    orgSlug: string;
    workspaceSlug: string;
    nodeId: string;
    labels: string[];
  }) => Promise<RemoveNodeLabelResult>;
  upsertEdge: (input: {
    orgSlug: string;
    workspaceSlug: string;
    fromNodeId: string;
    toNodeId: string;
    relationshipType: string;
  }) => Promise<UpsertEdgeResult>;
  deleteEdge: (input: {
    orgSlug: string;
    workspaceSlug: string;
    fromNodeId: string;
    toNodeId: string;
    edgeType: string;
  }) => Promise<DeleteEdgeResult>;
}

export function NodeAdminActions({
  orgSlug,
  workspaceSlug,
  nodeId,
  initialLabels,
  deleteNode,
  addNodeLabel,
  removeNodeLabel,
  upsertEdge,
  deleteEdge,
}: NodeAdminActionsProps) {
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card px-6 py-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Admin actions
      </h2>
      <LabelsPanel
        nodeId={nodeId}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        initialLabels={initialLabels}
        addNodeLabel={addNodeLabel}
        removeNodeLabel={removeNodeLabel}
      />
      <RelationshipPanel
        nodeId={nodeId}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        upsertEdge={upsertEdge}
        deleteEdge={deleteEdge}
      />
      <DeleteNodePanel
        nodeId={nodeId}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        deleteNode={deleteNode}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function LabelsPanel({
  nodeId,
  orgSlug,
  workspaceSlug,
  initialLabels,
  addNodeLabel,
  removeNodeLabel,
}: {
  nodeId: string;
  orgSlug: string;
  workspaceSlug: string;
  initialLabels: string[];
  addNodeLabel: NodeAdminActionsProps["addNodeLabel"];
  removeNodeLabel: NodeAdminActionsProps["removeNodeLabel"];
}) {
  const [labels, setLabels] = React.useState(initialLabels);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const handleAdd = React.useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    if (!LABEL_PATTERN.test(value)) {
      setError(
        "Labels must start with a letter and contain only letters, digits, or underscores.",
      );
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await addNodeLabel({ orgSlug, workspaceSlug, nodeId, labels: [value] });
      if (result.ok) {
        setLabels(result.labels);
        setDraft("");
      } else {
        setError(result.error);
      }
    });
  }, [draft, addNodeLabel, orgSlug, workspaceSlug, nodeId]);

  const handleRemove = React.useCallback(
    (label: string) => {
      setError(null);
      startTransition(async () => {
        const result = await removeNodeLabel({ orgSlug, workspaceSlug, nodeId, labels: [label] });
        if (result.ok) {
          setLabels(result.labels);
        } else {
          setError(result.error);
        }
      });
    },
    [removeNodeLabel, orgSlug, workspaceSlug, nodeId],
  );

  return (
    <div>
      <h3 className="mb-1.5 flex items-center gap-1 text-xs font-medium text-foreground">
        <Tag className="size-3.5" aria-hidden="true" /> Labels
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {labels.length === 0 ? (
          <span className="text-xs text-muted-foreground">No extra labels.</span>
        ) : (
          labels.map((label) => (
            <Badge key={label} variant="outline" size="sm" className="gap-1 pr-1">
              {label}
              <button
                type="button"
                onClick={() => handleRemove(label)}
                disabled={isPending}
                aria-label={`Remove label ${label}`}
                className="rounded-sm hover:bg-muted"
              >
                <X className="size-2.5" aria-hidden="true" />
              </button>
            </Badge>
          ))
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add label (e.g. Billing)"
          size="sm"
          className="max-w-48"
          aria-label="New label"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={isPending || !draft.trim()}
        >
          <Plus className="size-3.5" aria-hidden="true" /> Add label
        </Button>
      </div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function RelationshipPanel({
  nodeId,
  orgSlug,
  workspaceSlug,
  upsertEdge,
  deleteEdge,
}: {
  nodeId: string;
  orgSlug: string;
  workspaceSlug: string;
  upsertEdge: NodeAdminActionsProps["upsertEdge"];
  deleteEdge: NodeAdminActionsProps["deleteEdge"];
}) {
  const [toNodeId, setToNodeId] = React.useState("");
  const [relationshipType, setRelationshipType] = React.useState("");
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const validate = React.useCallback((): string | null => {
    if (!toNodeId.trim()) return "Target node id is required.";
    if (!relationshipType.trim()) return "Relationship type is required.";
    if (!RELATIONSHIP_TYPE_PATTERN.test(relationshipType.trim())) {
      return "Relationship type must be UPPER_SNAKE_CASE (e.g. WORKS_AT).";
    }
    return null;
  }, [toNodeId, relationshipType]);

  const handleUpsert = React.useCallback(() => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const result = await upsertEdge({
        orgSlug,
        workspaceSlug,
        fromNodeId: nodeId,
        toNodeId: toNodeId.trim(),
        relationshipType: relationshipType.trim(),
      });
      if (result.ok) {
        setStatus(result.created ? "Relationship added." : "Relationship already existed.");
      } else {
        setError(result.error);
      }
    });
  }, [validate, upsertEdge, orgSlug, workspaceSlug, nodeId, toNodeId, relationshipType]);

  const handleDelete = React.useCallback(() => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const result = await deleteEdge({
        orgSlug,
        workspaceSlug,
        fromNodeId: nodeId,
        toNodeId: toNodeId.trim(),
        edgeType: relationshipType.trim(),
      });
      if (result.ok) {
        setStatus(result.deleted ? "Relationship removed." : "No matching relationship found.");
      } else {
        setError(result.error);
      }
    });
  }, [validate, deleteEdge, orgSlug, workspaceSlug, nodeId, toNodeId, relationshipType]);

  return (
    <div>
      <h3 className="mb-1.5 flex items-center gap-1 text-xs font-medium text-foreground">
        <Link2 className="size-3.5" aria-hidden="true" /> Outgoing relationship
      </h3>
      <div className="flex flex-wrap items-end gap-1.5">
        <div>
          <Label htmlFor="node-admin-to-node-id" className="mb-1 block text-[11px] text-muted-foreground">
            Target node id
          </Label>
          <Input
            id="node-admin-to-node-id"
            value={toNodeId}
            onChange={(e) => setToNodeId(e.target.value)}
            placeholder="publicId"
            size="sm"
            className="max-w-56"
          />
        </div>
        <div>
          <Label htmlFor="node-admin-rel-type" className="mb-1 block text-[11px] text-muted-foreground">
            Relationship type
          </Label>
          <Input
            id="node-admin-rel-type"
            value={relationshipType}
            onChange={(e) => setRelationshipType(e.target.value.toUpperCase())}
            placeholder="RELATES_TO"
            size="sm"
            className="max-w-40 font-mono"
          />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={handleUpsert} disabled={isPending}>
          <Link2 className="size-3.5" aria-hidden="true" /> Add relationship
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive-outline"
          onClick={handleDelete}
          disabled={isPending}
        >
          <Unlink className="size-3.5" aria-hidden="true" /> Remove relationship
        </Button>
      </div>
      {status ? <p className="mt-1 text-xs text-success">{status}</p> : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete node
// ---------------------------------------------------------------------------

function DeleteNodePanel({
  nodeId,
  orgSlug,
  workspaceSlug,
  deleteNode,
}: {
  nodeId: string;
  orgSlug: string;
  workspaceSlug: string;
  deleteNode: NodeAdminActionsProps["deleteNode"];
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const handleDelete = React.useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await deleteNode({ orgSlug, workspaceSlug, nodeId });
      if (result.ok) {
        router.push(workspace.knowledge.graph({ orgSlug, workspaceSlug }));
      } else {
        setError(result.error);
        setConfirming(false);
      }
    });
  }, [deleteNode, orgSlug, workspaceSlug, nodeId, router]);

  return (
    <div className="border-t border-border/60 pt-3">
      <h3 className="mb-1.5 text-xs font-medium text-destructive">Danger zone</h3>
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Delete this node permanently?</span>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
            aria-label="Confirm delete node"
          >
            Confirm delete
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" variant="destructive-outline" onClick={() => setConfirming(true)}>
          <Trash2 className="size-3.5" aria-hidden="true" /> Delete node
        </Button>
      )}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
