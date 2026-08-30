"use client";
/**
 * PreferencesForm — client component for the Account Preferences page.
 *
 * Sections:
 *   1. Appearance — font size + density (optimistic dataset write for instant
 *      feedback, then persisted via server action + cookie).
 *   2. Interactive agent — submit behavior + pending prompt behavior + model
 *      defaults (via ModelDefaultsFields).
 *
 * Persist pattern: single Save button, matches profile-form.tsx UX.
 * Toast pattern: useToast().add(...), matches billing components.
 */
import * as React from "react";
import type {
  FontSize,
  Density,
  PendingPromptBehavior,
} from "@oxagen/database";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import {
  ModelDefaultsFields,
  type ModelDefaultsValue,
} from "@/components/settings/model-defaults-fields";
import { updatePreferencesAction } from "./preferences-action";
import type { PreferencesInput } from "./preferences-action";
import {
  useRegisterFillableForm,
  useRegisterPageEntity,
} from "@/lib/page-context";
import type { FieldDescriptor } from "@/lib/ask/fill-types";
import { TIMEZONE_OPTIONS, LANGUAGE_OPTIONS } from "./locale-constants";

// ── Props ────────────────────────────────────────────────────────────────────

export interface PreferencesFormProps {
  initial: {
    fontSize: FontSize;
    density: Density;
    enterToSubmit: boolean;
    pendingPromptBehavior: PendingPromptBehavior;
    defaultTextTier: "fast" | "balanced" | "precise" | null;
    defaultTextModel: string | null;
    defaultImageModel: string | null;
    defaultVideoModel: string | null;
    timezone: string;
    language: string;
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function PreferencesForm({ initial }: PreferencesFormProps) {
  const { add: addToast } = useToast();

  // ── Local state ────────────────────────────────────────────────────────────
  const [fontSize, setFontSize] = React.useState<FontSize>(initial.fontSize);
  const [density, setDensity] = React.useState<Density>(initial.density);
  const [enterToSubmit, setEnterToSubmit] = React.useState(
    initial.enterToSubmit,
  );
  const [pendingPromptBehavior, setPendingPromptBehavior] =
    React.useState<PendingPromptBehavior>(initial.pendingPromptBehavior);

  const [timezone, setTimezone] = React.useState(initial.timezone);
  const [language, setLanguage] = React.useState(initial.language);

  const [modelDefaults, setModelDefaults] = React.useState<ModelDefaultsValue>({
    textTier: initial.defaultTextTier,
    textModel: initial.defaultTextModel,
    imageModel: initial.defaultImageModel,
    videoModel: initial.defaultVideoModel,
  });

  const [status, setStatus] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  // ── Register the account preferences entity + fillable form ──────────────
  useRegisterPageEntity({
    kind: "user",
    id: "account-preferences",
    label: "Account Preferences",
    summary:
      "User preferences for appearance, interactive agent, and model defaults.",
  });

  const preferencesFields = React.useMemo<FieldDescriptor[]>(
    () => [
      {
        name: "fontSize",
        label: "Font size",
        type: "select",
        current: fontSize,
        options: [
          { label: "Small", value: "small" },
          { label: "Medium", value: "medium" },
          { label: "Large", value: "large" },
        ],
        required: false,
      },
      {
        name: "density",
        label: "Interface density",
        type: "select",
        current: density,
        options: [
          { label: "Compact", value: "compact" },
          { label: "Comfortable", value: "comfortable" },
          { label: "Spacious", value: "spacious" },
        ],
        required: false,
      },
      {
        name: "enterToSubmit",
        label: "Enter to submit messages",
        type: "boolean",
        current: enterToSubmit,
        required: false,
      },
      {
        name: "pendingPromptBehavior",
        label: "Pending prompt behavior",
        type: "select",
        current: pendingPromptBehavior,
        options: [
          { label: "Queue it", value: "queue" },
          { label: "Interrupt the response", value: "interrupt" },
        ],
        required: false,
      },
      {
        name: "timezone",
        label: "Timezone",
        type: "select",
        current: timezone,
        options: TIMEZONE_OPTIONS,
        required: false,
      },
      {
        name: "language",
        label: "Language",
        type: "select",
        current: language,
        options: LANGUAGE_OPTIONS,
        required: false,
      },
    ],
    [
      fontSize,
      density,
      enterToSubmit,
      pendingPromptBehavior,
      timezone,
      language,
    ],
  );

  const applyPreferences = React.useCallback(
    (proposed: Record<string, unknown>) => {
      if (
        proposed.fontSize === "small" ||
        proposed.fontSize === "medium" ||
        proposed.fontSize === "large"
      ) {
        setFontSize(proposed.fontSize);
        // Optimistically apply to the document so the change is visible immediately.
        document.documentElement.dataset.fontSize = proposed.fontSize;
      }
      if (
        proposed.density === "compact" ||
        proposed.density === "comfortable" ||
        proposed.density === "spacious"
      ) {
        setDensity(proposed.density);
        document.documentElement.dataset.density = proposed.density;
      }
      if (typeof proposed.enterToSubmit === "boolean") {
        setEnterToSubmit(proposed.enterToSubmit);
      }
      if (
        proposed.pendingPromptBehavior === "queue" ||
        proposed.pendingPromptBehavior === "interrupt"
      ) {
        setPendingPromptBehavior(proposed.pendingPromptBehavior);
      }
      if (
        typeof proposed.timezone === "string" &&
        proposed.timezone.length > 0
      ) {
        setTimezone(proposed.timezone);
      }
      if (
        typeof proposed.language === "string" &&
        proposed.language.length >= 2
      ) {
        setLanguage(proposed.language);
      }
    },
    [],
  );

  useRegisterFillableForm({
    formId: "account-preferences",
    title: "Account Preferences",
    fields: preferencesFields,
    apply: applyPreferences,
  });
  // ─────────────────────────────────────────────────────────────────────────

  // ── Optimistic appearance application ──────────────────────────────────────
  // Write the dataset attributes immediately on change so the UI responds
  // without waiting for the server action. The server action also sets cookies
  // so the next SSR render is flash-free.

  function applyFontSize(next: FontSize) {
    setFontSize(next);
    document.documentElement.dataset.fontSize = next;
  }

  function applyDensity(next: Density) {
    setDensity(next);
    document.documentElement.dataset.density = next;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setStatus("saving");

    const input: PreferencesInput = {
      fontSize,
      density,
      enterToSubmit,
      pendingPromptBehavior,
      defaultTextTier: modelDefaults.textTier,
      defaultTextModel: modelDefaults.textModel,
      defaultImageModel: modelDefaults.imageModel,
      defaultVideoModel: modelDefaults.videoModel,
      timezone,
      language,
    };

    const result = await updatePreferencesAction(input);

    if (result.ok) {
      setStatus("saved");
      addToast({
        title: "Preferences saved",
        description: "Your preferences have been updated.",
        type: "background",
      });
      setTimeout(() => setStatus("idle"), 2000);
    } else {
      setStatus("error");
      addToast({
        title: "Failed to save preferences",
        description: result.error,
        type: "background",
      });
    }
  };

  const isSaving = status === "saving";

  return (
    <form
      onSubmit={handleSubmit}
      className="flex max-w-lg flex-col gap-8"
      aria-label="Preferences settings"
      noValidate
    >
      {/* ── Appearance ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="appearance-heading">
        <h2
          id="appearance-heading"
          className="mb-4 text-sm font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Appearance
        </h2>

        <div className="flex flex-col gap-5">
          {/* Font size */}
          <div className="flex flex-col gap-2">
            <Label id="font-size-label">Font size</Label>
            <SegmentedControl
              value={fontSize}
              onValueChange={(v) => applyFontSize(v as FontSize)}
              aria-labelledby="font-size-label"
              disabled={isSaving}
            >
              <SegmentedControlItem value="small">Small</SegmentedControlItem>
              <SegmentedControlItem value="medium">Medium</SegmentedControlItem>
              <SegmentedControlItem value="large">Large</SegmentedControlItem>
            </SegmentedControl>
            <p className="text-xs text-muted-foreground">
              Scales the base text size across the whole interface.
            </p>
          </div>

          {/* Density */}
          <div className="flex flex-col gap-2">
            <Label id="density-label">Density</Label>
            <SegmentedControl
              value={density}
              onValueChange={(v) => applyDensity(v as Density)}
              aria-labelledby="density-label"
              disabled={isSaving}
            >
              <SegmentedControlItem value="compact">
                Compact
              </SegmentedControlItem>
              <SegmentedControlItem value="comfortable">
                Comfortable
              </SegmentedControlItem>
              <SegmentedControlItem value="spacious">
                Spacious
              </SegmentedControlItem>
            </SegmentedControl>
            <p className="text-xs text-muted-foreground">
              Controls spacing and padding in dense lists and the chat
              interface.
            </p>
          </div>
        </div>
      </section>

      <hr className="border-border" />

      {/* ── Interactive agent ───────────────────────────────────────────────── */}
      <section aria-labelledby="agent-heading">
        <h2
          id="agent-heading"
          className="mb-4 text-sm font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Interactive agent
        </h2>

        <div className="flex flex-col gap-5">
          {/* Submit behavior */}
          <div className="flex flex-col gap-2">
            <Label id="submit-behavior-label">Submit behavior</Label>
            <SegmentedControl
              value={enterToSubmit ? "enter" : "cmd-enter"}
              onValueChange={(v) => setEnterToSubmit(v === "enter")}
              aria-labelledby="submit-behavior-label"
              disabled={isSaving}
            >
              <SegmentedControlItem value="enter">
                Enter sends
              </SegmentedControlItem>
              <SegmentedControlItem value="cmd-enter">
                ⌘+Enter sends
              </SegmentedControlItem>
            </SegmentedControl>
            <p className="text-xs text-muted-foreground">
              {enterToSubmit
                ? "Enter sends the message. Shift+Enter adds a new line."
                : "Enter adds a new line. ⌘/Ctrl+Enter sends the message."}
            </p>
          </div>

          {/* Pending prompt behavior */}
          <div className="flex flex-col gap-2">
            <Label id="pending-prompt-label">
              When a new prompt is entered while the agent is responding
            </Label>
            <SegmentedControl
              value={pendingPromptBehavior}
              onValueChange={(v) =>
                setPendingPromptBehavior(v as PendingPromptBehavior)
              }
              aria-labelledby="pending-prompt-label"
              disabled={isSaving}
            >
              <SegmentedControlItem value="queue">
                Queue it
              </SegmentedControlItem>
              <SegmentedControlItem value="interrupt">
                Interrupt the response
              </SegmentedControlItem>
            </SegmentedControl>
            <p className="text-xs text-muted-foreground">
              {pendingPromptBehavior === "queue"
                ? "Your next prompt will run after the current response finishes."
                : "The current response will be stopped and your new prompt will run immediately."}
            </p>
          </div>

          {/* Model defaults */}
          <div className="flex flex-col gap-2">
            <Label>Default models</Label>
            <ModelDefaultsFields
              value={modelDefaults}
              onChange={setModelDefaults}
              scope="user"
              disabled={isSaving}
            />
          </div>
        </div>
      </section>

      <hr className="border-border" />

      {/* ── Regional ────────────────────────────────────────────────────────── */}
      <section aria-labelledby="regional-heading">
        <h2
          id="regional-heading"
          className="mb-4 text-sm font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Regional
        </h2>

        <div className="flex flex-col gap-5">
          {/* Timezone */}
          <div className="flex flex-col gap-2">
            <Label id="timezone-label" htmlFor="timezone-select">
              Timezone
            </Label>
            <Select
              value={timezone}
              onValueChange={(v) => {
                if (v) setTimezone(v);
              }}
              disabled={isSaving}
            >
              <SelectTrigger
                id="timezone-select"
                aria-labelledby="timezone-label"
              >
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectPopup className="max-h-72 overflow-y-auto">
                <SelectGroup>
                  {TIMEZONE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              Used for displaying dates and times across the platform.
            </p>
          </div>

          {/* Language */}
          <div className="flex flex-col gap-2">
            <Label id="language-label" htmlFor="language-select">
              Language
            </Label>
            <Select
              value={language}
              onValueChange={(v) => {
                if (v) setLanguage(v);
              }}
              disabled={isSaving}
            >
              <SelectTrigger
                id="language-select"
                aria-labelledby="language-label"
              >
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              Sets your preferred display language.
            </p>
          </div>
        </div>
      </section>

      <hr className="border-border" />

      {/* ── Save ────────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isSaving}>
          {isSaving ? "Saving…" : "Save preferences"}
        </Button>
        {status === "saved" && (
          <span className="text-xs text-muted-foreground" role="status">
            Saved
          </span>
        )}
      </div>
    </form>
  );
}
