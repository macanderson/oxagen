/**
 * wizard-types.ts — shared types for the "Connect a source" wizard
 * (Knowledge → Sources → Connect). Consumed by the step components under
 * this directory and by the route's orchestrator
 * (knowledge/sources/connect/connect-wizard.tsx).
 */

import type { ConnectionPreviewOutput } from "@oxagen/oxagen/contracts/connection.preview";

export type WizardStepId =
  | "pick"
  | "credentials"
  | "preview"
  | "mappings"
  | "confirm";

export const WIZARD_STEPS: readonly WizardStepId[] = [
  "pick",
  "credentials",
  "preview",
  "mappings",
  "confirm",
] as const;

export const WIZARD_STEP_LABELS: Record<WizardStepId, string> = {
  pick: "Connector",
  credentials: "Credentials",
  preview: "Preview",
  mappings: "Mappings",
  confirm: "Confirm",
};

/**
 * Lightweight, serializable catalog entry — derived server-side (page.tsx)
 * from `@oxagen/ingestion/connectors`' `listConnectors()` registry, NOT a
 * capability call (there is no `connection.catalog`/`integration.list`
 * capability in this wizard's allowed set).
 *
 * `isOAuthOnly` is true when every auth scheme the connector supports is an
 * OAuth2 flow — those connectors cannot be provisioned by this wizard's
 * inline Credentials step (no oauth-start capability exists yet; see
 * connector-picker-step.tsx for the redirect-out handling).
 */
export interface ConnectorCatalogEntry {
  connectorId: string;
  displayName: string;
  description: string;
  icon: string;
  isOAuthOnly: boolean;
}

export type PreviewRecordType = ConnectionPreviewOutput["recordTypes"][number];

/** Editable draft of one entity-type mapping row shown in the Mappings step. */
export interface MappingDraft {
  sourceRecordType: string;
  oxagenEntityType: string;
  propertyMappings: Record<string, string>;
  /** LLM confidence (0-1) when seeded from suggest_connection_mappings; undefined when seeded from an existing saved mapping (get_connection_mappings). */
  confidence?: number;
  /** LLM explanation when seeded from suggest_connection_mappings. */
  reasoning?: string;
}
