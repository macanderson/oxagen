"use client";

/**
 * edit-source-config-sheet.tsx — Edit an existing source connection's dynamic
 * configuration from the Knowledge → Sources tab.
 *
 * The editable fields are driven entirely by the connector type manifest's
 * `config.fields` (fetched via `plugin.schema.get` inside ConnectorSchemaProvider
 * and rendered by the shared FieldRenderer widget map). Current values are
 * pre-filled from the connection's stored `deliveryConfig` (fetched via
 * `connection.get`), and the form submits through `connection.update`
 * (PATCH /connections/:id).
 *
 * IMPORTANT — merge, don't replace. `connection.update` does a full overwrite of
 * `deliveryConfig`, but that JSONB also holds operational keys that are NOT part
 * of the manifest schema (e.g. `owner`/`repo`/`defaultBranch` used by the resync
 * path). We therefore submit `{ ...existingConfig, ...editedSchemaFields }` so
 * those non-schema keys survive an edit.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertTriangle } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetPanel,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  ConnectorSchemaProvider,
  useConnectorSchema,
  type FormValues,
} from "@/components/connectors/connector-schema-provider";
import {
  FieldRenderer,
  validateField,
} from "@/components/connectors/field-renderer";

const API_BASE = "/api";

export interface EditSourceTarget {
  publicId: string;
  connectorId: string;
  displayName: string;
}

export interface EditSourceConfigSheetProps {
  open: boolean;
  onClose: () => void;
  orgSlug: string;
  workspaceSlug: string;
  /** The connection being edited. `null` while no row is targeted. */
  target: EditSourceTarget | null;
}

interface LoadedConnection {
  displayName: string;
  deliveryConfig: FormValues;
}

// ── Outer sheet shell: fetches current config, then mounts the schema provider ──

export function EditSourceConfigSheet({
  open,
  onClose,
  orgSlug,
  workspaceSlug,
  target,
}: EditSourceConfigSheetProps) {
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<LoadedConnection | null>(null);

  React.useEffect(() => {
    if (!open || !target) {
      setLoaded(null);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setLoaded(null);

    fetch(
      `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/${target.publicId}`,
      {
        credentials: "include",
      },
    )
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `HTTP ${res.status}`);
        }
        return res.json() as Promise<{
          displayName: string;
          deliveryConfig: Record<string, unknown> | null;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setLoaded({
          displayName: data.displayName,
          deliveryConfig: (data.deliveryConfig as FormValues | null) ?? {},
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load connection",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, target, orgSlug, workspaceSlug]);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetPopup
        side="right"
        className="flex w-full max-w-md flex-col"
        data-testid="edit-source-sheet"
      >
        <SheetHeader>
          <SheetTitle>Edit configuration</SheetTitle>
          <SheetDescription>
            {target ? (
              <>
                Adjust how{" "}
                <span className="font-medium text-foreground">
                  {target.displayName}
                </span>{" "}
                syncs into your knowledge graph.
              </>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <SheetPanel className="flex flex-col gap-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </SheetPanel>
        )}

        {!loading && loadError && (
          <SheetPanel>
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
              role="alert"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive"
                aria-hidden="true"
              />
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-foreground">
                  Couldn&apos;t load configuration
                </p>
                <p className="text-xs text-muted-foreground">{loadError}</p>
              </div>
            </div>
          </SheetPanel>
        )}

        {!loading && !loadError && loaded && target && (
          <ConnectorSchemaProvider
            pluginId={target.connectorId}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            initialValues={loaded.deliveryConfig}
          >
            <EditSourceConfigForm
              publicId={target.publicId}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              initialDisplayName={loaded.displayName}
              existingConfig={loaded.deliveryConfig}
              onClose={onClose}
            />
          </ConnectorSchemaProvider>
        )}
      </SheetPopup>
    </Sheet>
  );
}

// ── Inner form: consumes the schema context, renders fields, submits ───────────

interface EditSourceConfigFormProps {
  publicId: string;
  orgSlug: string;
  workspaceSlug: string;
  initialDisplayName: string;
  existingConfig: FormValues;
  onClose: () => void;
}

function EditSourceConfigForm({
  publicId,
  orgSlug,
  workspaceSlug,
  initialDisplayName,
  existingConfig,
  onClose,
}: EditSourceConfigFormProps) {
  const router = useRouter();
  const { add: addToast } = useToast();
  const { schema, loading, fetchError, formState, setErrors, touchField } =
    useConnectorSchema();

  const [displayName, setDisplayName] = React.useState(initialDisplayName);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const configFields = React.useMemo(
    () => schema?.config?.fields ?? [],
    [schema],
  );

  const handleSave = React.useCallback(async () => {
    setSubmitError(null);

    // Validate every config field against its manifest validation rules.
    const errors = configFields
      .map((field) => {
        const message = validateField(field, formState.values[field.key]);
        return message ? { field: field.key, message, code: "invalid" } : null;
      })
      .filter(
        (e): e is { field: string; message: string; code: string } =>
          e !== null,
      );

    if (errors.length > 0) {
      setErrors(errors);
      errors.forEach((e) => touchField(e.field));
      return;
    }

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setSubmitError("Display name is required.");
      return;
    }

    // Build the PATCH body. Only send what changed; merge edited schema fields
    // OVER the full existing config so non-schema operational keys survive.
    const body: { displayName?: string; deliveryConfig?: FormValues } = {};
    if (trimmedName !== initialDisplayName) body.displayName = trimmedName;

    if (configFields.length > 0) {
      const editedConfig: FormValues = {};
      for (const field of configFields) {
        editedConfig[field.key] = formState.values[field.key];
      }
      body.deliveryConfig = { ...existingConfig, ...editedConfig };
    }

    if (body.displayName === undefined && body.deliveryConfig === undefined) {
      // Nothing changed — just close.
      onClose();
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/${publicId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed (${res.status})`);
      }
      addToast({
        title: "Configuration saved",
        description: `"${trimmedName}" was updated.`,
        type: "success",
      });
      onClose();
      router.refresh();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Failed to save configuration";
      setSubmitError(message);
      addToast({ title: "Save failed", description: message, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }, [
    configFields,
    formState.values,
    displayName,
    initialDisplayName,
    existingConfig,
    orgSlug,
    workspaceSlug,
    publicId,
    setErrors,
    touchField,
    addToast,
    onClose,
    router,
  ]);

  return (
    <>
      <SheetPanel className="flex flex-col gap-5 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-source-display-name">Display name</Label>
          <Input
            id="edit-source-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
            placeholder="e.g. Acme org repos"
            data-testid="edit-source-display-name"
          />
        </div>

        {loading && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {!loading && fetchError && (
          <p className="text-xs text-muted-foreground">
            This connector&apos;s configuration schema couldn&apos;t be loaded (
            {fetchError}). You can still rename the source.
          </p>
        )}

        {!loading && !fetchError && configFields.length === 0 && (
          <p className="text-xs text-muted-foreground">
            This source has no editable configuration beyond its name.
          </p>
        )}

        {!loading && !fetchError && configFields.length > 0 && (
          <div
            className="flex flex-col gap-4"
            data-testid="edit-source-config-fields"
          >
            {configFields.map((field) => (
              <FieldRenderer
                key={field.key}
                field={field}
                disabled={submitting}
              />
            ))}
          </div>
        )}

        {submitError && (
          <p role="alert" className="text-xs text-destructive">
            {submitError}
          </p>
        )}
      </SheetPanel>

      <SheetFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={submitting}
          data-testid="save-source-config-btn"
        >
          {submitting && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          )}
          Save changes
        </Button>
      </SheetFooter>
    </>
  );
}
