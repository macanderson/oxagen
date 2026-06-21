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
import {
  Zap,
  CheckCircle2,
  Plus,
  Trash2,
  Calendar,
  GitBranch,
  Webhook,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PropertyCondition {
  property: string;
  operator: "eq" | "gt" | "lt" | "changed";
  toValue?: string;
}

export interface AutomationStep {
  name: string;
  stepType: "agent" | "tool" | "condition" | "webhook" | "prompt" | "human_input";
  config?: Record<string, unknown>;
}

// Editable rows carry a stable `rowId` so React keys survive reordering/removal.
// Keying these controlled-input lists by array index binds each row's input
// state to a position, not to the row, so removing a middle row leaks the
// removed row's values into its neighbour. `rowId` is UI-only — the submit
// mapping projects the external shape and never sends it.
type ConditionRow = PropertyCondition & { rowId: string };
type StepRow = AutomationStep & { rowId: string };

export interface AutomationCreateInlineProps {
  /** Pre-suggested automation name from the agent */
  suggestedName?: string;
  /** Pre-suggested description from the agent */
  suggestedDescription?: string;
  /** Trigger type pre-inferred by agent */
  triggerType?: "event" | "schedule" | "api";
  /** Graph entity type to watch (for 'event' triggers) */
  entityType?: string;
  /** Graph event type (for 'event' triggers) */
  eventType?: "node.created" | "node.updated" | "node.deleted";
  /** Property conditions (for 'event' triggers) */
  propertyConditions?: PropertyCondition[];
  /** POSIX cron expression (for 'schedule' triggers) */
  cronExpression?: string;
  /** IANA timezone (for 'schedule' triggers) */
  timezone?: string;
  /** Initial steps scaffolded by the agent */
  steps?: AutomationStep[];
  /** Injected by the stream route — needed for server action context. */
  orgSlug?: string;
  workspaceSlug?: string;
}

type FormState = "editing" | "submitting" | "created" | "enabling" | "enabled" | "error";

const TRIGGER_TYPE_OPTIONS = [
  { value: "event", label: "Graph event" },
  { value: "schedule", label: "Schedule (cron)" },
  { value: "api", label: "API / manual" },
] as const;

const EVENT_TYPE_OPTIONS = [
  { value: "node.created", label: "Node created" },
  { value: "node.updated", label: "Node updated" },
  { value: "node.deleted", label: "Node deleted" },
] as const;

const OPERATOR_OPTIONS = [
  { value: "eq", label: "equals" },
  { value: "changed", label: "changed" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
] as const;

const STEP_TYPE_OPTIONS = [
  { value: "agent", label: "Run agent" },
  { value: "tool", label: "Call tool" },
  { value: "condition", label: "Condition" },
  { value: "webhook", label: "Webhook" },
  { value: "prompt", label: "Prompt" },
  { value: "human_input", label: "Human input" },
] as const;

function emptyCondition(): ConditionRow {
  return { rowId: crypto.randomUUID(), property: "", operator: "eq", toValue: "" };
}

function emptyStep(): StepRow {
  return { rowId: crypto.randomUUID(), name: "", stepType: "agent", config: {} };
}

function toConditionRow(c: PropertyCondition): ConditionRow {
  return { rowId: crypto.randomUUID(), ...c };
}

function toStepRow(s: AutomationStep): StepRow {
  return { rowId: crypto.randomUUID(), ...s };
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AutomationCreateInline({
  suggestedName = "",
  suggestedDescription = "",
  triggerType: initialTriggerType = "event",
  entityType: initialEntityType = "",
  eventType: initialEventType,
  propertyConditions: initialConditions,
  cronExpression: initialCron = "",
  timezone: initialTimezone = "UTC",
  steps: initialSteps,
  orgSlug = "",
  workspaceSlug = "",
}: AutomationCreateInlineProps): React.ReactElement {
  const [name, setName] = React.useState(suggestedName);
  const [description, setDescription] = React.useState(suggestedDescription);
  const [triggerType, setTriggerType] = React.useState<"event" | "schedule" | "api">(
    initialTriggerType,
  );
  const [entityType, setEntityType] = React.useState(initialEntityType);
  const [eventType, setEventType] = React.useState<"node.created" | "node.updated" | "node.deleted" | "">(
    initialEventType ?? "",
  );
  const [conditions, setConditions] = React.useState<ConditionRow[]>(() =>
    initialConditions && initialConditions.length > 0
      ? initialConditions.map(toConditionRow)
      : [],
  );
  const [cronExpression, setCronExpression] = React.useState(initialCron);
  const [timezone, setTimezone] = React.useState(initialTimezone);
  const [steps, setSteps] = React.useState<StepRow[]>(() =>
    initialSteps && initialSteps.length > 0 ? initialSteps.map(toStepRow) : [],
  );

  const [formState, setFormState] = React.useState<FormState>("editing");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [enableError, setEnableError] = React.useState<string | null>(null);
  const [createdAutomation, setCreatedAutomation] = React.useState<AutomationCreateOutput | null>(
    null,
  );

  const nameId = React.useId();
  const descId = React.useId();
  const triggerTypeId = React.useId();
  const entityTypeId = React.useId();
  const eventTypeId = React.useId();
  const cronId = React.useId();
  const timezoneId = React.useId();

  const isSubmitting = formState === "submitting";
  const isEnabling = formState === "enabling";

  // ── Condition helpers ────────────────────────────────────────────────────────

  function addCondition(): void {
    setConditions((prev) => [...prev, emptyCondition()]);
  }

  function removeCondition(idx: number): void {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateCondition(idx: number, patch: Partial<PropertyCondition>): void {
    setConditions((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );
  }

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
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
        propertyConditions:
          conditions.length > 0
            ? conditions.map((c) => ({
                property: c.property,
                operator: c.operator,
                toValue: c.toValue !== "" ? c.toValue : undefined,
              }))
            : undefined,
        cronExpression: cronExpression.trim() !== "" ? cronExpression.trim() : undefined,
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

  // ── Created state ─────────────────────────────────────────────────────────────

  if (formState === "created" || formState === "enabling") {
    return (
      <div
        className={cn("rounded-2xl border border-border bg-card p-5 space-y-4")}
        role="status"
        aria-live="polite"
        data-testid="automation-created-state"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success mt-0.5" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              Created — disabled
            </p>
            <p className="truncate text-xs text-muted-foreground mt-0.5">
              {createdAutomation?.name ?? name}
              {createdAutomation?.automation_id
                ? ` · ${createdAutomation.automation_id}`
                : ""}
            </p>
          </div>
          <Badge variant="muted" className="shrink-0 text-xs">
            Disabled
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">
          The automation was created but is not live yet. Enable it when you are ready.
        </p>

        {enableError !== null && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {enableError}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={() => { void handleEnable(); }}
            disabled={isEnabling}
            aria-busy={isEnabling}
            data-testid="enable-automation-btn"
          >
            {isEnabling ? "Enabling…" : "Enable automation"}
          </Button>
          <button
            type="button"
            onClick={() => {
              /* The user explicitly leaves it disabled — no action needed */
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Leave automation disabled"
            data-testid="leave-disabled-btn"
          >
            Leave disabled
          </button>
        </div>
      </div>
    );
  }

  // ── Enabled state ─────────────────────────────────────────────────────────────

  if (formState === "enabled") {
    return (
      <div
        className={cn("rounded-2xl border border-border bg-card p-5 space-y-3")}
        role="status"
        aria-live="polite"
        data-testid="automation-enabled-state"
      >
        <div className="flex items-center gap-3">
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Automation enabled</p>
            <p className="truncate text-xs text-muted-foreground">
              {createdAutomation?.name ?? name} is now live
            </p>
          </div>
          <Badge variant="success" className="ml-auto shrink-0 text-xs">
            Active
          </Badge>
        </div>
      </div>
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
      onSubmit={(e) => { void handleSubmit(e); }}
      aria-label="Create automation"
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-5 w-full max-w-lg",
      )}
      data-testid="automation-create-form"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <Zap className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-semibold text-foreground">Create automation</span>
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
          <TriggerIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
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
          <SelectTrigger id={triggerTypeId} aria-label="Trigger type" data-testid="trigger-type-select">
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

      {/* Event trigger config */}
      {triggerType === "event" && (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/30 p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Event configuration
          </p>

          <div className="grid grid-cols-2 gap-3">
            {/* Entity type */}
            <div className="space-y-1.5">
              <Label htmlFor={entityTypeId}>Entity type</Label>
              <Input
                id={entityTypeId}
                name="entityType"
                placeholder="e.g. Commit"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                disabled={isSubmitting}
                autoComplete="off"
                data-testid="entity-type-input"
              />
            </div>

            {/* Event type */}
            <div className="space-y-1.5">
              <Label htmlFor={eventTypeId}>Event type</Label>
              <Select
                value={eventType !== "" ? eventType : undefined}
                onValueChange={(v) => {
                  if (v !== null)
                    setEventType(v as "node.created" | "node.updated" | "node.deleted");
                }}
                disabled={isSubmitting}
                name="eventType"
                items={EVENT_TYPE_OPTIONS}
              >
                <SelectTrigger id={eventTypeId} aria-label="Event type" data-testid="event-type-select">
                  <SelectValue placeholder="Select event" />
                </SelectTrigger>
                <SelectPopup>
                  {EVENT_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>

          {/* Property conditions */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Property conditions</p>
            {conditions.map((cond, idx) => (
              <div
                key={cond.rowId}
                className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end"
                data-testid={`condition-row-${idx}`}
              >
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Property</Label>
                  <Input
                    name={`condition.${idx}.property`}
                    placeholder="e.g. status"
                    value={cond.property}
                    onChange={(e) => updateCondition(idx, { property: e.target.value })}
                    disabled={isSubmitting}
                    autoComplete="off"
                    data-testid={`condition-property-${idx}`}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Operator</Label>
                  <Select
                    value={cond.operator}
                    onValueChange={(v) => {
                      if (v !== null)
                        updateCondition(idx, {
                          operator: v as PropertyCondition["operator"],
                        });
                    }}
                    disabled={isSubmitting}
                    items={OPERATOR_OPTIONS}
                  >
                    <SelectTrigger
                      aria-label="Operator"
                      data-testid={`condition-operator-${idx}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {OPERATOR_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Value</Label>
                  <Input
                    name={`condition.${idx}.toValue`}
                    placeholder="e.g. main"
                    value={cond.toValue ?? ""}
                    onChange={(e) => updateCondition(idx, { toValue: e.target.value })}
                    disabled={isSubmitting}
                    autoComplete="off"
                    data-testid={`condition-value-${idx}`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeCondition(idx)}
                  disabled={isSubmitting}
                  className="mb-0.5 rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  aria-label={`Remove condition ${idx + 1}`}
                  data-testid={`condition-remove-${idx}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addCondition}
              disabled={isSubmitting}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              data-testid="add-condition-btn"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add condition
            </button>
          </div>
        </div>
      )}

      {/* Schedule trigger config */}
      {triggerType === "schedule" && (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/30 p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Schedule configuration
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={cronId}>Cron expression</Label>
              <Input
                id={cronId}
                name="cronExpression"
                placeholder="e.g. 0 9 * * 1"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                disabled={isSubmitting}
                autoComplete="off"
                data-testid="cron-expression-input"
              />
              <p className="text-xs text-muted-foreground">
                POSIX cron — min hr dom mon dow
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={timezoneId}>Timezone</Label>
              <Input
                id={timezoneId}
                name="timezone"
                placeholder="e.g. America/New_York"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={isSubmitting}
                autoComplete="off"
                data-testid="timezone-input"
              />
            </div>
          </div>
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">Steps</p>
          <button
            type="button"
            onClick={addStep}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="add-step-btn"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add step
          </button>
        </div>
        {steps.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No steps yet — the automation will run with no actions. Add steps or leave blank for a shell playbook.
          </p>
        )}
        {steps.map((step, idx) => (
          <div
            key={step.rowId}
            className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3"
            data-testid={`step-row-${idx}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Step {idx + 1}
              </span>
              <button
                type="button"
                onClick={() => removeStep(idx)}
                disabled={isSubmitting}
                className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                aria-label={`Remove step ${idx + 1}`}
                data-testid={`step-remove-${idx}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                name={`step.${idx}.name`}
                placeholder="Step name"
                value={step.name}
                onChange={(e) => updateStep(idx, { name: e.target.value })}
                disabled={isSubmitting}
                autoComplete="off"
                data-testid={`step-name-${idx}`}
              />
              <Select
                value={step.stepType}
                onValueChange={(v) => {
                  if (v !== null)
                    updateStep(idx, { stepType: v as AutomationStep["stepType"] });
                }}
                disabled={isSubmitting}
                items={STEP_TYPE_OPTIONS}
              >
                <SelectTrigger
                  aria-label={`Step ${idx + 1} type`}
                  data-testid={`step-type-${idx}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {STEP_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {/* Agent steps: simple agentSlug input */}
            {step.stepType === "agent" && (
              <Input
                name={`step.${idx}.agentSlug`}
                placeholder="Agent slug, e.g. qa-chat"
                value={
                  typeof step.config?.agentSlug === "string"
                    ? step.config.agentSlug
                    : ""
                }
                onChange={(e) =>
                  updateStep(idx, {
                    config: { ...step.config, agentSlug: e.target.value },
                  })
                }
                disabled={isSubmitting}
                autoComplete="off"
                data-testid={`step-agent-slug-${idx}`}
              />
            )}
            {/* Non-agent steps: JSON config textarea */}
            {step.stepType !== "agent" && (
              <Textarea
                name={`step.${idx}.config`}
                placeholder='{"key": "value"}'
                defaultValue={
                  step.config && Object.keys(step.config).length > 0
                    ? JSON.stringify(step.config, null, 2)
                    : ""
                }
                onChange={(e) => updateStepConfig(idx, e.target.value)}
                disabled={isSubmitting}
                rows={2}
                className="resize-none font-mono text-xs"
                data-testid={`step-config-${idx}`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Error */}
      {(formState === "error") && errorMessage !== null && (
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
