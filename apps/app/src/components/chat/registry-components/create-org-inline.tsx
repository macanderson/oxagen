"use client";

import * as React from "react";
import { Building2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface CreateOrgInlineProps {
  orgSlug?: string;
  workspaceSlug?: string;
  /** Pre-suggested org name */
  suggestedName?: string;
}

type FormState = "idle" | "submitting" | "success" | "error";

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function CreateOrgInline({
  suggestedName = "",
}: CreateOrgInlineProps): React.ReactElement {
  const [name, setName] = React.useState(suggestedName);
  const [slug, setSlug] = React.useState(() => deriveSlug(suggestedName));
  const slugManuallyEdited = React.useRef(false);
  const [formState, setFormState] = React.useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();
  const nameId = React.useId();
  const slugId = React.useId();

  const isSubmitting = formState === "submitting";

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    const fd = new FormData(e.currentTarget);

    startTransition(async () => {
      try {
        const { createOrgAction } = await import(
          "@/app/(onboarding)/new-organization/actions"
        );
        const result = await createOrgAction(fd);
        if (result.ok) {
          setFormState("success");
          window.location.assign(`/${result.orgSlug}/${result.workspaceSlug}`);
        } else {
          setErrorMessage(result.error);
          setFormState("error");
        }
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to create organization",
        );
        setFormState("error");
      }
    });
  }

  if (formState === "success") {
    return (
      <div
        className={cn("rounded-2xl border border-border bg-card p-5 space-y-3")}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3">
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-foreground">
            Organization created — redirecting…
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Create organization"
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-5 w-full max-w-sm",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Building2
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Create organization
        </span>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          name="name"
          required
          maxLength={120}
          placeholder="Acme Inc."
          value={name}
          onChange={(e) => {
            const next = e.target.value;
            setName(next);
            if (!slugManuallyEdited.current || slug === "") {
              slugManuallyEdited.current = false;
              setSlug(deriveSlug(next));
            }
          }}
          disabled={isSubmitting}
          autoComplete="organization"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={slugId}>Slug</Label>
        <Input
          id={slugId}
          name="slug"
          required
          pattern="[a-z0-9\-]{2,40}"
          placeholder="acme"
          value={slug}
          onChange={(e) => {
            const next = e.target.value;
            slugManuallyEdited.current = next !== "";
            setSlug(next);
          }}
          disabled={isSubmitting}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Lowercase, digits, hyphens. 2–40 chars.
        </p>
      </div>

      {/* Hidden inputs the org create action expects */}
      <input type="hidden" name="type" value="business" />

      {formState === "error" && errorMessage !== null && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSubmitting || name.trim() === "" || slug.trim() === ""}
        className="w-full"
        aria-busy={isSubmitting}
      >
        {isSubmitting ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
