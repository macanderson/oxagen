"use client";
/**
 * new-skill-dialog.tsx — "New skill" create form for Studio → Skills.
 *
 * Controlled dialog wrapping a form that calls `createSkillAction`
 * (skill.create). Slug auto-derives from the name (kebab-case) until the
 * user edits it directly. Weight maps to the skill.md frontmatter's
 * `metadata.weight` (composed server-side in createSkillAction).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, Radio } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { cn } from "@oxagen/ui";
import { Loader2 } from "lucide-react";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export type CreateSkillAction = (input: {
  orgSlug: string;
  workspaceSlug: string;
  name: string;
  slug: string;
  description: string;
  weight: "low" | "high" | "critical";
  body: string;
  activate: boolean;
}) => Promise<{ ok: true; slug: string } | { ok: false; error: string }>;

export interface NewSkillDialogProps {
  orgSlug: string;
  workspaceSlug: string;
  action: CreateSkillAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MAX_BODY_LENGTH = 32_000;
const WEIGHT_OPTIONS: Array<{ value: "low" | "high" | "critical"; label: string; hint: string }> = [
  { value: "low", label: "Low", hint: "Rarely needed background context" },
  { value: "high", label: "High", hint: "Load whenever the topic is relevant" },
  { value: "critical", label: "Critical", hint: "Always keep in context" },
];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function NewSkillDialog({
  orgSlug,
  workspaceSlug,
  action,
  open,
  onOpenChange,
}: NewSkillDialogProps) {
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugEdited, setSlugEdited] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [weight, setWeight] = React.useState<"low" | "high" | "critical">("low");
  const [body, setBody] = React.useState("");
  const [activate, setActivate] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    setName("");
    setSlug("");
    setSlugEdited(false);
    setDescription("");
    setWeight("low");
    setBody("");
    setActivate(true);
    setError(null);
  }, []);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };

  const handleSlugChange = (value: string) => {
    setSlugEdited(true);
    setSlug(slugify(value));
  };

  const canSubmit =
    name.trim().length > 0 &&
    slug.trim().length > 0 &&
    description.trim().length > 0 &&
    body.trim().length > 0 &&
    body.length <= MAX_BODY_LENGTH &&
    !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await action({
        orgSlug,
        workspaceSlug,
        name: name.trim(),
        slug,
        description: description.trim(),
        weight,
        body,
        activate,
      });

      if (result.ok) {
        toast.add({ title: "Skill created", description: `${name.trim()} (${result.slug})` });
        const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
        onOpenChange(false);
        reset();
        router.push(workspace.studio.skill(routeCtx, result.slug));
        router.refresh();
      } else {
        setError(result.error);
        toast.add({ title: "Create failed", description: result.error, type: "error" });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New skill</DialogTitle>
            <DialogDescription>
              Author a workspace skill — a reusable, versioned markdown playbook agents load when
              relevant.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="mt-4 gap-4 max-h-[60vh] overflow-y-auto">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="new-skill-name">Name</Label>
              <Input
                id="new-skill-name"
                placeholder="e.g. Incident Response"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                required
                data-testid="new-skill-name-input"
              />
            </div>

            {/* Slug */}
            <div className="space-y-1.5">
              <Label htmlFor="new-skill-slug">Slug</Label>
              <Input
                id="new-skill-slug"
                placeholder="incident-response"
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                required
                className="font-mono text-sm"
                data-testid="new-skill-slug-input"
              />
              <p className="text-xs text-muted-foreground">
                Unique kebab-case identifier within this workspace.
              </p>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="new-skill-description">Description</Label>
              <Textarea
                id="new-skill-description"
                placeholder="What this skill teaches the agent, in one or two sentences."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={500}
                required
                data-testid="new-skill-description-input"
              />
            </div>

            {/* Weight */}
            <div className="space-y-1.5">
              <Label>Weight</Label>
              <RadioGroup
                value={weight}
                onValueChange={(v) => {
                  if (typeof v === "string") setWeight(v as "low" | "high" | "critical");
                }}
                className="gap-2"
              >
                {WEIGHT_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-md border p-2.5 transition-colors",
                      weight === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-border/60 hover:border-border hover:bg-muted/30",
                    )}
                  >
                    <Radio value={opt.value} className="mt-0.5 shrink-0" />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium text-foreground">{opt.label}</span>
                      <span className="text-xs text-muted-foreground">{opt.hint}</span>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <Label htmlFor="new-skill-body">Skill content (Markdown)</Label>
              <Textarea
                id="new-skill-body"
                placeholder="## When to use this skill&#10;&#10;..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                maxLength={MAX_BODY_LENGTH}
                className="font-mono text-sm resize-y"
                required
                data-testid="new-skill-body-textarea"
              />
              <p className="text-xs text-muted-foreground">
                {body.length.toLocaleString()} / {MAX_BODY_LENGTH.toLocaleString()} characters
              </p>
            </div>

            {/* Activate */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="new-skill-activate"
                checked={activate}
                onCheckedChange={(checked) => setActivate(checked === true)}
                data-testid="new-skill-activate-checkbox"
              />
              <Label htmlFor="new-skill-activate" className="cursor-pointer font-normal">
                Activate immediately (make this the active version)
              </Label>
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="new-skill-error">
                {error}
              </p>
            )}
          </DialogPanel>

          <DialogFooter className="mt-6">
            <DialogClose render={<Button type="button" variant="outline" disabled={submitting} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!canSubmit} data-testid="new-skill-submit-btn">
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
              Create skill
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
