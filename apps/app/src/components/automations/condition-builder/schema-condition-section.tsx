"use client";
/**
 * schema-condition-section.tsx — the composed, drop-in "event configuration"
 * section shared by both automation trigger surfaces (the detail panel and the
 * chat inline create form).
 *
 * Renders: the entity-type (node label) + event-type Selects, then the nested
 * schema-driven <ConditionBuilder> scoped to the selected label's properties.
 *
 * Gating: "schema is defined" ⇔ the registry resolves ≥1 node label. When there
 * are no labels, the whole section is DISABLED with a CTA linking to
 * Knowledge → Ontology (the schema builder). While labels load, inputs are
 * disabled with a hint.
 *
 * Controlled: the parent owns entityType / eventType / conditionTree state and
 * receives changes; this component only fetches labels (via useSchemaLabels).
 */
import * as React from "react";
import { Database } from "lucide-react";
import { workspace } from "@/lib/routes";
import type { ConditionNode } from "@oxagen/oxagen/trigger-conditions";
import type {
  LabelItem,
  TenantSlugs,
} from "@/components/knowledge/schema-builder/types";
import { EntityEventFields, type EventType } from "./entity-event-fields";
import { ConditionBuilder } from "./condition-builder";
import { useSchemaLabels } from "./use-schema-labels";

export interface SchemaConditionSectionProps {
  slugs: TenantSlugs;
  entityType: string;
  onEntityTypeChange: (value: string) => void;
  eventType: EventType | "";
  onEventTypeChange: (value: EventType) => void;
  conditionTree: ConditionNode;
  onConditionTreeChange: (next: ConditionNode) => void;
  entityFieldId: string;
  eventFieldId: string;
  /** Extra disable signal from the parent (e.g. form is submitting). */
  disabled?: boolean;
  /**
   * Preloaded labels — when provided, skips the client fetch (e.g. the server
   * component already resolved the registry). Falsy → fetch via useSchemaLabels.
   */
  labels?: LabelItem[];
}

export function SchemaConditionSection({
  slugs,
  entityType,
  onEntityTypeChange,
  eventType,
  onEventTypeChange,
  conditionTree,
  onConditionTreeChange,
  entityFieldId,
  eventFieldId,
  disabled,
  labels: preloadedLabels,
}: SchemaConditionSectionProps): React.ReactElement {
  const hasPreloaded = preloadedLabels !== undefined;
  const fetched = useSchemaLabels(hasPreloaded ? null : slugs);
  const labels = hasPreloaded ? preloadedLabels : fetched.labels;
  const loading = hasPreloaded ? false : fetched.loading;
  const error = hasPreloaded ? null : fetched.error;

  const hasSchema = labels.length > 0;
  const sectionDisabled = disabled || loading || !hasSchema;

  const selectedLabel = labels.find((l) => l.name === entityType);
  const properties = selectedLabel?.properties ?? [];

  const ontologyHref = workspace.knowledge.ontology({
    orgSlug: slugs.orgSlug,
    workspaceSlug: slugs.workspaceSlug,
  });

  return (
    <div
      className="space-y-4 rounded-xl border border-border/60 bg-muted/30 p-4"
      data-testid="schema-condition-section"
    >
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Event configuration
      </p>

      {/* Error state — the registry failed to load; this is distinct from a
          genuinely empty schema, so we don't tell the user "no schema". */}
      {!loading && error && (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="schema-error"
          role="alert"
        >
          Couldn’t load the workspace schema. {error}
        </div>
      )}

      {/* No-schema CTA — the section is disabled until a schema exists. Only
          shown when the registry loaded successfully with no labels. */}
      {!loading && !error && !hasSchema && (
        <div
          className="flex items-start gap-3 rounded-lg border border-border bg-background p-3 text-sm"
          data-testid="no-schema-cta"
        >
          <Database
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              No schema defined for this workspace
            </p>
            <p className="text-muted-foreground">
              Define entity types and properties to build schema-driven trigger
              conditions.
            </p>
            <a
              href={ontologyHref}
              className="inline-block font-medium text-primary underline underline-offset-2 hover:no-underline"
              data-testid="define-schema-link"
            >
              Define a schema →
            </a>
          </div>
        </div>
      )}

      {loading && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="schema-loading"
        >
          Loading schema…
        </p>
      )}

      <EntityEventFields
        labels={labels}
        entityType={entityType}
        onEntityTypeChange={onEntityTypeChange}
        eventType={eventType}
        onEventTypeChange={onEventTypeChange}
        entityFieldId={entityFieldId}
        eventFieldId={eventFieldId}
        disabled={sectionDisabled}
      />

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Conditions</p>
        {hasSchema && entityType === "" ? (
          <p className="text-xs text-muted-foreground">
            Select an entity type to add conditions on its properties.
          </p>
        ) : (
          <ConditionBuilder
            value={conditionTree}
            onChange={onConditionTreeChange}
            properties={properties}
            disabled={sectionDisabled}
          />
        )}
      </div>
    </div>
  );
}
