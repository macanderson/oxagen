"use client";

import * as React from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRegisterFillableForm, useRegisterPageEntity } from "@/lib/page-context";
import type { FillableFormSpec, FieldDescriptor } from "@/lib/ask/fill-types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkspaceGeneralFormProps {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  initialName: string;
}

interface FormValues {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceGeneralForm({
  orgSlug,
  workspaceSlug,
  workspaceId,
  initialName,
}: WorkspaceGeneralFormProps) {
  const [values, setValues] = React.useState<FormValues>({
    name: initialName,
    description: "",
  });
  const [isSaving, setIsSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);

  // -------------------------------------------------------------------------
  // Register the workspace entity with the Ask system.
  // -------------------------------------------------------------------------
  useRegisterPageEntity({
    kind: "workspace",
    id: workspaceId,
    label: values.name,
    summary: values.description
      ? `Workspace "${values.name}". ${values.description}`
      : `Workspace "${values.name}".`,
  });

  // -------------------------------------------------------------------------
  // Build the FillableFormSpec from current values.
  // Recomputed whenever values change so the fill engine always sees current state.
  // -------------------------------------------------------------------------
  const fields = React.useMemo<FieldDescriptor[]>(
    () => [
      {
        name: "name",
        label: "Workspace name",
        type: "text",
        current: values.name,
        required: true,
      },
      {
        name: "description",
        label: "Description",
        type: "textarea",
        current: values.description,
        required: false,
      },
    ],
    [values.name, values.description],
  );

  const spec: FillableFormSpec = React.useMemo(
    () => ({
      formId: "workspace-general",
      title: "Workspace settings",
      fields,
    }),
    [fields],
  );

  // apply callback: receives AI-proposed values and merges them into local state.
  const apply = React.useCallback(
    (proposed: Record<string, unknown>, _mode: "field" | "all", _fieldName?: string) => {
      setValues((prev) => ({
        name: typeof proposed.name === "string" ? proposed.name : prev.name,
        description:
          typeof proposed.description === "string" ? proposed.description : prev.description,
      }));
    },
    [],
  );

  // Register (and auto-unregister on unmount) with the B2 Ask system.
  useRegisterFillableForm({ ...spec, apply });

  // -------------------------------------------------------------------------
  // Save handler — stubs persistence, never throws.
  // -------------------------------------------------------------------------
  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    try {
      // Stub: A real implementation would call a server action
      // that writes `name` to `workspaces.name` and `description` to
      // `workspaces.settings->>'description'` (or a future dedicated column).
      // Simulate async
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      setSavedAt(new Date());
    } catch {
      // Policy §0.5: never surface an error that crashes the form.
    } finally {
      setIsSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Field change handler
  // -------------------------------------------------------------------------
  function handleChange(field: keyof FormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setSavedAt(null);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-2xl">
      <form
        onSubmit={handleSave}
        aria-label="Workspace general settings"
        className="flex flex-col gap-6"
        noValidate
      >
        {/* Workspace name */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="ws-name"
            className="text-sm font-medium leading-none text-foreground"
          >
            Workspace name
            <span className="ml-1 text-destructive" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="ws-name"
            name="name"
            type="text"
            required
            autoComplete="organization"
            value={values.name}
            onChange={(e) => handleChange("name", e.target.value)}
            placeholder="Production"
            className={cn(
              "h-10 w-full rounded-xl border border-border/70 bg-background px-3 py-2",
              "text-sm text-foreground placeholder:text-muted-foreground",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <p className="text-xs text-muted-foreground">
            Visible to all workspace members.
          </p>
        </div>

        {/* Description */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="ws-description"
            className="text-sm font-medium leading-none text-foreground"
          >
            Description
          </label>
          <textarea
            id="ws-description"
            name="description"
            rows={3}
            autoComplete="off"
            value={values.description}
            onChange={(e) => handleChange("description", e.target.value)}
            placeholder="What this workspace is for…"
            className={cn(
              "w-full resize-none rounded-xl border border-border/70 bg-background px-3 py-2.5",
              "text-sm text-foreground placeholder:text-muted-foreground",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <p className="text-xs text-muted-foreground">
            Displayed in the workspace switcher and surfaced to the Ask system.
          </p>
        </div>

        {/* Footer: save button + saved indicator */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            size="sm"
            disabled={isSaving || !values.name.trim()}
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {isSaving ? "Saving…" : "Save changes"}
          </Button>

          {savedAt && (
            <p className="text-xs text-muted-foreground">
              Saved at{" "}
              {savedAt.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
