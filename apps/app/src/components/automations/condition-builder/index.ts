/**
 * condition-builder — schema-driven nested boolean condition builder for
 * automation triggers. Public surface:
 *
 *   <SchemaConditionSection>  — the drop-in event-config section (entity/event
 *                               fields + gated ConditionBuilder + no-schema CTA).
 *   <ConditionBuilder>        — the bare, controlled condition-tree editor.
 *   <EntityEventFields>       — entity-type + event-type Selects.
 *   useSchemaLabels           — client hook to resolve registry node labels.
 */
export { ConditionBuilder } from "./condition-builder";
export type { ConditionBuilderProps } from "./condition-builder";
export { SchemaConditionSection } from "./schema-condition-section";
export type { SchemaConditionSectionProps } from "./schema-condition-section";
export { EntityEventFields, type EventType } from "./entity-event-fields";
export { useSchemaLabels, flattenLabels } from "./use-schema-labels";
export type { SchemaLabelsState } from "./use-schema-labels";
