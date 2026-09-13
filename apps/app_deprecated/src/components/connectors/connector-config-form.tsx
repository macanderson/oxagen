"use client";

/**
 * connector-config-form.tsx — Top-level form for connector install/configure.
 *
 * Renders all form sections in sequence:
 *   1. Auth scheme picker (if auth.schemes defined)
 *   2. Config fields
 *   3. Record type selector
 *   4. Filters panel (if enabled)
 *   5. Sync cadence panel
 *
 * Calls integration.install (new) or integration.configure (update) on submit.
 * Runs pluginSchemaValidate before submit for server-side validation.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Loader2 } from "lucide-react";
import { AuthSchemePicker } from "./auth-scheme-picker";
import { FieldRenderer, validateField } from "./field-renderer";
import { RecordTypeSelector } from "./record-type-selector";
import { FiltersPanel } from "./filters-panel";
import { SyncCadencePanel } from "./sync-cadence-panel";
import {
  useConnectorSchema,
  type FieldError,
} from "./connector-schema-provider";

// ── Types ──────────────────────────────────────────────────────────────────────

const API_BASE = "/api";

export interface ConnectorConfigFormProps {
  orgSlug: string;
  workspaceSlug: string;
  /** "install" for new connections, "configure" for editing existing */
  mode?: "install" | "configure";
  /** Existing integration ID — required when mode="configure" */
  integrationId?: string;
  /** Display name for this connection */
  displayName?: string;
  onSuccess?: (result: { jobId: string; status: string }) => void;
  onCancel?: () => void;
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/40 pb-3 mb-4">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────────

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

// ── ConnectorConfigForm ────────────────────────────────────────────────────────

export function ConnectorConfigForm({
  orgSlug,
  workspaceSlug,
  mode = "install",
  integrationId,
  displayName,
  onSuccess,
  onCancel,
}: ConnectorConfigFormProps) {
  const {
    schema,
    loading,
    fetchError,
    formState,
    selectedAuthSchemeId,
    setErrors,
    clearErrors,
    touchField,
  } = useConnectorSchema();

  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Client-side validation of all fields
  const runClientValidation = React.useCallback((): FieldError[] => {
    if (!schema) return [];
    const errors: FieldError[] = [];

    // Touch all fields on submit
    for (const field of schema.config?.fields ?? []) {
      touchField(field.key);
    }
    const scheme = schema.auth?.schemes.find(
      (s) => s.id === selectedAuthSchemeId,
    );
    for (const field of scheme?.fields ?? []) {
      touchField(field.key);
    }

    // Validate config fields
    for (const field of schema.config?.fields ?? []) {
      const err = validateField(field, formState.values[field.key]);
      if (err) {
        errors.push({ field: field.key, message: err, code: "unknown" });
      }
    }

    // Validate auth fields (API key / basic schemes)
    const isOAuth =
      scheme?.kind === "oauth2_authorization_code" ||
      scheme?.kind === "oauth2_client_credentials";
    if (!isOAuth) {
      for (const field of scheme?.fields ?? []) {
        const err = validateField(field, formState.values[field.key]);
        if (err) {
          errors.push({ field: field.key, message: err, code: "unknown" });
        }
      }
    }

    return errors;
  }, [schema, formState.values, selectedAuthSchemeId, touchField]);

  const handleSubmit = React.useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!schema) return;

      clearErrors();
      setSubmitError(null);

      // 1. Client-side validation
      const clientErrors = runClientValidation();
      if (clientErrors.length > 0) {
        setErrors(clientErrors);
        return;
      }

      setSubmitting(true);

      try {
        // 2. Server-side schema validation
        const validateRes = await fetch(
          // Route is /plugin-schema/:pluginId/validate (not /plugins/:id/schema/validate).
          `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/plugin-schema/${encodeURIComponent(schema.metadata.id)}/validate`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pluginId: schema.metadata.id,
              authSchemeId: selectedAuthSchemeId ?? undefined,
              config: formState.values,
            }),
          },
        );

        if (validateRes.ok) {
          const validateData = (await validateRes.json()) as {
            valid: boolean;
            errors: FieldError[];
          };
          if (!validateData.valid && validateData.errors.length > 0) {
            setErrors(validateData.errors);
            setSubmitting(false);
            return;
          }
        } else {
          // Non-2xx from the validation endpoint is a hard failure, not a
          // silent degradation. Surface it so the user knows validation could
          // not run rather than letting potentially-invalid credentials through.
          const msg = `Validation service unavailable (HTTP ${validateRes.status}) — please try again.`;
          setSubmitError(msg);
          setSubmitting(false);
          return;
        }

        // 3. Submit: install or configure.
        // Routes are POST /integrations (root — install_integration) and
        // PATCH /integrations/:id/configure (configure_integration); see
        // apps/api/src/routes/v1/integration.ts. Both matter: a plain
        // /integrations/install path 404s (there is no such sub-route), and
        // configure only responds to PATCH, not POST.
        const isConfigure = mode === "configure" && Boolean(integrationId);
        const endpoint = isConfigure
          ? `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/integrations/${encodeURIComponent(integrationId ?? "")}/configure`
          : `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/integrations`;

        const body = {
          pluginId: schema.metadata.id,
          displayName: displayName ?? schema.metadata.displayName,
          config: formState.values,
          authSchemeId: selectedAuthSchemeId ?? undefined,
        };

        const res = await fetch(endpoint, {
          method: isConfigure ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;

        if (!res.ok) {
          const msg =
            typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
          setSubmitError(msg);
          return;
        }

        onSuccess?.({
          jobId: typeof data.jobId === "string" ? data.jobId : "",
          status: typeof data.status === "string" ? data.status : "queued",
        });
      } catch (err: unknown) {
        setSubmitError(
          err instanceof Error ? err.message : "Something went wrong",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      schema,
      formState.values,
      selectedAuthSchemeId,
      orgSlug,
      workspaceSlug,
      mode,
      integrationId,
      displayName,
      clearErrors,
      runClientValidation,
      setErrors,
      onSuccess,
    ],
  );

  if (loading) return <FormSkeleton />;

  if (fetchError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        Failed to load connector schema: {fetchError}
      </div>
    );
  }

  if (!schema) return null;

  const hasAuth = (schema.auth?.schemes ?? []).length > 0;
  const hasConfig = (schema.config?.fields ?? []).length > 0;
  const hasRecordTypes = (schema.recordTypes?.items ?? []).length > 0;
  const hasFilters =
    schema.filters?.pathFilters?.enabled === true ||
    schema.filters?.labelFilters?.enabled === true;
  const hasSync = Boolean(schema.sync);

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-8">
      {/* Auth section */}
      {hasAuth && (
        <section aria-labelledby="auth-section-heading">
          <SectionHeader
            title="Authentication"
            description="How Oxagen will authenticate with this service."
          />
          <AuthSchemePicker />
        </section>
      )}

      {/* Config fields */}
      {hasConfig && (
        <section aria-labelledby="config-section-heading">
          <SectionHeader
            title="Configuration"
            description="Settings for what to sync from this connector."
          />
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

      {/* Record types */}
      {hasRecordTypes && (
        <section aria-labelledby="record-types-section-heading">
          <RecordTypeSelector />
        </section>
      )}

      {/* Filters */}
      {hasFilters && (
        <section aria-labelledby="filters-section-heading">
          <SectionHeader
            title="Filters"
            description="Narrow which items get synced."
          />
          <FiltersPanel />
        </section>
      )}

      {/* Sync cadence */}
      {hasSync && (
        <section aria-labelledby="sync-section-heading">
          <SyncCadencePanel />
        </section>
      )}

      {/* Global errors */}
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
            {formState.errors.length > 3 && (
              <span className="text-muted-foreground">
                …and {formState.errors.length - 3} more error
                {formState.errors.length - 3 !== 1 ? "s" : ""}
              </span>
            )}
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

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 border-t border-border/40 pt-4">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2
                className="mr-2 h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
              {mode === "configure" ? "Saving…" : "Connecting…"}
            </>
          ) : mode === "configure" ? (
            "Save changes"
          ) : (
            "Connect"
          )}
        </Button>
      </div>
    </form>
  );
}
