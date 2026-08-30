"use client";

/**
 * connector-schema-provider.tsx — Context provider for connector install/configure forms.
 *
 * Provides:
 *   - ConnectorPluginSchema (fetched from pluginSchemaGet API)
 *   - Form state: values, errors, touched fields
 *   - Auth scheme selection
 *   - Conditional field visibility (dependsOn logic)
 */

import * as React from "react";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FormValues = Record<string, unknown>;

export interface FieldError {
  field: string;
  message: string;
  code: string;
}

export interface ConnectorFormState {
  values: FormValues;
  errors: FieldError[];
  touched: Set<string>;
}

export interface ConnectorSchemaContextValue {
  schema: ConnectorPluginSchema | null;
  loading: boolean;
  fetchError: string | null;
  formState: ConnectorFormState;
  selectedAuthSchemeId: string | null;
  setFieldValue: (key: string, value: unknown) => void;
  touchField: (key: string) => void;
  setErrors: (errors: FieldError[]) => void;
  clearErrors: () => void;
  selectAuthScheme: (schemeId: string) => void;
  isFieldVisible: (
    fieldKey: string,
    dependsOn?: { field: string; value?: unknown },
  ) => boolean;
  resetForm: () => void;
}

// ── Context ────────────────────────────────────────────────────────────────────

const ConnectorSchemaContext =
  React.createContext<ConnectorSchemaContextValue | null>(null);

export function useConnectorSchema(): ConnectorSchemaContextValue {
  const ctx = React.useContext(ConnectorSchemaContext);
  if (!ctx) {
    throw new Error(
      "useConnectorSchema must be used within ConnectorSchemaProvider",
    );
  }
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = "/api";

function buildDefaultValues(schema: ConnectorPluginSchema | null): FormValues {
  if (!schema) return {};
  const values: FormValues = {};

  // Config field defaults
  for (const field of schema.config?.fields ?? []) {
    if (field.defaultValue !== undefined) {
      values[field.key] = field.defaultValue;
    }
  }

  // Auth field defaults (for currently selected scheme — set when scheme is chosen)
  return values;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface ConnectorSchemaProviderProps {
  pluginId: string;
  orgSlug: string;
  workspaceSlug: string;
  children: React.ReactNode;
  /** Pre-loaded schema (skips fetch). Used in SSR/test contexts. */
  initialSchema?: ConnectorPluginSchema;
  /**
   * Existing field values to seed the form with — merged OVER schema-derived
   * defaults. Used when editing an existing connection's config so the form
   * opens pre-filled with the current `deliveryConfig`. Omit for the install
   * flow (the form then starts from manifest defaults only).
   */
  initialValues?: FormValues;
}

export function ConnectorSchemaProvider({
  pluginId,
  orgSlug,
  workspaceSlug,
  children,
  initialSchema,
  initialValues,
}: ConnectorSchemaProviderProps) {
  const [schema, setSchema] = React.useState<ConnectorPluginSchema | null>(
    initialSchema ?? null,
  );
  const [loading, setLoading] = React.useState(!initialSchema);
  const [fetchError, setFetchError] = React.useState<string | null>(null);

  // Kept in a ref so the async schema-fetch effect can merge the latest seed
  // values without taking `initialValues` (a fresh object each render) as a
  // dependency — that would re-trigger the fetch on every parent re-render.
  const initialValuesRef = React.useRef(initialValues);
  React.useEffect(() => {
    initialValuesRef.current = initialValues;
  }, [initialValues]);

  const [formState, setFormState] = React.useState<ConnectorFormState>(() => ({
    values: {
      ...buildDefaultValues(initialSchema ?? null),
      ...(initialValues ?? {}),
    },
    errors: [],
    touched: new Set<string>(),
  }));

  const [selectedAuthSchemeId, setSelectedAuthSchemeId] = React.useState<
    string | null
  >(initialSchema?.auth?.schemes[0]?.id ?? null);

  // Fetch schema from API if not pre-loaded
  React.useEffect(() => {
    if (initialSchema) return;

    let cancelled = false;
    setLoading(true);
    setFetchError(null);

    fetch(
      // Route is mounted at /plugin-schema/:pluginId (see apps/api app.ts +
      // routes/v1/plugin-schema.ts). The previous /plugins/:id/schema path 404'd,
      // silently degrading every connector config form to "schema couldn't be loaded".
      `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/plugin-schema/${encodeURIComponent(pluginId)}`,
      { credentials: "include" },
    )
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `HTTP ${res.status}`);
        }
        return res.json() as Promise<ConnectorPluginSchema>;
      })
      .then((data) => {
        if (cancelled) return;
        setSchema(data);
        setFormState({
          values: {
            ...buildDefaultValues(data),
            ...(initialValuesRef.current ?? {}),
          },
          errors: [],
          touched: new Set<string>(),
        });
        setSelectedAuthSchemeId(data.auth?.schemes[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetchError(
          err instanceof Error
            ? err.message
            : "Failed to load connector schema",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pluginId, orgSlug, workspaceSlug, initialSchema]);

  const setFieldValue = React.useCallback((key: string, value: unknown) => {
    setFormState((prev) => ({
      ...prev,
      values: { ...prev.values, [key]: value },
      // Clear errors for this field on change
      errors: prev.errors.filter(
        (e) => e.field !== key && e.field !== `config.${key}`,
      ),
    }));
  }, []);

  const touchField = React.useCallback((key: string) => {
    setFormState((prev) => {
      const next = new Set(prev.touched);
      next.add(key);
      return { ...prev, touched: next };
    });
  }, []);

  const setErrors = React.useCallback((errors: FieldError[]) => {
    setFormState((prev) => ({ ...prev, errors }));
  }, []);

  const clearErrors = React.useCallback(() => {
    setFormState((prev) => ({ ...prev, errors: [] }));
  }, []);

  const selectAuthScheme = React.useCallback(
    (schemeId: string) => {
      setSelectedAuthSchemeId(schemeId);
      // Reset the INCOMING scheme's fields to their declared defaults so the
      // form does not open on a stale value.
      //
      // Known gap: the OUTGOING scheme's fields are left in `values`, so a
      // credential typed under one scheme is still present (and still
      // submitted) after switching to another. Clearing them needs the
      // previously-selected scheme's field list, which this callback does not
      // have — see the audit finding on connector auth-scheme switching.
      const scheme = schema?.auth?.schemes.find((s) => s.id === schemeId);
      if (scheme?.fields) {
        setFormState((prev) => {
          const next = { ...prev.values };
          for (const field of scheme.fields ?? []) {
            if (field.defaultValue !== undefined) {
              next[field.key] = field.defaultValue;
            } else {
              delete next[field.key];
            }
          }
          return { ...prev, values: next };
        });
      }
    },
    [schema],
  );

  const isFieldVisible = React.useCallback(
    (
      _fieldKey: string,
      dependsOn?: { field: string; value?: unknown },
    ): boolean => {
      if (!dependsOn) return true;
      // Check against auth fields and config fields in form values
      const currentValue = formState.values[dependsOn.field];
      return currentValue === dependsOn.value;
    },
    [formState.values],
  );

  const resetForm = React.useCallback(() => {
    setFormState({
      values: {
        ...buildDefaultValues(schema),
        ...(initialValuesRef.current ?? {}),
      },
      errors: [],
      touched: new Set<string>(),
    });
    setSelectedAuthSchemeId(schema?.auth?.schemes[0]?.id ?? null);
  }, [schema]);

  const ctx = React.useMemo<ConnectorSchemaContextValue>(
    () => ({
      schema,
      loading,
      fetchError,
      formState,
      selectedAuthSchemeId,
      setFieldValue,
      touchField,
      setErrors,
      clearErrors,
      selectAuthScheme,
      isFieldVisible,
      resetForm,
    }),
    [
      schema,
      loading,
      fetchError,
      formState,
      selectedAuthSchemeId,
      setFieldValue,
      touchField,
      setErrors,
      clearErrors,
      selectAuthScheme,
      isFieldVisible,
      resetForm,
    ],
  );

  return (
    <ConnectorSchemaContext.Provider value={ctx}>
      {children}
    </ConnectorSchemaContext.Provider>
  );
}
