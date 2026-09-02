/**
 * playbook-steps.tsx — read-only view of the automation's scaffolded steps.
 *
 * Contract gap: automation.update edits name/description/trigger config only —
 * there is no capability to edit steps after creation (would need e.g.
 * automation.steps.update). Ship read-only first; the panel says so plainly.
 */
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";

const STEP_LABEL: Record<string, string> = {
  agent: "Run agent",
  tool: "Call tool",
  condition: "Condition",
  webhook: "Webhook",
  prompt: "Prompt",
  human_input: "Human input",
  approval: "Approval",
  transform: "Transform",
  loop: "Loop",
  parallel: "Parallel",
  delay: "Delay",
  sub_playbook: "Sub-playbook",
  knowledge_search: "Knowledge search",
  code_execution: "Code execution",
};

export interface PlaybookStepsProps {
  steps: AutomationGetOutput["steps"];
}

export function PlaybookSteps({ steps }: PlaybookStepsProps) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Playbook</h2>
        <Badge variant="muted" size="sm">
          Read-only
        </Badge>
      </div>

      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This automation has no steps configured yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {steps.map((step, i) => (
            <li
              key={step.stepKey || i}
              className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-2.5"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {step.name}
              </span>
              <Badge variant="secondary" size="sm">
                {STEP_LABEL[step.stepType] ?? step.stepType}
              </Badge>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Steps are set when the automation is created. Editing them in-app needs
        a step-editing capability that isn’t built yet — for now, reconfigure
        steps by recreating the automation.
      </p>
    </Card>
  );
}
