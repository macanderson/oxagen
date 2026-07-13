"use client";

/**
 * automation-create-inline — renders a pre-filled, fully editable automation
 * creation form directly inside the chat bubble.
 *
 * Lifecycle:
 *   editing → submitting → created (disabled) → enabled
 *
 * Product invariant: creation ALWAYS lands disabled. The human must explicitly
 * click "Enable automation" to activate the trigger — the enable call is a
 * SEPARATE server action gated by the form's Enable button.
 */

import * as React from "react";
import { Zap, Calendar, GitBranch, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createAutomationInlineAction,
  enableAutomationInlineAction,
} from "@/app/actions/automation-inline.action";
import type { AutomationCreateOutput } from "@oxagen/oxagen/contracts/automation.create";
import {
  resolveConditionTree,
  type ConditionNode,
} from "@oxagen/oxagen/trigger-conditions";
import {
  SchemaConditionSection,
  type EventType,
} from "@/components/automations/condition-builder";
import { cn } from "@/lib/utils";

import {
  TRIGGER_TYPE_OPTIONS,
  emptyStep,
  type AutomationCreateInlineProps,
  type AutomationStep,
  type FormState,
  type PropertyCondition,
} from "./automation-create-inline-types";
import { CreatedState, EnabledState } from "./automation-create-inline-status";
import { ScheduleTriggerConfig } from "./automation-create-inline-schedule-config";
import { StepsEditor } from "./automation-create-inline-steps";

export type { AutomationCreateInlineProps, AutomationStep, PropertyCondition };

// ── Component ──────────────────────────────────────────────────────────────────

export default function AutomationCreateInline({
  suggestedName = "",
  suggestedDescription = "",
  triggerType: initialTriggerType = "event",
  entityType: initialEntityType = "",
  eventType: initialEventType,
  propertyConditions: initialConditions,
  conditionTree: initialConditionTree,
  cronExpression: initialCron = "",
  timezone: initialTimezone = "UTC",
  steps: initialSteps,
  orgSlug = "",
  workspaceSlug = "",
}: AutomationCreateInlineProps): React.ReactElement {
  const [name, setName] = React.useState(suggestedName);
  const [description, setDescription] = React.useState(suggestedDescription);
  const [triggerType, setTriggerType] = React.useState<
    "event" | "schedule" | "api"
  >(initialTriggerType);
  const [entityType, setEntityType] = React.useState(initialEntityType);
  const [eventType, setEventType] = React.useState<EventType | "">(
    initialEventType ?? "",
  );
  // Seed the schema-driven tree from an explicit conditionTree, else lift any
  // legacy flat propertyConditions the agent scaffolded into an AND-group.
  const [conditionTree, setConditionTree] = React.useState<ConditionNode>(() =>
    resolveConditionTree({
      conditionTree: initialConditionTree ?? null,
      propertyConditions: (initialConditions ?? []).map((c) => ({
        property: c.property,
        operator: c.operator,
        toValue: c.toValue,
      })),
    }),
  );
  const [cronExpression, setCronExpression] = React.useState(initialCron);
  const [timezone, setTimezone] = React.useState(initialTimezone);
  const [steps, setSteps] = React.useState<AutomationStep[]>(() =>
    initialSteps && initialSteps.length > 0 ? initialSteps : [],
  );

  const [formState, setFormState] = React.useState<FormState>("editing");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [enableError, setEnableError] = React.useState<string | null>(null);
  const [createdAutomation, setCreatedAutomation] =
    React.useState<AutomationCreateOutput | null>(null);

  const nameId = React.useId();
  const descId = React.useId();
  const triggerTypeId = React.useId();
  const entityTypeId = React.useId();
  const eventTypeId = React.useId();
  const cronId = React.useId();
  const timezoneId = React.useId();

  const isSubmitting = formState === "submitting";
  const isEnabling = formState === "enabling";

  // ── Step helpers ─────────────────────────────────────────────────────────────

  function addStep(): void {
    setSteps((prev) => [...prev, emptyStep()]);
  }

  function removeStep(idx: number): void {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateStep(idx: number, patch: Partial<AutomationStep>): void {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  }

  function updateStepConfig(idx: number, raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      updateStep(idx, { config: parsed });
    } catch {
      // Leave config unchanged while user is still typing invalid JSON
    }
  }

  // ── Submit ───────────────────────────────────────────────────────────────────

  async function handleSubmit(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    const result = await createAutomationInlineAction({
      orgSlug,
      workspaceSlug,
      name,
      description: description.trim() !== "" ? description.trim() : undefined,
      triggerType,
      triggerConfig: {
        entityType: entityType.trim() !== "" ? entityType.trim() : undefined,
        eventType: eventType !== "" ? eventType : undefined,
        // Only send the tree when it actually constrains anything — an empty
        // root group matches vacuously, so omit it to keep the config clean.
        conditionTree:
          triggerType === "event" &&
          conditionTree.kind === "group" &&
          conditionTree.children.length > 0
            ? conditionTree
            : undefined,
        cronExpression:
          cronExpression.trim() !== "" ? cronExpression.trim() : undefined,
        timezone: timezone.trim() !== "" ? timezone.trim() : undefined,
      },
      steps: steps.map((s) => ({
        name: s.name,
        stepType: s.stepType,
        config: s.config ?? {},
      })),
    });

    if (result.ok) {
      setCreatedAutomation(result.automation);
      setFormState("created");
    } else {
      setErrorMessage(result.error);
      setFormState("error");
    }
  }

  // ── Enable ───────────────────────────────────────────────────────────────────

  async function handleEnable(): Promise<void> {
    if (!createdAutomation) return;
    setFormState("enabling");
    setEnableError(null);

    const result = await enableAutomationInlineAction({
      orgSlug,
      workspaceSlug,
      automation_id: createdAutomation.automation_id,
    });

    if (result.ok) {
      setFormState("enabled");
    } else {
      setEnableError(result.error);
      setFormState("created");
    }
  }

  // ── Created / enabling state ──────────────────────────────────────────────────

  if (formState === "created" || formState === "enabling") {
    return (
      <CreatedState
        createdAutomation={createdAutomation}
        fallbackName={name}
        enableError={enableError}
        isEnabling={isEnabling}
        onEnable={() => {
          void handleEnable();
        }}
      />
    );
  }

  // ── Enabled state ─────────────────────────────────────────────────────────────

  if (formState === "enabled") {
    return (
      <EnabledState createdAutomation={createdAutomation} fallbackName={name} />
    );
  }

  // ── Form ──────────────────────────────────────────────────────────────────────

  const TriggerIcon =
    triggerType === "schedule"
      ? Calendar
      : triggerType === "api"
        ? Webhook
        : GitBranch;

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      aria-label="Create automation"
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-5 w-full max-w-lg",
      )}
      data-testid="automation-create-form"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <Zap
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Create automation
        </span>
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          name="name"
          required
          maxLength={120}
          placeholder="e.g. Notify on new commit"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isSubmitting}
          autoComplete="off"
          data-testid="automation-name-input"
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label htmlFor={descId}>
          Description{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={descId}
          name="description"
          maxLength={500}
          placeholder="Describe what this automation does…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isSubmitting}
          rows={2}
          className="resize-none"
          data-testid="automation-description-input"
        />
      </div>

      {/* Trigger type */}
      <div className="space-y-1.5">
        <Label htmlFor={triggerTypeId} className="flex items-center gap-1.5">
          <TriggerIcon
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          Trigger type
        </Label>
        <Select
          value={triggerType}
          onValueChange={(v) => {
            if (v !== null) setTriggerType(v as "event" | "schedule" | "api");
          }}
          disabled={isSubmitting}
          name="triggerType"
          items={TRIGGER_TYPE_OPTIONS}
        >
          <SelectTrigger
            id={triggerTypeId}
            aria-label="Trigger type"
            data-testid="trigger-type-select"
          >
            <SelectValue placeholder="Select trigger type" />
          </SelectTrigger>
          <SelectPopup>
            {TRIGGER_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {/* Event trigger config — schema-driven entity/event + condition tree. */}
      {triggerType === "event" && (
        <SchemaConditionSection
          slugs={{ orgSlug, workspaceSlug }}
          entityType={entityType}
          onEntityTypeChange={setEntityType}
          eventType={eventType}
          onEventTypeChange={setEventType}
          conditionTree={conditionTree}
          onConditionTreeChange={setConditionTree}
          entityFieldId={entityTypeId}
          eventFieldId={eventTypeId}
          disabled={isSubmitting}
        />
      )}

      {/* Schedule trigger config */}
      {triggerType === "schedule" && (
        <ScheduleTriggerConfig
          cronExpression={cronExpression}
          onCronExpressionChange={setCronExpression}
          cronId={cronId}
          timezone={timezone}
          onTimezoneChange={setTimezone}
          timezoneId={timezoneId}
          disabled={isSubmitting}
        />
      )}

      {/* Steps */}
      <StepsEditor
        steps={steps}
        onAddStep={addStep}
        onRemoveStep={removeStep}
        onUpdateStep={updateStep}
        onUpdateStepConfig={updateStepConfig}
        disabled={isSubmitting}
      />

      {/* Error */}
      {formState === "error" && errorMessage !== null && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}

      {/* Submit */}
      <Button
        type="submit"
        disabled={isSubmitting || name.trim() === ""}
        className="w-full"
        aria-busy={isSubmitting}
        data-testid="create-automation-submit"
      >
        {isSubmitting ? "Creating…" : "Create automation"}
      </Button>
    </form>
  );
}
