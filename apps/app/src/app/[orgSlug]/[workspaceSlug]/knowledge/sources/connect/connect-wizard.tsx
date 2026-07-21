"use client";

/**
 * connect-wizard.tsx — orchestrator for the "Connect a source" wizard
 * (docs/web-app-2.0/workspace/knowledge/sources/connect/spec.md).
 *
 * Owns all cross-step state (selected connector, schema, connectionId,
 * preview data, mapping drafts) and drives the 5 step components under
 * apps/app/src/components/knowledge/connect/**, each of which is purely
 * presentational. Every capability call goes through this route's own
 * ./actions.ts server actions.
 *
 * Back/forward navigation preserves entered state EXCEPT credentials cannot
 * be revisited once create_connection has run — there is no
 * connection.update capability in this wizard's allowed set, so re-editing
 * secrets already saved server-side isn't safely possible. The Preview step
 * therefore offers "Cancel" (with a warning once a connection exists) instead
 * of "Back to Credentials"; Mappings ↔ Preview ↔ Confirm navigation is fully
 * state-preserving (no re-fetch — data stays in this component's state).
 *
 * Abandoning mid-wizard: once create_connection has run, closing the tab
 * leaves a `pending_setup` connection row behind — there is no
 * connection.delete capability in this wizard's allowed set to clean it up.
 * Mitigated with a beforeunload warning and an explicit confirm() on Cancel;
 * the true fix is a connection.delete call from Sources' existing "Delete
 * source" flow (out of this wizard's edit boundary).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { WizardProgress } from "@/components/knowledge/connect/wizard-progress";
import { ConnectorPickerStep } from "@/components/knowledge/connect/connector-picker-step";
import {
  CredentialsStep,
  type CredentialsSubmitInput,
  type ValidateOutcome,
} from "@/components/knowledge/connect/credentials-step";
import { PreviewStep } from "@/components/knowledge/connect/preview-step";
import { MappingsStep } from "@/components/knowledge/connect/mappings-step";
import { ConfirmStep } from "@/components/knowledge/connect/confirm-step";
import type {
  ConnectorCatalogEntry,
  MappingDraft,
  PreviewRecordType,
  WizardStepId,
} from "@/components/knowledge/connect/wizard-types";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import type { ConnectionMappingsGetOutput } from "@oxagen/oxagen/contracts/connection.mappings.get";
import {
  getConnectSourceSchemaAction,
  validateConnectSourceConfigAction,
  createSourceConnectionAction,
  previewSourceConnectionAction,
  suggestSourceMappingsAction,
  confirmSourceMappingsAction,
  configureSourceIntegrationAction,
} from "./actions";

export interface ConnectSourceWizardProps {
  orgSlug: string;
  workspaceSlug: string;
  connectors: ConnectorCatalogEntry[];
  /** Resume handoff — set when returning from an external OAuth flow. */
  initialConnectionId?: string;
  /** SSR-prefetched mappings for the resume case (see page.tsx). */
  initialMappings?: ConnectionMappingsGetOutput["mappings"];
}

function draftsFromSaved(
  mappings: ConnectionMappingsGetOutput["mappings"],
): MappingDraft[] {
  return mappings.map((m) => ({
    sourceRecordType: m.sourceRecordType,
    oxagenEntityType: m.oxagenEntityType,
    propertyMappings: m.propertyMappings,
  }));
}

export function ConnectSourceWizard({
  orgSlug,
  workspaceSlug,
  connectors,
  initialConnectionId,
  initialMappings,
}: ConnectSourceWizardProps) {
  const router = useRouter();
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };
  const sourcesHref = workspace.knowledge.sources(ctx);

  const hasInitialMappings = Boolean(
    initialMappings && initialMappings.length > 0,
  );
  const initialStep: WizardStepId = initialConnectionId
    ? hasInitialMappings
      ? "mappings"
      : "preview"
    : "pick";

  const [step, setStep] = React.useState<WizardStepId>(initialStep);
  const [selectedConnector, setSelectedConnector] =
    React.useState<ConnectorCatalogEntry | null>(null);

  const [schema, setSchema] = React.useState<ConnectorPluginSchema | null>(
    null,
  );
  const [schemaLoading, setSchemaLoading] = React.useState(false);
  const [schemaError, setSchemaError] = React.useState<string | null>(null);

  const [connectionId, setConnectionId] = React.useState<string | null>(
    initialConnectionId ?? null,
  );
  const [connectionDisplayName, setConnectionDisplayName] = React.useState("");

  const [credentialsSubmitting, setCredentialsSubmitting] =
    React.useState(false);
  const [credentialsError, setCredentialsError] = React.useState<string | null>(
    null,
  );

  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = React.useState(false);
  const [recordTypes, setRecordTypes] = React.useState<PreviewRecordType[]>([]);

  const [mappingsLoading, setMappingsLoading] = React.useState(false);
  const [mappingsError, setMappingsError] = React.useState<string | null>(null);
  const [mappingDrafts, setMappingDrafts] = React.useState<MappingDraft[]>(
    initialMappings ? draftsFromSaved(initialMappings) : [],
  );

  const [confirmSubmitting, setConfirmSubmitting] = React.useState(false);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  // Warn before an unload that would silently orphan a pending_setup
  // connection (no connection.delete in this wizard's allowed capability set
  // — see file header).
  React.useEffect(() => {
    if (!connectionId || done) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [connectionId, done]);

  // ---- Step 1: pick connector ------------------------------------------------

  const loadSchema = React.useCallback(
    async (connectorId: string) => {
      setSchemaLoading(true);
      setSchemaError(null);
      const result = await getConnectSourceSchemaAction({
        orgSlug,
        workspaceSlug,
        connectorId,
      });
      setSchemaLoading(false);
      if (!result.ok) {
        setSchemaError(result.error);
        return;
      }
      setSchema(result.value);
    },
    [orgSlug, workspaceSlug],
  );

  const handleSelectConnector = React.useCallback(
    (connector: ConnectorCatalogEntry) => {
      setSelectedConnector(connector);
      setSchema(null);
      setCredentialsError(null);
      setStep("credentials");
      void loadSchema(connector.connectorId);
    },
    [loadSchema],
  );

  const handleRetrySchema = React.useCallback(() => {
    if (selectedConnector) void loadSchema(selectedConnector.connectorId);
  }, [selectedConnector, loadSchema]);

  const handleBackToPick = React.useCallback(() => setStep("pick"), []);

  // ---- Step 2: credentials ----------------------------------------------------

  const handleValidateCredentials = React.useCallback(
    async (
      config: Record<string, unknown>,
      authSchemeId: string | null,
    ): Promise<ValidateOutcome> => {
      if (!selectedConnector) return { error: "No connector selected." };
      const result = await validateConnectSourceConfigAction({
        orgSlug,
        workspaceSlug,
        connectorId: selectedConnector.connectorId,
        authSchemeId: authSchemeId ?? undefined,
        config,
      });
      if (!result.ok) return { error: result.error };
      return result.value;
    },
    [selectedConnector, orgSlug, workspaceSlug],
  );

  const handleSubmitCredentials = React.useCallback(
    async (input: CredentialsSubmitInput) => {
      if (!selectedConnector) return;
      setCredentialsSubmitting(true);
      setCredentialsError(null);
      const result = await createSourceConnectionAction({
        orgSlug,
        workspaceSlug,
        connectorId: selectedConnector.connectorId,
        displayName: input.displayName,
        connectionConfig: input.connectionConfig,
        authCredential: input.authCredential,
      });
      setCredentialsSubmitting(false);
      if (!result.ok) {
        setCredentialsError(result.error);
        return;
      }
      setConnectionId(result.value.publicId);
      setConnectionDisplayName(result.value.displayName);
      setPreviewLoaded(false);
      setPreviewError(null);
      setStep("preview");
    },
    [selectedConnector, orgSlug, workspaceSlug],
  );

  // ---- Step 3: preview ---------------------------------------------------------

  const loadPreview = React.useCallback(async () => {
    if (!connectionId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    const result = await previewSourceConnectionAction({
      orgSlug,
      workspaceSlug,
      connectionId,
    });
    setPreviewLoading(false);
    if (!result.ok) {
      setPreviewError(result.error);
      return;
    }
    setRecordTypes(result.value.recordTypes);
    setPreviewLoaded(true);
  }, [connectionId, orgSlug, workspaceSlug]);

  React.useEffect(() => {
    if (
      step === "preview" &&
      connectionId &&
      !previewLoaded &&
      !previewLoading &&
      !previewError
    ) {
      void loadPreview();
    }
  }, [
    step,
    connectionId,
    previewLoaded,
    previewLoading,
    previewError,
    loadPreview,
  ]);

  const handlePreviewNext = React.useCallback(async () => {
    if (!connectionId) return;
    // Already have drafts (a prior suggest call, possibly hand-edited) —
    // Mappings ↔ Preview navigation must preserve entered state, so don't
    // silently re-suggest and discard the user's edits.
    if (mappingDrafts.length > 0) {
      setStep("mappings");
      return;
    }
    setStep("mappings");
    setMappingsLoading(true);
    setMappingsError(null);
    const result = await suggestSourceMappingsAction({
      orgSlug,
      workspaceSlug,
      connectionId,
      recordTypes: recordTypes.map((rt) => ({
        sourceRecordType: rt.sourceRecordType,
        displayName: rt.displayName,
        description: rt.description,
        sampleFields: rt.sampleFields,
        sampleRecords: rt.sampleRecords,
      })),
    });
    setMappingsLoading(false);
    if (!result.ok) {
      setMappingsError(result.error);
      return;
    }
    setMappingDrafts(
      result.value.suggestions.map((s) => ({
        sourceRecordType: s.sourceRecordType,
        oxagenEntityType: s.suggestedEntityType,
        propertyMappings: s.suggestedPropertyMappings,
        confidence: s.confidence,
        reasoning: s.reasoning,
      })),
    );
  }, [connectionId, orgSlug, workspaceSlug, recordTypes, mappingDrafts]);

  const handleCancel = React.useCallback(() => {
    if (connectionId && !done) {
      const proceed = window.confirm(
        "Leaving now will not finish setting up this source. A connection record was already created and stays pending until you finish or delete it from Sources. Leave anyway?",
      );
      if (!proceed) return;
    }
    router.push(sourcesHref);
  }, [connectionId, done, router, sourcesHref]);

  // ---- Step 4: mappings --------------------------------------------------------

  const handleChangeDraft = React.useCallback(
    (index: number, patch: Partial<MappingDraft>) => {
      setMappingDrafts((prev) =>
        prev.map((d, i) => (i === index ? { ...d, ...patch } : d)),
      );
    },
    [],
  );

  const handleMappingsRetry = React.useCallback(() => {
    void handlePreviewNext();
  }, [handlePreviewNext]);

  const handleMappingsNext = React.useCallback(() => setStep("confirm"), []);
  const handleMappingsBack = React.useCallback(() => setStep("preview"), []);

  // ---- Step 5: confirm ----------------------------------------------------------

  const handleConfirmBack = React.useCallback(() => setStep("mappings"), []);

  const handleConfirm = React.useCallback(async () => {
    if (!connectionId) return;
    setConfirmSubmitting(true);
    setConfirmError(null);
    const result = await confirmSourceMappingsAction({
      orgSlug,
      workspaceSlug,
      connectionId,
      mappings: mappingDrafts.map((d) => ({
        sourceRecordType: d.sourceRecordType,
        oxagenEntityType: d.oxagenEntityType,
        propertyMappings: d.propertyMappings,
      })),
      activateConnection: true,
    });
    setConfirmSubmitting(false);
    if (!result.ok) {
      setConfirmError(result.error);
      return;
    }

    // Best-effort: apply the connector's declared sync cadence as an
    // integration-level setting alongside the now-active
    // connection (spec: "integration.configure — integration-level settings
    // alongside the connection"). Not on resume (schema is null there — Step 2
    // never ran to fetch it) and never blocks activation success on failure;
    // the connection is already active regardless of this call's outcome.
    if (schema?.sync) {
      void configureSourceIntegrationAction({
        orgSlug,
        workspaceSlug,
        integrationId: connectionId,
        syncCadence: schema.sync.delivery,
      });
    }

    setDone(true);
    router.push(sourcesHref);
  }, [
    connectionId,
    orgSlug,
    workspaceSlug,
    mappingDrafts,
    schema,
    router,
    sourcesHref,
  ]);

  return (
    <div className="flex flex-col gap-6" data-testid="connect-source-wizard">
      <WizardProgress currentStep={step} />

      {step === "pick" && (
        <ConnectorPickerStep
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          connectors={connectors}
          onSelect={handleSelectConnector}
        />
      )}

      {step === "credentials" && selectedConnector && (
        <CredentialsStep
          connectorId={selectedConnector.connectorId}
          connectorDisplayName={selectedConnector.displayName}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          schema={schema}
          schemaLoading={schemaLoading}
          schemaError={schemaError}
          onRetrySchema={handleRetrySchema}
          onValidate={handleValidateCredentials}
          onSubmit={handleSubmitCredentials}
          submitting={credentialsSubmitting}
          submitError={credentialsError}
          onBack={handleBackToPick}
        />
      )}

      {step === "preview" && (
        <PreviewStep
          loading={previewLoading}
          error={previewError}
          recordTypes={recordTypes}
          onRetry={loadPreview}
          onNext={handlePreviewNext}
          onCancel={handleCancel}
        />
      )}

      {step === "mappings" && (
        <MappingsStep
          loading={mappingsLoading}
          error={mappingsError}
          drafts={mappingDrafts}
          onChangeDraft={handleChangeDraft}
          onRetry={handleMappingsRetry}
          onNext={handleMappingsNext}
          onBack={handleMappingsBack}
        />
      )}

      {step === "confirm" && (
        <ConfirmStep
          connectorDisplayName={
            selectedConnector?.displayName ?? "This connection"
          }
          connectionDisplayName={
            connectionDisplayName || "This source connection"
          }
          mappings={mappingDrafts}
          submitting={confirmSubmitting}
          error={confirmError}
          onConfirm={handleConfirm}
          onBack={handleConfirmBack}
        />
      )}
    </div>
  );
}
