"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useRegisterFillableForm,
  useRegisterPageEntity,
} from "@/lib/page-context";
import type { FillableFormSpec, FieldDescriptor } from "@/lib/ask/fill-types";
import { slugify } from "@/lib/slug";
import { AvatarMaker } from "@/components/avatar/avatar-maker";
import { updateWorkspaceGeneralAction } from "./actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkspaceGeneralFormProps {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  initialName: string;
  initialSlug: string;
  initialDescription: string;
  initialAvatarUrl: string | null;
}

interface FormValues {
  name: string;
  slug: string;
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
  initialSlug,
  initialDescription,
  initialAvatarUrl,
}: WorkspaceGeneralFormProps) {
  const router = useRouter();
  const [values, setValues] = React.useState<FormValues>({
    name: initialName,
    slug: initialSlug,
    description: initialDescription,
  });
  // Avatar value (photo URL or designed spec string) — saved with the form.
  const [avatarUrl, setAvatarUrl] = React.useState<string>(
    initialAvatarUrl ?? "",
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
        name: "slug",
        label: "Workspace slug",
        type: "text",
        current: values.slug,
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
    [values.name, values.slug, values.description],
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
    (
      proposed: Record<string, unknown>,
      _mode: "field" | "all",
      _fieldName?: string,
    ) => {
      setValues((prev) => ({
        name: typeof proposed.name === "string" ? proposed.name : prev.name,
        slug:
          typeof proposed.slug === "string"
            ? slugify(proposed.slug)
            : prev.slug,
        description:
          typeof proposed.description === "string"
            ? proposed.description
            : prev.description,
      }));
    },
    [],
  );

  // Register (and auto-unregister on unmount) with the B2 Ask system.
  useRegisterFillableForm({ ...spec, apply });

  // -------------------------------------------------------------------------
  // Save handler — calls the server action, never throws on the happy path.
  // A rejected save (slug conflict, role denial) is reported inline rather
  // than dropped: the action already maps those to user-facing copy, and a
  // silent no-op reads to the user as a successful save. Mirrors
  // ../agent-defaults/models-form.tsx.
  // -------------------------------------------------------------------------
  async function handleSave(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      const result = await updateWorkspaceGeneralAction({
        orgSlug,
        workspaceSlug,
        name: values.name,
        slug: values.slug,
        description: values.description || undefined,
        avatarUrl,
      });
      if (result.ok) {
        setSavedAt(new Date());
        // The slug is part of the route. If it changed, the current URL is now
        // stale — move the user to the canonical path for the new slug.
        if (result.slug !== workspaceSlug) {
          router.replace(`/${orgSlug}/${result.slug}/settings/general`);
        }
      } else {
        setError(result.error);
      }
    } catch {
      // Policy §0.5: never surface a raw thrown error that crashes the form.
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Field change handlers
  // -------------------------------------------------------------------------
  function handleChange(field: keyof FormValues, value: string) {
    setValues((prev) => {
      const next = { ...prev, [field]: value };
      // While the slug is empty, keep deriving it from the name as the user
      // types — so an emptied slug refills the moment they edit the name.
      if (field === "name" && prev.slug.trim() === "") {
        next.slug = slugify(value);
      }
      return next;
    });
    setSavedAt(null);
  }

  // The slug input always normalizes user keystrokes to a valid slug.
  function handleSlugChange(value: string) {
    setValues((prev) => ({ ...prev, slug: slugify(value) }));
    setSavedAt(null);
  }

  // Focusing the name field while the slug is empty seeds the slug from the
  // current name (covers the case where the name was set before the slug was
  // cleared and the user simply tabs back into the name field).
  function handleNameFocus() {
    setValues((prev) =>
      prev.slug.trim() === "" ? { ...prev, slug: slugify(prev.name) } : prev,
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="max-w-2xl">
      <form
        onSubmit={handleSave}
        aria-label="Workspace general settings"
        className="flex flex-col gap-6"
        noValidate
      >
        {/* Workspace avatar — photo upload+crop or designed emoji/color tile.
            Saved with the rest of the form through workspace.settings.write. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium leading-none text-foreground">
            Avatar
          </span>
          <AvatarMaker
            value={avatarUrl || null}
            onChange={(next) => {
              setAvatarUrl(next);
              setSavedAt(null);
            }}
            name={values.name || workspaceSlug}
            shape="square"
            entityLabel="workspace"
            disabled={isSaving}
          />
        </div>

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
          <Input
            id="ws-name"
            name="name"
            type="text"
            required
            autoComplete="organization"
            value={values.name}
            onChange={(e) => handleChange("name", e.target.value)}
            onFocus={handleNameFocus}
            placeholder="Production"
          />
          <p className="text-xs text-muted-foreground">
            Visible to all workspace members.
          </p>
        </div>

        {/* Slug */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="ws-slug"
            className="text-sm font-medium leading-none text-foreground"
          >
            Workspace slug
            <span className="ml-1 text-destructive" aria-hidden="true">
              *
            </span>
          </label>
          <Input
            id="ws-slug"
            name="slug"
            type="text"
            required
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={values.slug}
            onChange={(e) => handleSlugChange(e.target.value)}
            placeholder="production"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Used in this workspace&rsquo;s URL. Lowercase letters, numbers, and
            hyphens only. Clear it and edit the name to regenerate it.
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
          <Textarea
            id="ws-description"
            name="description"
            rows={3}
            autoComplete="off"
            value={values.description}
            onChange={(e) => handleChange("description", e.target.value)}
            placeholder="What this workspace is for…"
            className="resize-none"
          />
          <p className="text-xs text-muted-foreground">
            Displayed in the workspace switcher and surfaced to the Ask system.
          </p>
        </div>

        {/* Error state */}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Footer: save button + saved indicator */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            variant="gradient"
            size="sm"
            className="max-md:h-11"
            disabled={isSaving || !values.name.trim() || !values.slug.trim()}
            startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
          >
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
