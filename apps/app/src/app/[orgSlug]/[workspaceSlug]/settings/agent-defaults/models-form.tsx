"use client";
/**
 * models-form.tsx — client component for Workspace → Settings → Models.
 *
 * Renders <ModelDefaultsFields> scoped to "workspace" and saves changes via the
 * updateWorkspaceModelsAction server action. Save/toast UX mirrors the workspace
 * general settings pattern.
 */
import * as React from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModelDefaultsValue } from "@/components/settings/model-defaults-fields";
import { ModelDefaultsFields } from "@/components/settings/model-defaults-fields";
import type { WorkspaceModelsActionResult } from "./models-action";
import { updateWorkspaceModelsAction } from "./models-action";
import { useRegisterFillableForm } from "@/lib/page-context";
import type { FieldDescriptor } from "@/lib/ask/fill-types";

// ── Props ──────────────────────────────────────────────────────────────────────

export interface WorkspaceModelsFormProps {
  /** Current workspace model defaults (from workspace.model.settings.read). */
  initial: ModelDefaultsValue;
  /** Whether the viewing user may save changes (workspace owner or admin). */
  canEdit: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WorkspaceModelsForm({
  initial,
  canEdit,
  orgSlug,
  workspaceSlug,
}: WorkspaceModelsFormProps) {
  const [value, setValue] = React.useState<ModelDefaultsValue>(initial);
  const [isSaving, setIsSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const modelDefaultsFields = React.useMemo<FieldDescriptor[]>(
    () => [
      {
        name: "textTier",
        label: "Default text tier",
        type: "select",
        current: value.textTier ?? "",
        options: [
          { label: "Fast", value: "fast" },
          { label: "Balanced", value: "balanced" },
          { label: "Precise", value: "precise" },
        ],
        required: false,
      },
      {
        name: "textModel",
        label: "Default text model",
        type: "text",
        current: value.textModel ?? "",
        required: false,
      },
      {
        name: "imageModel",
        label: "Default image model",
        type: "text",
        current: value.imageModel ?? "",
        required: false,
      },
      {
        name: "videoModel",
        label: "Default video model",
        type: "text",
        current: value.videoModel ?? "",
        required: false,
      },
    ],
    [value],
  );

  const applyModelDefaults = React.useCallback(
    (proposed: Record<string, unknown>) => {
      setValue((prev) => ({
        textTier:
          proposed.textTier === "fast" ||
          proposed.textTier === "balanced" ||
          proposed.textTier === "precise"
            ? proposed.textTier
            : prev.textTier,
        textModel:
          typeof proposed.textModel === "string"
            ? proposed.textModel || null
            : prev.textModel,
        imageModel:
          typeof proposed.imageModel === "string"
            ? proposed.imageModel || null
            : prev.imageModel,
        videoModel:
          typeof proposed.videoModel === "string"
            ? proposed.videoModel || null
            : prev.videoModel,
      }));
    },
    [],
  );

  useRegisterFillableForm({
    formId: `workspace-models-${workspaceSlug}`,
    title: "Workspace model defaults",
    fields: modelDefaultsFields,
    apply: applyModelDefaults,
  });

  async function handleSave(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      const result: WorkspaceModelsActionResult =
        await updateWorkspaceModelsAction({
          orgSlug,
          workspaceSlug,
          defaultTextTier: value.textTier,
          defaultTextModel: value.textModel,
          defaultImageModel: value.imageModel,
          defaultVideoModel: value.videoModel,
        });
      if (result.ok) {
        setSavedAt(new Date());
      } else {
        setError(result.error);
      }
    } catch {
      // Policy §0.5: never surface a raw thrown error in the form UI.
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <form
        onSubmit={handleSave}
        aria-label="Workspace AI model defaults"
        className="flex flex-col gap-6"
        noValidate
      >
        <ModelDefaultsFields
          scope="workspace"
          value={value}
          onChange={setValue}
          disabled={!canEdit || isSaving}
        />

        {/* Error state */}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Footer: save button + confirmation */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            variant="gradient"
            size="sm"
            className="max-md:h-11"
            disabled={isSaving || !canEdit}
            startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {isSaving ? "Saving…" : "Save changes"}
          </Button>

          {savedAt !== null && (
            <p className="text-xs text-muted-foreground">
              Saved at{" "}
              {savedAt.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}

          {!canEdit && (
            <p className="text-xs text-muted-foreground">
              Only workspace owners and admins can edit model defaults.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
