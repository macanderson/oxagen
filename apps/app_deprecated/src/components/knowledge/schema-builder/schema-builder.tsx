"use client";

/**
 * schema-builder.tsx — the Knowledge → Schema registry shell.
 *
 * Owns one loaded registry snapshot and renders it through four tabs (Schemas,
 * Labels, Relationships, Version History) plus the label/relationship editor
 * dialogs, the pin → reconcile dialog, and the AI assistant drawer. Every read
 * and write goes through schema-service.ts, which POSTs to the in-app
 * /api/schema/* proxy route — that route is where auth and the capability
 * allow-list live.
 *
 * KNOWN GAP: none of the async handlers below catch. A failed load or save
 * rejects into the void, leaving the surface blank or silently unchanged with
 * no message to the user. Fixing that means adding an error slot to this
 * component and to SchemaList/LabelEditor/RelationshipEditor/VersionHistory —
 * a cross-component change, not a local one.
 */

import * as React from "react";
import { Bot, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SchemaList } from "./schema-list";
import { LabelEditor } from "./label-editor";
import { RelationshipEditor } from "./relationship-editor";
import { VersionHistory } from "./version-history";
import { PinChangeDialog } from "./pin-change-dialog";
import { ExportButton } from "./export-button";
import { SchemaAssistantDrawer } from "./schema-assistant-drawer";
import { OnboardingRecommendation } from "./onboarding-recommendation";
import {
  fetchRegistry,
  toggleSchema,
  upsertLabel,
  upsertRelationship,
} from "./schema-service";
import { schemaReconcileDispatchAction } from "./reconcile-actions";
import type {
  TenantSlugs,
  SchemaRegistryData,
  LabelItem,
  RelationshipItem,
} from "./types";
import type {
  SchemaToggleOutput,
  SchemaLabelUpsertInput,
  SchemaRelationshipUpsertInput,
} from "./schema-service";

interface SchemaBuilderProps {
  slugs: TenantSlugs;
  isAdmin: boolean;
}

type Tab = "schemas" | "labels" | "relationships" | "versions";

const ENFORCEMENT_BADGE: Record<
  SchemaRegistryData["enforcementMode"],
  { label: string; className: string }
> = {
  strict: {
    label: "Strict",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  },
  lenient: {
    label: "Lenient",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  off: { label: "Off", className: "bg-muted text-muted-foreground" },
};

export function SchemaBuilder({ slugs, isAdmin }: SchemaBuilderProps) {
  const [registry, setRegistry] = React.useState<SchemaRegistryData | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [activeTab, setActiveTab] = React.useState<Tab>("schemas");
  const [selectedSchemaName, setSelectedSchemaName] = React.useState<
    string | null
  >(null);
  const [versionId, setVersionId] = React.useState<string | undefined>(
    undefined,
  );

  // Dialogs
  const [labelDialog, setLabelDialog] = React.useState<{
    schemaName: string;
    initial?: LabelItem;
  } | null>(null);
  const [relationshipDialog, setRelationshipDialog] = React.useState<{
    schemaName: string;
    initial?: RelationshipItem;
  } | null>(null);
  const [pinDialog, setPinDialog] = React.useState<{
    versionId: string;
    versionNumber: number;
  } | null>(null);
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const [showOnboarding, setShowOnboarding] = React.useState(false);
  // The AI recommendation flow fetches (and shows loading skeletons) on mount,
  // so it is gated behind an explicit CTA in the empty state. Auto-mounting it
  // would show two ghost skeleton cards under the empty state.
  const [recommendationsOpen, setRecommendationsOpen] = React.useState(false);

  const loadRegistry = React.useCallback(
    async (vid?: string) => {
      setLoading(true);
      try {
        const data = await fetchRegistry(slugs, { versionId: vid });
        setRegistry(data);
        if (data.schemas.length === 0) setShowOnboarding(true);
      } finally {
        setLoading(false);
      }
    },
    [slugs],
  );

  React.useEffect(() => {
    void loadRegistry(versionId);
  }, [loadRegistry, versionId]);

  const handleToggle = async (
    schemaName: string,
    enabled: boolean,
  ): Promise<SchemaToggleOutput> => {
    const result = await toggleSchema(slugs, schemaName, enabled);
    // Refresh registry to reflect toggle
    const updated = await fetchRegistry(slugs);
    setRegistry(updated);
    return result;
  };

  // Reconciliation is version-scoped, not schema-scoped: it always re-labels
  // against the whole pinned registry version. `schemaName` only identifies
  // which row raised the prompt, so it is deliberately unused here.
  const handleReconcile = (_schemaName: string) => {
    if (!registry?.pinnedVersionId) return;
    void schemaReconcileDispatchAction({
      orgSlug: slugs.orgSlug,
      workspaceSlug: slugs.workspaceSlug,
      versionId: registry.pinnedVersionId,
      prune: false,
    });
  };

  const handleSaveLabel = async (input: SchemaLabelUpsertInput) => {
    await upsertLabel(slugs, input);
    setLabelDialog(null);
    await loadRegistry(versionId);
  };

  const handleSaveRelationship = async (
    input: SchemaRelationshipUpsertInput,
  ) => {
    await upsertRelationship(slugs, input);
    setRelationshipDialog(null);
    await loadRegistry(versionId);
  };

  const handlePin = async (vid: string) => {
    // Opening the reconcile dialog is all this does today: pin_schema_version
    // is never called, so pinning is not actually persisted.
    //
    // KNOWN DEFECT: the dialog is hard-coded to version 1 because VersionHistory
    // owns the version list and onPin only hands back an id. Fixing it means
    // widening onPin to carry the version number, which is a prop-signature
    // change — do that together with wiring pin_schema_version.
    setPinDialog({ versionId: vid, versionNumber: 1 });
  };

  const handleDispatchReconcile = async (opts: {
    versionId: string;
    prune: boolean;
  }) => {
    const { executionId } = await schemaReconcileDispatchAction({
      orgSlug: slugs.orgSlug,
      workspaceSlug: slugs.workspaceSlug,
      versionId: opts.versionId,
      prune: opts.prune,
    });
    setPinDialog(null);
    // Poll status until complete (fire-and-forget for now; executionId available for future progress UI)
    void executionId;
    // Optionally: start polling schemaReconcileStatusAction(slugs.orgSlug, slugs.workspaceSlug, executionId)
  };

  const handleOnboardingApply = async (
    schemaName: string,
    labels: LabelItem[],
  ) => {
    for (const label of labels) {
      await upsertLabel(slugs, {
        schemaName,
        name: label.name,
        displayName: label.displayName,
        description: label.description ?? undefined,
        properties: label.properties,
      });
    }
    setShowOnboarding(false);
    await loadRegistry(versionId);
  };

  // Collect all labels/relationships across schemas for the Labels / Relationships tabs
  const allLabels = React.useMemo(
    () =>
      (registry?.schemas ?? []).flatMap((s) =>
        s.labels.map((l) => ({ ...l, schemaName: s.schemaName })),
      ),
    [registry],
  );

  const allRelationships = React.useMemo(
    () =>
      (registry?.schemas ?? []).flatMap((s) =>
        s.relationshipTypes.map((r) => ({ ...r, schemaName: s.schemaName })),
      ),
    [registry],
  );

  const allLabelNames = allLabels.map((l) => l.name);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "schemas", label: "Schemas" },
    { id: "labels", label: "Labels" },
    { id: "relationships", label: "Relationships" },
    { id: "versions", label: "Version History" },
  ];

  const enforcementInfo = registry
    ? ENFORCEMENT_BADGE[registry.enforcementMode]
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">Schema Registry</h2>
          {enforcementInfo && (
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${enforcementInfo.className}`}
            >
              {enforcementInfo.label}
            </span>
          )}
          {registry && (
            <Select
              value={
                versionId ??
                (registry.draftVersionId
                  ? "draft"
                  : (registry.pinnedVersionId ?? "draft"))
              }
              onValueChange={(v) =>
                setVersionId(v == null || v === "draft" ? undefined : v)
              }
            >
              <SelectTrigger className="h-7 text-xs w-36 max-md:h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {registry.pinnedVersionId && (
                  <SelectItem value={registry.pinnedVersionId}>
                    Pinned version
                  </SelectItem>
                )}
                {registry.draftVersionId && (
                  <SelectItem value="draft">Draft</SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportButton slugs={slugs} versionId={versionId} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAssistantOpen(true)}
            className="gap-1.5 max-md:h-11"
          >
            <Bot className="h-3.5 w-3.5" />
            Open AI Assistant
          </Button>
        </div>
      </div>

      {/* Tabs — horizontal scroll on mobile rather than wrapping/hiding, so every
          tab stays reachable at 390px without shrinking the tap targets. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`shrink-0 px-4 py-2 max-md:min-h-11 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      )}

      {/* Schemas tab */}
      {!loading && activeTab === "schemas" && registry && (
        <div className="space-y-4">
          {registry.schemas.length === 0 && showOnboarding ? (
            <div className="rounded-xl border border-border bg-card p-6 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">No schemas defined</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Use AI recommendations to draft a starter schema from your
                    graph.
                  </p>
                </div>
                {!recommendationsOpen && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="max-md:h-11 shrink-0"
                    onClick={() => setRecommendationsOpen(true)}
                  >
                    <Sparkles
                      className="h-3.5 w-3.5 mr-1.5"
                      aria-hidden="true"
                    />
                    Use AI recommendations
                  </Button>
                )}
              </div>
              {recommendationsOpen && (
                <OnboardingRecommendation
                  slugs={slugs}
                  onApply={handleOnboardingApply}
                  onDiscard={() => setRecommendationsOpen(false)}
                />
              )}
            </div>
          ) : (
            <SchemaList
              schemas={registry.schemas}
              onToggle={handleToggle}
              onSelect={setSelectedSchemaName}
              onReconcile={handleReconcile}
              selectedSchemaName={selectedSchemaName}
              isAdmin={isAdmin}
            />
          )}
        </div>
      )}

      {/* Labels tab */}
      {!loading && activeTab === "labels" && registry && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button
              size="sm"
              className="max-md:h-11"
              onClick={() =>
                setLabelDialog({
                  schemaName: registry.schemas[0]?.schemaName ?? "core",
                })
              }
              disabled={registry.schemas.length === 0}
            >
              Add Label
            </Button>
          </div>
          <div className="rounded-xl border border-border overflow-hidden">
            {allLabels.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No labels defined.
              </div>
            )}
            {allLabels.map((label, idx) => (
              <div
                key={`${label.schemaName}/${label.name}`}
                className={`flex flex-col gap-1 px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors sm:flex-row sm:items-center sm:justify-between ${
                  idx > 0 ? "border-t border-border" : ""
                }`}
                onClick={() =>
                  setLabelDialog({
                    schemaName: label.schemaName,
                    initial: label,
                  })
                }
              >
                <div>
                  <span className="font-medium text-sm">
                    {label.displayName}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground font-mono">
                    {label.name}
                  </span>
                  <Badge variant="outline" className="ml-2 text-xs">
                    {label.schemaName}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {label.properties?.length ?? 0} properties
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Relationships tab */}
      {!loading && activeTab === "relationships" && registry && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button
              size="sm"
              className="max-md:h-11"
              onClick={() =>
                setRelationshipDialog({
                  schemaName: registry.schemas[0]?.schemaName ?? "core",
                })
              }
              disabled={registry.schemas.length === 0}
            >
              Add Relationship
            </Button>
          </div>
          <div className="rounded-xl border border-border overflow-hidden">
            {allRelationships.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No relationship types defined.
              </div>
            )}
            {allRelationships.map((rel, idx) => (
              <div
                key={`${rel.schemaName}/${rel.name}`}
                className={`flex flex-col gap-1 px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors sm:flex-row sm:items-center sm:justify-between ${
                  idx > 0 ? "border-t border-border" : ""
                }`}
                onClick={() =>
                  setRelationshipDialog({
                    schemaName: rel.schemaName,
                    initial: rel,
                  })
                }
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    {rel.name}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {rel.schemaName}
                  </Badge>
                  {rel.startLabel && rel.endLabel && (
                    <span className="text-xs text-muted-foreground">
                      {rel.startLabel} → {rel.endLabel}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {rel.properties?.length ?? 0} properties
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Version History tab */}
      {!loading && activeTab === "versions" && registry && (
        <VersionHistory
          slugs={slugs}
          pinnedVersionId={registry.pinnedVersionId}
          onPin={handlePin}
        />
      )}

      {/* Label Dialog */}
      <Dialog
        open={!!labelDialog}
        onOpenChange={(open) => !open && setLabelDialog(null)}
      >
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {labelDialog?.initial ? "Edit Label" : "Add Label"}
            </DialogTitle>
          </DialogHeader>
          {labelDialog && (
            <LabelEditor
              schemaName={labelDialog.schemaName}
              initial={labelDialog.initial}
              onSave={handleSaveLabel}
              onCancel={() => setLabelDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Relationship Dialog */}
      <Dialog
        open={!!relationshipDialog}
        onOpenChange={(open) => !open && setRelationshipDialog(null)}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {relationshipDialog?.initial
                ? "Edit Relationship"
                : "Add Relationship"}
            </DialogTitle>
          </DialogHeader>
          {relationshipDialog && (
            <RelationshipEditor
              schemaName={relationshipDialog.schemaName}
              availableLabels={allLabelNames}
              initial={relationshipDialog.initial}
              onSave={handleSaveRelationship}
              onCancel={() => setRelationshipDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Pin Change Dialog */}
      {pinDialog && (
        <PinChangeDialog
          open={!!pinDialog}
          onOpenChange={(open) => !open && setPinDialog(null)}
          versionId={pinDialog.versionId}
          versionNumber={pinDialog.versionNumber}
          onDispatch={handleDispatchReconcile}
        />
      )}

      {/* Schema Assistant Drawer */}
      <SchemaAssistantDrawer
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        slugs={slugs}
        onApplied={() => void loadRegistry(versionId)}
      />
    </div>
  );
}
