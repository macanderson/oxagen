"use client";

/**
 * automation-create-inline-steps.tsx — Steps editor section for the
 * automation-create-inline chat component.
 *
 * Owns: steps list, add/remove/update handlers, per-step type selector,
 * agent-slug input (agent steps), and JSON config textarea (non-agent steps).
 */

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  STEP_TYPE_OPTIONS,
  type AutomationStep,
} from "./automation-create-inline-types";

// ── Props ──────────────────────────────────────────────────────────────────────

interface StepsEditorProps {
  steps: AutomationStep[];
  onAddStep: () => void;
  onRemoveStep: (idx: number) => void;
  onUpdateStep: (idx: number, patch: Partial<AutomationStep>) => void;
  onUpdateStepConfig: (idx: number, raw: string) => void;
  disabled: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function StepsEditor({
  steps,
  onAddStep,
  onRemoveStep,
  onUpdateStep,
  onUpdateStepConfig,
  disabled,
}: StepsEditorProps): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Steps</p>
        <button
          type="button"
          onClick={onAddStep}
          disabled={disabled}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="add-step-btn"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add step
        </button>
      </div>
      {steps.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          No steps yet — the automation will run with no actions. Add steps or
          leave blank for a shell playbook.
        </p>
      )}
      {steps.map((step, idx) => (
        <div
          key={idx}
          className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3"
          data-testid={`step-row-${idx}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Step {idx + 1}
            </span>
            <button
              type="button"
              onClick={() => onRemoveStep(idx)}
              disabled={disabled}
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
              onChange={(e) => onUpdateStep(idx, { name: e.target.value })}
              disabled={disabled}
              autoComplete="off"
              data-testid={`step-name-${idx}`}
            />
            <Select
              value={step.stepType}
              onValueChange={(v) => {
                if (v !== null)
                  onUpdateStep(idx, {
                    stepType: v as AutomationStep["stepType"],
                  });
              }}
              disabled={disabled}
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
                onUpdateStep(idx, {
                  config: { ...step.config, agentSlug: e.target.value },
                })
              }
              disabled={disabled}
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
              onChange={(e) => onUpdateStepConfig(idx, e.target.value)}
              disabled={disabled}
              rows={2}
              className="resize-none font-mono text-xs"
              data-testid={`step-config-${idx}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
