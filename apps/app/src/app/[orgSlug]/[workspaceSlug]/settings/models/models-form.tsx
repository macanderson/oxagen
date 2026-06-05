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

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      const result: WorkspaceModelsActionResult = await updateWorkspaceModelsAction({
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
            size="sm"
            disabled={isSaving || !canEdit}
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
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
