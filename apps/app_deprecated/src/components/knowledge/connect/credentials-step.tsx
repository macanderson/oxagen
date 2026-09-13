"use client";

/**
 * credentials-step.tsx — Step 2 of the "Connect a source" wizard: a form
 * rendered dynamically from get_plugin_schema's JSON-schema-like config,
 * with inline per-field validation via validate_plugin_schema (spec
 * §Functionality "Step 2 — Credentials").
 *
 * Reuses the existing connector-setup primitives (ConnectorSchemaProvider,
 * FieldRenderer, AuthSchemePicker — apps/app/src/components/connectors/)
 * rather than rebuilding dynamic-schema form rendering. Differs from
 * ConnectorConfigForm (which POSTs to install_integration/configure_integration
 * REST routes) by calling this wizard's own server actions
 * (validate_plugin_schema, create_connection) instead.
 */

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { AuthSchemePicker } from "@/components/connectors/auth-scheme-picker";
import {
  FieldRenderer,
  validateField,
} from "@/components/connectors/field-renderer";
import {
  ConnectorSchemaProvider,
  useConnectorSchema,
  type FieldError,
} from "@/components/connectors/connector-schema-provider";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

export interface CredentialsSubmitInput {
  displayName: string;
  connectionConfig: Record<string, unknown>;
  authCredential: Record<string, unknown>;
}

export type ValidateOutcome =
  | { valid: boolean; errors: FieldError[] }
  | { error: string };

interface FormSharedProps {
  connectorDisplayName: string;
  onValidate: (
    config: Record<string, unknown>,
    authSchemeId: string | null,
  ) => Promise<ValidateOutcome>;
  onSubmit: (input: CredentialsSubmitInput) => void;
  submitting: boolean;
  submitError: string | null;
  onBack: () => void;
}

export interface CredentialsStepProps extends FormSharedProps {
  connectorId: string;
  orgSlug: string;
  workspaceSlug: string;
  schema: ConnectorPluginSchema | null;
  schemaLoading: boolean;
  schemaError: string | null;
  onRetrySchema: () => void;
}

function CredentialsForm({
  connectorDisplayName,
  onValidate,
  onSubmit,
  submitting,
  submitError,
  onBack,
}: FormSharedProps) {
  const {
    schema,
    formState,
    selectedAuthSchemeId,
    setErrors,
    clearErrors,
    touchField,
  } = useConnectorSchema();
  const [displayName, setDisplayName] = React.useState(connectorDisplayName);
  const [displayNameError, setDisplayNameError] = React.useState<string | null>(
    null,
  );

  if (!schema) return null;

  const hasAuth = (schema.auth?.schemes ?? []).length > 0;
  const hasConfig = (schema.config?.fields ?? []).length > 0;
  const scheme = schema.auth?.schemes.find(
    (s) => s.id === selectedAuthSchemeId,
  );
  const isOAuthScheme =
    scheme?.kind === "oauth2_authorization_code" ||
    scheme?.kind === "oauth2_client_credentials";

  const handleNext = async () => {
    clearErrors();
    setDisplayNameError(null);

    if (!displayName.trim()) {
      setDisplayNameError("Connection name is required.");
      return;
    }

    // Client-side validation of required fields, mirroring
    // ConnectorConfigForm's runClientValidation.
    const clientErrors: FieldError[] = [];
    for (const field of schema.config?.fields ?? []) {
      touchField(field.key);
      const err = validateField(field, formState.values[field.key]);
      if (err)
        clientErrors.push({ field: field.key, message: err, code: "unknown" });
    }
    if (!isOAuthScheme) {
      for (const field of scheme?.fields ?? []) {
        touchField(field.key);
        const err = validateField(field, formState.values[field.key]);
        if (err)
          clientErrors.push({
            field: field.key,
            message: err,
            code: "unknown",
          });
      }
    }
    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      return;
    }

    // Server-side validation (validate_plugin_schema).
    const result = await onValidate(formState.values, selectedAuthSchemeId);
    if ("error" in result) {
      setErrors([{ field: "", message: result.error, code: "unknown" }]);
      return;
    }
    if (!result.valid) {
      setErrors(result.errors);
      return;
    }

    // Partition the flat form-values map into connectionConfig / authCredential
    // (ConnectorSchemaProvider stores both under the same flat key namespace).
    const configKeys = new Set((schema.config?.fields ?? []).map((f) => f.key));
    const authKeys = new Set((scheme?.fields ?? []).map((f) => f.key));
    const connectionConfig: Record<string, unknown> = {};
    const authCredential: Record<string, unknown> = {
      type: scheme?.kind ?? "none",
    };
    for (const [key, value] of Object.entries(formState.values)) {
      if (authKeys.has(key)) authCredential[key] = value;
      else if (configKeys.has(key)) connectionConfig[key] = value;
    }

    onSubmit({
      displayName: displayName.trim(),
      connectionConfig,
      authCredential,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="connection-display-name">Connection name</Label>
        <Input
          id="connection-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          disabled={submitting}
          aria-invalid={Boolean(displayNameError)}
        />
        {displayNameError && (
          <p className="text-xs text-destructive">{displayNameError}</p>
        )}
      </div>

      {hasAuth && (
        <section aria-labelledby="credentials-auth-heading">
          <p
            id="credentials-auth-heading"
            className="mb-2 text-sm font-semibold text-foreground"
          >
            Authentication
          </p>
          <AuthSchemePicker />
        </section>
      )}

      {hasConfig && (
        <section aria-labelledby="credentials-config-heading">
          <p
            id="credentials-config-heading"
            className="mb-2 text-sm font-semibold text-foreground"
          >
            Configuration
          </p>
          <div className="flex flex-col gap-5">
            {schema.config?.fields.map((field) => (
              <FieldRenderer
                key={field.key}
                field={field}
                namespace="config"
                disabled={submitting}
              />
            ))}
          </div>
        </section>
      )}

      {formState.errors.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-0.5">
            {formState.errors.slice(0, 3).map((e, i) => (
              <span key={i}>{e.message}</span>
            ))}
          </div>
        </div>
      )}

      {submitError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {submitError}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={submitting}
        >
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleNext}
          disabled={submitting}
          data-testid="credentials-next-btn"
        >
          {submitting ? (
            <>
              <Loader2
                className="mr-2 h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
              Connecting…
            </>
          ) : (
            "Next: Preview"
          )}
        </Button>
      </div>
    </div>
  );
}

export function CredentialsStep({
  connectorId,
  orgSlug,
  workspaceSlug,
  schema,
  schemaLoading,
  schemaError,
  onRetrySchema,
  ...formProps
}: CredentialsStepProps) {
  if (schemaLoading) {
    return (
      <div className="flex flex-col gap-5" data-testid="credentials-skeleton">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (schemaError || !schema) {
    return (
      <ErrorState
        title="Couldn't load this connector's configuration"
        description={schemaError ?? undefined}
        retry={onRetrySchema}
      />
    );
  }

  return (
    <ConnectorSchemaProvider
      pluginId={connectorId}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      initialSchema={schema}
    >
      <CredentialsForm {...formProps} />
    </ConnectorSchemaProvider>
  );
}
