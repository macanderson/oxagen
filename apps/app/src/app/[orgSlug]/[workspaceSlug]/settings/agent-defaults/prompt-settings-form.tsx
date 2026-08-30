"use client";
/**
 * prompt-settings-form.tsx — client component for Workspace → Settings → Prompts.
 *
 * Sections:
 *   1. Auto-improve prompts — toggle (Beta) with help text.
 *   2. Additional instructions — multiline textarea appended to every agent prompt.
 *   3. Per-prompt overrides (Enterprise) — collapsible textareas for the three
 *      curated override keys. Disabled with upsell badge for non-enterprise workspaces
 *      (server enforces the gate regardless of UI state).
 *
 * Save UX mirrors models-form.tsx: optimistic submit → toast success/error.
 */
import * as React from "react";
import { Save, Lock, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { MarkdownCodeEditor } from "@/components/ui/markdown-code-editor";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type {
  PromptSettingsActionResult,
  PromptSettingsInput,
} from "./prompt-settings-action";
import { updatePromptSettingsAction } from "./prompt-settings-action";
import type { PromptSettingsReadOutput } from "./prompt-settings-action";
import { useRegisterFillableForm } from "@/lib/page-context";
import type { FieldDescriptor } from "@/lib/ask/fill-types";

// ── Types ──────────────────────────────────────────────────────────────────────

type OverrideKey = "conversation.title" | "svg.generate" | "image.analyze";

interface OverrideField {
  key: OverrideKey;
  label: string;
  description: string;
  placeholder: string;
}

const OVERRIDE_FIELDS: OverrideField[] = [
  {
    key: "conversation.title",
    label: "Conversation titles",
    description: "Prompt used to generate a short title for each conversation.",
    placeholder: "Enter a custom prompt for generating conversation titles…",
  },
  {
    key: "svg.generate",
    label: "SVG generation",
    description: "Prompt used when the agent generates SVG graphics.",
    placeholder: "Enter a custom prompt for SVG generation…",
  },
  {
    key: "image.analyze",
    label: "Image analysis",
    description: "Prompt used when the agent analyzes uploaded images.",
    placeholder: "Enter a custom prompt for image analysis…",
  },
];

// ── Props ──────────────────────────────────────────────────────────────────────

export interface PromptSettingsFormProps {
  /** Current workspace prompt settings (from prompt.settings.read). */
  initial: PromptSettingsReadOutput;
  /** Whether the viewing user may save changes (workspace owner or admin). */
  canEdit: boolean;
  /**
   * Whether the org is on the Enterprise plan. Controls whether per-prompt
   * override fields are unlocked (editable). False → fields are disabled with
   * an upsell overlay. True → fields are fully editable (subject to canEdit).
   * Server enforces the tier gate regardless of UI state.
   */
  isEnterprise: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
      {children}
    </p>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PromptSettingsForm({
  initial,
  canEdit,
  isEnterprise,
  orgSlug,
  workspaceSlug,
}: PromptSettingsFormProps) {
  const { add: addToast } = useToast();

  // ── Local state ─────────────────────────────────────────────────────────────
  const [autoImprove, setAutoImprove] = React.useState(
    initial.autoImprovePrompts,
  );
  const [additionalInstructions, setAdditionalInstructions] = React.useState(
    initial.additionalInstructions ?? "",
  );
  const [overrides, setOverrides] = React.useState<
    Partial<Record<OverrideKey, string>>
  >(() => {
    const o = initial.overrides ?? {};
    const out: Partial<Record<OverrideKey, string>> = {};
    for (const { key } of OVERRIDE_FIELDS) {
      if (typeof o[key] === "string") out[key] = o[key];
    }
    return out;
  });
  const [overridesOpen, setOverridesOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  // ── Fill registration ─────────────────────────────────────────────────────

  const promptSettingsFields = React.useMemo<FieldDescriptor[]>(
    () => [
      {
        name: "autoImprove",
        label: "Auto-improve prompts",
        type: "boolean",
        current: autoImprove,
        required: false,
      },
      {
        name: "additionalInstructions",
        label: "Workspace instructions",
        type: "textarea",
        current: additionalInstructions,
        required: false,
      },
    ],
    [autoImprove, additionalInstructions],
  );

  const applyPromptSettings = React.useCallback(
    (proposed: Record<string, unknown>) => {
      if (typeof proposed.autoImprove === "boolean")
        setAutoImprove(proposed.autoImprove);
      if (typeof proposed.additionalInstructions === "string")
        setAdditionalInstructions(proposed.additionalInstructions);
    },
    [],
  );

  useRegisterFillableForm({
    formId: `workspace-prompts-${workspaceSlug}`,
    title: "Workspace prompt settings",
    fields: promptSettingsFields,
    apply: applyPromptSettings,
  });

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);

    // Build overrides payload: only include keys with non-empty values.
    const overridesPayload: PromptSettingsInput["overrides"] = {};
    let hasAnyOverride = false;
    for (const { key } of OVERRIDE_FIELDS) {
      const val = overrides[key];
      if (val !== undefined && val.trim().length > 0) {
        overridesPayload[key] = val.trim();
        hasAnyOverride = true;
      }
    }

    const input: PromptSettingsInput = {
      orgSlug,
      workspaceSlug,
      additionalInstructions: additionalInstructions.trim() || null,
      overrides: hasAnyOverride ? overridesPayload : null,
      autoImprovePrompts: autoImprove,
    };

    try {
      const result: PromptSettingsActionResult =
        await updatePromptSettingsAction(input);
      if (result.ok) {
        addToast({
          title: "Prompt settings saved",
          description: "Your workspace prompt configuration has been updated.",
          type: "background",
        });
      } else {
        addToast({
          title: result.tierDenied ? "Enterprise feature" : "Failed to save",
          description: result.tierDenied
            ? "Prompt overrides require an Enterprise plan."
            : result.error,
          type: "background",
        });
      }
    } catch {
      addToast({
        title: "Failed to save",
        description: "An unexpected error occurred. Please try again.",
        type: "background",
      });
    } finally {
      setIsSaving(false);
    }
  }

  const disabled = !canEdit || isSaving;

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Workspace prompt settings"
      className="flex flex-col gap-8"
      noValidate
    >
      {/* ── Auto-improve prompts ─────────────────────────────────────────────── */}
      <section aria-labelledby="auto-improve-heading">
        <SectionLabel>Prompt enhancement</SectionLabel>
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-card px-4 py-4">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2">
                <Label
                  id="auto-improve-heading"
                  htmlFor="auto-improve-switch"
                  className="text-sm font-semibold text-foreground cursor-pointer"
                >
                  Auto-improve prompts
                </Label>
                <Badge variant="secondary" size="sm">
                  Beta
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                A model judges whether your prompt is sufficient as-is; if not,
                an attempt will be made to enhance context, which may yield
                unintended results.
              </p>
            </div>
            <Switch
              id="auto-improve-switch"
              checked={autoImprove}
              onCheckedChange={setAutoImprove}
              disabled={disabled}
              aria-labelledby="auto-improve-heading"
            />
          </div>
        </div>
      </section>

      {/* ── Additional instructions ──────────────────────────────────────────── */}
      <section aria-labelledby="additional-instructions-heading">
        <SectionLabel>Additional instructions</SectionLabel>
        <div className="flex flex-col gap-2">
          <Label
            id="additional-instructions-heading"
            htmlFor="additional-instructions"
            className="text-sm font-medium text-foreground"
          >
            Workspace instructions
          </Label>
          <p className="text-xs text-muted-foreground">
            These instructions are appended to every agent prompt in this
            workspace. Use this to set workspace-wide context, tone, or
            constraints.
          </p>
          <MarkdownCodeEditor
            id="additional-instructions"
            value={additionalInstructions}
            onChange={setAdditionalInstructions}
            disabled={disabled}
            placeholder="e.g. Always respond in British English. Cite sources when making factual claims."
            maxLength={8000}
            minHeight="10rem"
            ariaLabel="Workspace instructions"
          />
          <p
            id="additional-instructions-count"
            className="text-right text-xs text-muted-foreground"
          >
            {additionalInstructions.length} / 8,000
          </p>
        </div>
      </section>

      {/* ── Per-prompt overrides (Enterprise) ───────────────────────────────── */}
      <section aria-labelledby="overrides-heading">
        <button
          type="button"
          onClick={() => setOverridesOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left"
          aria-expanded={overridesOpen}
          aria-controls="overrides-panel"
        >
          <SectionLabel>Per-prompt overrides</SectionLabel>
          <span className="flex items-center gap-2 text-xs text-muted-foreground mb-4">
            {!isEnterprise && (
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {!isEnterprise && (
              <Badge variant="outline" size="sm">
                Enterprise
              </Badge>
            )}
            {overridesOpen ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
        </button>

        {overridesOpen && (
          <div id="overrides-panel" className="flex flex-col gap-4 mt-2">
            <p className="text-xs text-muted-foreground">
              Replace the built-in system prompt for specific agent
              capabilities. These overrides apply workspace-wide and are only
              available on the Enterprise plan. The core orchestration prompt is
              never replaceable — use{" "}
              <span className="font-medium text-foreground">
                Workspace instructions
              </span>{" "}
              above for append-only additions.
            </p>

            {OVERRIDE_FIELDS.map(({ key, label, description, placeholder }) => (
              <div key={key} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor={`override-${key}`}
                    className="text-sm font-medium text-foreground"
                  >
                    {label}
                  </Label>
                  {!isEnterprise && (
                    <Badge variant="outline" size="sm">
                      <Lock className="h-2.5 w-2.5 mr-1" aria-hidden="true" />
                      Enterprise
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{description}</p>
                <div className="relative">
                  <MarkdownCodeEditor
                    id={`override-${key}`}
                    value={overrides[key] ?? ""}
                    onChange={(value) =>
                      setOverrides((prev) => ({ ...prev, [key]: value }))
                    }
                    disabled={!isEnterprise || disabled}
                    placeholder={placeholder}
                    maxLength={4000}
                    minHeight="7rem"
                    ariaLabel={label}
                    className={!isEnterprise ? "cursor-not-allowed" : undefined}
                  />
                  {!isEnterprise && (
                    <div
                      id={`override-${key}-help`}
                      className="absolute inset-0 flex items-center justify-center rounded-md bg-muted/40 pointer-events-none"
                    >
                      <span className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        Requires Enterprise plan
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-t border-border/40 pt-4">
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

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Only workspace owners and admins can edit prompt settings.
          </p>
        )}
      </div>
    </form>
  );
}
