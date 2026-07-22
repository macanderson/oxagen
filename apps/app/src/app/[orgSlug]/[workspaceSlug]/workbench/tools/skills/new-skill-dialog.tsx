"use client";
/**
 * new-skill-dialog.tsx — AI-assisted "New skill" wizard for Workbench → Skills.
 *
 * Three steps:
 *   1. Describe — the user describes the skill in natural language and
 *      `draftSkillAction` (skill.draft) synthesises the full configuration.
 *      A "configure manually" escape hatch skips straight to a blank form.
 *   2. Review — the familiar create form, prefilled from the AI draft and
 *      fully editable. Slug auto-derives from the name (kebab-case) until
 *      edited directly; an AI-drafted slug counts as edited.
 *   3. Save — read-only summary of the final configuration; saving calls
 *      `createSkillAction` (skill.create), which serializes canonical TOML
 *      server-side from these fields.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { slugify } from "@/lib/slug";
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
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@oxagen/ui";
import { Loader2, Sparkles } from "lucide-react";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

// ── Action contracts ──────────────────────────────────────────────────────────

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

export type DraftSkillAction = (input: {
  orgSlug: string;
  workspaceSlug: string;
  prompt: string;
}) => Promise<
  | {
      ok: true;
      draft: {
        displayName: string;
        slug: string;
        description: string;
        weight: "low" | "high" | "critical";
        category?: string;
        body: string;
      };
    }
  | { ok: false; error: string }
>;

export interface NewSkillDialogProps {
  orgSlug: string;
  workspaceSlug: string;
  action: CreateSkillAction;
  draftAction: DraftSkillAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BODY_LENGTH = 32_000;
const MIN_PROMPT_LENGTH = 10;
const MAX_PROMPT_LENGTH = 4000;

const WEIGHT_OPTIONS: Array<{
  value: "low" | "high" | "critical";
  label: string;
  hint: string;
}> = [
  { value: "low", label: "Low", hint: "Rarely needed background context" },
  { value: "high", label: "High", hint: "Load whenever the topic is relevant" },
  { value: "critical", label: "Critical", hint: "Always keep in context" },
];

type WizardStep = "describe" | "review" | "save";

const STEPS: Array<{ key: WizardStep; label: string }> = [
  { key: "describe", label: "Describe" },
  { key: "review", label: "Review" },
  { key: "save", label: "Save" },
];

const STEP_TITLES: Record<WizardStep, string> = {
  describe: "Describe the skill",
  review: "Review configuration",
  save: "Save the skill",
};

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  describe:
    "Tell us what the skill should teach the agent — AI drafts the full configuration for you.",
  review: "Confirm the configuration the AI drafted. Every field is editable.",
  save: "One last look before the skill is created in this workspace.",
};

// ── Step indicator ────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: WizardStep }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2" aria-label="Setup progress">
      {STEPS.map((s, idx) => {
        const state =
          idx < currentIdx ? "done" : idx === currentIdx ? "active" : "todo";
        return (
          <li key={s.key} className="flex items-center gap-2">
            {idx > 0 && (
              <span className="h-px w-6 bg-border" aria-hidden="true" />
            )}
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium",
                state === "active"
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-[11px]",
                  state === "active" &&
                    "border-primary bg-primary text-primary-foreground",
                  state === "done" &&
                    "border-primary/50 bg-primary/10 text-primary",
                  state === "todo" && "border-border",
                )}
              >
                {idx + 1}
              </span>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ── Wizard ────────────────────────────────────────────────────────────────────

export function NewSkillDialog({
  orgSlug,
  workspaceSlug,
  action,
  draftAction,
  open,
  onOpenChange,
}: NewSkillDialogProps) {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = React.useState<WizardStep>("describe");
  const [prompt, setPrompt] = React.useState("");
  const [drafting, setDrafting] = React.useState(false);

  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugEdited, setSlugEdited] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [weight, setWeight] = React.useState<"low" | "high" | "critical">(
    "low",
  );
  const [body, setBody] = React.useState("");
  const [activate, setActivate] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    setStep("describe");
    setPrompt("");
    setDrafting(false);
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
    if (!slugEdited) setSlug(slugify(value, 64));
  };

  const handleSlugChange = (value: string) => {
    setSlugEdited(true);
    setSlug(slugify(value, 64));
  };

  // ── Step 1: describe → draft ────────────────────────────────────────────────

  const canDraft =
    prompt.trim().length >= MIN_PROMPT_LENGTH &&
    prompt.length <= MAX_PROMPT_LENGTH &&
    !drafting;

  async function handleGenerate() {
    if (!canDraft) return;
    setDrafting(true);
    setError(null);
    try {
      const result = await draftAction({
        orgSlug,
        workspaceSlug,
        prompt: prompt.trim(),
      });
      if (result.ok) {
        setName(result.draft.displayName);
        setSlug(result.draft.slug);
        // The AI-derived slug is authoritative until the user touches it —
        // don't let name edits silently regenerate it.
        setSlugEdited(true);
        setDescription(result.draft.description);
        setWeight(result.draft.weight);
        setBody(result.draft.body);
        setStep("review");
      } else {
        setError(result.error);
      }
    } finally {
      setDrafting(false);
    }
  }

  function handleSkipToManual() {
    setError(null);
    setStep("review");
  }

  // ── Step 2 → 3 gating ───────────────────────────────────────────────────────

  const formComplete =
    name.trim().length > 0 &&
    slug.trim().length > 0 &&
    description.trim().length > 0 &&
    body.trim().length > 0 &&
    body.length <= MAX_BODY_LENGTH;

  // ── Step 3: save ────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!formComplete || submitting) return;

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
        toast.add({
          title: "Skill created",
          description: `${name.trim()} (${result.slug})`,
        });
        const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
        onOpenChange(false);
        reset();
        router.push(workspace.workbench.tools.skill(routeCtx, result.slug));
        router.refresh();
      } else {
        setError(result.error);
        toast.add({
          title: "Create failed",
          description: result.error,
          type: "error",
        });
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
        <DialogHeader>
          <div className="mb-2">
            <StepIndicator current={step} />
          </div>
          <DialogTitle>{STEP_TITLES[step]}</DialogTitle>
          <DialogDescription>{STEP_DESCRIPTIONS[step]}</DialogDescription>
        </DialogHeader>

        {/* ── Step 1: Describe ─────────────────────────────────────────────── */}
        {step === "describe" && (
          <>
            <DialogPanel className="mt-4 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="skill-wizard-prompt">
                  What should this skill teach the agent?
                </Label>
                <Textarea
                  id="skill-wizard-prompt"
                  placeholder="e.g. How to triage production incidents: check dashboards first, page the on-call owner, keep a running timeline, and write a blameless postmortem within 48 hours."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={6}
                  maxLength={MAX_PROMPT_LENGTH}
                  disabled={drafting}
                  data-testid="skill-wizard-describe-input"
                />
                <p className="text-xs text-muted-foreground">
                  Plain language is fine — the AI derives the name, slug,
                  weight, and full skill content. You review everything before
                  it&apos;s saved.
                </p>
              </div>

              {error && (
                <p
                  className="text-sm text-destructive"
                  data-testid="new-skill-error"
                >
                  {error}
                </p>
              )}
            </DialogPanel>

            <DialogFooter className="mt-6 flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={drafting}
                onClick={handleSkipToManual}
                data-testid="skill-wizard-skip-btn"
              >
                Configure manually
              </Button>
              <DialogClose
                render={
                  <Button type="button" variant="outline" disabled={drafting} />
                }
              >
                Cancel
              </DialogClose>
              <Button
                type="button"
                disabled={!canDraft}
                onClick={handleGenerate}
                data-testid="skill-wizard-generate-btn"
              >
                {drafting ? (
                  <Loader2
                    className="mr-2 size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Sparkles className="mr-2 size-4" aria-hidden="true" />
                )}
                {drafting ? "Drafting…" : "Generate with AI"}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* ── Step 2: Review ───────────────────────────────────────────────── */}
        {step === "review" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (formComplete) setStep("save");
            }}
          >
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
                    if (typeof v === "string")
                      setWeight(v as "low" | "high" | "critical");
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
                        <span className="text-sm font-medium text-foreground">
                          {opt.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {opt.hint}
                        </span>
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
                  {body.length.toLocaleString()} /{" "}
                  {MAX_BODY_LENGTH.toLocaleString()} characters
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
                <Label
                  htmlFor="new-skill-activate"
                  className="cursor-pointer font-normal"
                >
                  Activate immediately (make this the active version)
                </Label>
              </div>

              {error && (
                <p
                  className="text-sm text-destructive"
                  data-testid="new-skill-error"
                >
                  {error}
                </p>
              )}
            </DialogPanel>

            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setError(null);
                  setStep("describe");
                }}
                data-testid="skill-wizard-back-btn"
              >
                Back
              </Button>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button
                type="submit"
                disabled={!formComplete}
                data-testid="skill-wizard-continue-btn"
              >
                Continue
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* ── Step 3: Save ─────────────────────────────────────────────────── */}
        {step === "save" && (
          <>
            <DialogPanel className="mt-4 gap-4 max-h-[60vh] overflow-y-auto">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Name</dt>
                <dd
                  className="font-medium"
                  data-testid="skill-wizard-summary-name"
                >
                  {name.trim()}
                </dd>
                <dt className="text-muted-foreground">Slug</dt>
                <dd
                  className="font-mono text-xs self-center"
                  data-testid="skill-wizard-summary-slug"
                >
                  {slug}
                </dd>
                <dt className="text-muted-foreground">Weight</dt>
                <dd>
                  <Badge variant="secondary" className="capitalize">
                    {weight}
                  </Badge>
                </dd>
                <dt className="text-muted-foreground">Description</dt>
                <dd>{description.trim()}</dd>
                <dt className="text-muted-foreground">Activation</dt>
                <dd>
                  {activate ? "Active immediately" : "Saved as draft version"}
                </dd>
              </dl>

              <div className="space-y-1.5">
                <Label>Skill content</Label>
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs text-foreground">
                  {body}
                </pre>
                <p className="text-xs text-muted-foreground">
                  {body.length.toLocaleString()} characters
                </p>
              </div>

              {error && (
                <p
                  className="text-sm text-destructive"
                  data-testid="new-skill-error"
                >
                  {error}
                </p>
              )}
            </DialogPanel>

            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => {
                  setError(null);
                  setStep("review");
                }}
                data-testid="skill-wizard-back-btn"
              >
                Back
              </Button>
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button
                type="button"
                disabled={submitting}
                onClick={handleSave}
                data-testid="new-skill-submit-btn"
              >
                {submitting && (
                  <Loader2
                    className="mr-2 size-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                Save skill
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
