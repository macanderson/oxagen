"use client";
import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListChecks,
  MoveRight,
  Plus,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
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
  Menu,
  MenuPopup,
  MenuGroupLabel,
  MenuTrigger,
} from "@/components/ui/menu";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { PlanDecision, PlanStep, RiskLevel } from "./stream-event-types";

export interface AgentCapability {
  name: string;
  description: string;
  riskLevel: RiskLevel;
}

export interface PlanCardProps {
  planId: string;
  title: string;
  steps: readonly PlanStep[];
  rationale?: string;
  status: "pending" | PlanDecision;
  agentCapabilities?: readonly AgentCapability[];
  onResolve?: (
    planId: string,
    decision: PlanDecision,
    amendedSteps?: PlanStep[],
  ) => Promise<{ ok: boolean; error?: string }>;
}

const RISK_TEXT: Record<RiskLevel, string> = {
  low: "text-muted-foreground",
  medium: "text-warning",
  high: "text-destructive",
};

export function PlanCard({
  planId,
  title,
  steps,
  rationale,
  status,
  agentCapabilities,
  onResolve,
}: PlanCardProps) {
  const [rationaleOpen, setRationaleOpen] = React.useState(false);
  const [amending, setAmending] = React.useState(false);
  const [draft, setDraft] = React.useState<PlanStep[]>(() =>
    steps.map(cloneStep),
  );
  const [pending, setPending] = React.useState<PlanDecision | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [optimistic, setOptimistic] = React.useState<PlanDecision | "pending">(
    status,
  );

  const capabilities = React.useMemo<readonly AgentCapability[]>(
    () => agentCapabilities ?? [],
    [agentCapabilities],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const enterAmend = () => {
    setDraft(steps.map(cloneStep));
    setAmending(true);
    setError(null);
  };

  const cancelAmend = () => {
    setDraft(steps.map(cloneStep));
    setAmending(false);
    setError(null);
  };

  const updateStep = React.useCallback(
    (id: string, patch: Partial<PlanStep>) => {
      setDraft((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  const deleteStep = React.useCallback((id: string) => {
    // Cascade-clean: removing a step also drops it from any sibling's
    // dependsOn so the resulting DAG stays internally consistent.
    setDraft((prev) =>
      prev
        .filter((s) => s.id !== id)
        .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) })),
    );
  }, []);

  const addStep = React.useCallback(() => {
    setDraft((prev) => {
      const nextId = nextStepId(prev);
      return [
        ...prev,
        {
          id: nextId,
          summary: "New step",
          intent: "",
          capability: null,
          dependsOn: [],
        },
      ];
    });
  }, []);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraft((prev) => {
      const oldIndex = prev.findIndex((s) => s.id === active.id);
      const newIndex = prev.findIndex((s) => s.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  const handle = async (decision: PlanDecision) => {
    if (!onResolve) return;
    setError(null);
    setPending(decision);
    let amended: PlanStep[] | undefined;
    if (decision === "amended") {
      amended = draft.map(cloneStep);
    }
    setOptimistic(decision);
    const res = await onResolve(planId, decision, amended);
    setPending(null);
    if (!res.ok) {
      setOptimistic(status);
      setError(res.error ?? "Failed to resolve plan");
    } else if (decision === "amended") {
      setAmending(false);
    }
  };

  const settled = optimistic !== "pending";

  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 space-y-3 p-4 animate-in"
      data-component="plan-card"
      data-plan-status={
        settled ? optimistic : amending ? "amending" : "pending"
      }
    >
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold">{title}</h4>
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
          {settled ? optimistic : amending ? "amending" : "awaiting approval"}
        </span>
      </div>

      {amending && !settled ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={draft.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-2">
              {draft.map((step) => (
                <SortableStepRow
                  key={step.id}
                  step={step}
                  allSteps={draft}
                  capabilities={capabilities}
                  onChange={updateStep}
                  onDelete={deleteStep}
                />
              ))}
            </ul>
          </SortableContext>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addStep}
            className="mt-2 w-full justify-center"
          >
            <Plus className="mr-1 h-3 w-3" /> Add step
          </Button>
        </DndContext>
      ) : (
        <ol className="space-y-2">
          {steps.map((step, idx) => (
            <li key={step.id} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground tabular-nums">
                {idx + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{step.summary}</span>
                  {step.capability ? (
                    <span className="text-xs text-muted-foreground">
                      {step.capability}
                    </span>
                  ) : null}
                  {step.dependsOn.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <MoveRight className="h-3 w-3" />
                      {step.dependsOn.join(", ")}
                    </span>
                  ) : null}
                </div>
                {step.intent ? (
                  <p className="text-xs text-muted-foreground">{step.intent}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {rationale ? (
        <div>
          <button
            type="button"
            onClick={() => setRationaleOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {rationaleOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Rationale
          </button>
          {rationaleOpen ? (
            <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs">
              {rationale}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {!settled ? (
        <div className="flex items-center justify-end gap-2">
          {amending ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelAmend}
                disabled={pending !== null}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => handle("amended")}
                disabled={pending !== null}
              >
                {pending === "amended" ? "Saving…" : "Save amendments"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={enterAmend}
                disabled={pending !== null}
              >
                Amend
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handle("denied")}
                disabled={pending !== null}
              >
                Deny
              </Button>
              <Button
                size="sm"
                onClick={() => handle("approved")}
                disabled={pending !== null}
              >
                {pending === "approved" ? "Approving…" : "Approve"}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface SortableStepRowProps {
  step: PlanStep;
  allSteps: readonly PlanStep[];
  capabilities: readonly AgentCapability[];
  onChange: (id: string, patch: Partial<PlanStep>) => void;
  onDelete: (id: string) => void;
}

function SortableStepRow({
  step,
  allSteps,
  capabilities,
  onChange,
  onDelete,
}: SortableStepRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: step.id,
  });
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [cycleWarning, setCycleWarning] = React.useState<string | null>(null);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const dependents = React.useMemo(
    () =>
      allSteps.filter((s) => s.dependsOn.includes(step.id)).map((s) => s.id),
    [allSteps, step.id],
  );

  const requestDelete = () => {
    if (dependents.length > 0 && !confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    onDelete(step.id);
  };

  const toggleDependsOn = (otherId: string) => {
    setCycleWarning(null);
    const already = step.dependsOn.includes(otherId);
    if (already) {
      onChange(step.id, {
        dependsOn: step.dependsOn.filter((d) => d !== otherId),
      });
      return;
    }
    // Cycle prevention: walk the existing dependsOn edges out from `otherId`;
    // if we can reach `step.id`, adding step.id -> otherId would close a cycle.
    if (wouldIntroduceCycle(allSteps, step.id, otherId)) {
      setCycleWarning(`Adding ${otherId} would create a cycle.`);
      return;
    }
    onChange(step.id, { dependsOn: [...step.dependsOn, otherId] });
  };

  const siblings = allSteps.filter((s) => s.id !== step.id);
  const selectedCapability = step.capability ?? "__none__";

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-xl border bg-card p-3 text-sm",
        isDragging && "ring-2 ring-ring",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label="Drag to reorder"
          className="mt-1 cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">
              {step.id}
            </span>
            <Input
              value={step.summary}
              onChange={(e) => onChange(step.id, { summary: e.target.value })}
              placeholder="Step summary"
              className="h-8 text-sm"
            />
          </div>
          <Textarea
            value={step.intent}
            onChange={(e) => onChange(step.id, { intent: e.target.value })}
            placeholder="Intent — what this step accomplishes"
            rows={2}
            className="text-xs"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor={`${step.id}-capability`}
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Capability
              </label>
              <Select
                value={selectedCapability}
                onValueChange={(v: string | null) =>
                  onChange(step.id, {
                    capability: v === "__none__" || v === null ? null : v,
                  })
                }
              >
                <SelectTrigger
                  id={`${step.id}-capability`}
                  className="h-9 text-xs"
                >
                  <SelectValue placeholder="Choose capability" />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="__none__">
                    <span className="text-muted-foreground">No capability</span>
                  </SelectItem>
                  {capabilities.map((cap) => (
                    <SelectItem key={cap.name} value={cap.name}>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[11px]">
                          {cap.name}
                        </span>
                        <span
                          className={cn(
                            "text-[9px] font-medium",
                            RISK_TEXT[cap.riskLevel],
                          )}
                        >
                          {cap.riskLevel}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1">
              <label
                htmlFor={`${step.id}-depends-on`}
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Depends on
              </label>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      id={`${step.id}-depends-on`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 w-full justify-between text-xs"
                    />
                  }
                >
                  <span className="truncate">
                    {step.dependsOn.length > 0
                      ? step.dependsOn.join(", ")
                      : "None"}
                  </span>
                  <ChevronDown className="ml-2 h-3 w-3 opacity-60" />
                </MenuTrigger>
                <MenuPopup className="w-56">
                  <MenuGroupLabel>Sibling steps</MenuGroupLabel>
                  {siblings.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No other steps yet.
                    </div>
                  ) : (
                    siblings.map((sib) => {
                      const checked = step.dependsOn.includes(sib.id);
                      return (
                        <button
                          type="button"
                          key={sib.id}
                          onClick={() => toggleDependsOn(sib.id)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs outline-none hover:bg-muted"
                        >
                          {/* Display-only: the wrapping button owns the toggle.
                              pointer-events-none lets the click fall through to
                              it (no onCheckedChange, so it can't double-fire). */}
                          <Checkbox
                            checked={checked}
                            tabIndex={-1}
                            aria-hidden="true"
                            className="pointer-events-none"
                          />
                          <span className="font-mono">{sib.id}</span>
                          <span className="truncate text-muted-foreground">
                            {sib.summary}
                          </span>
                        </button>
                      );
                    })
                  )}
                </MenuPopup>
              </Menu>
              {cycleWarning ? (
                <p className="flex items-center gap-1 text-[10px] text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  {cycleWarning}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={requestDelete}
            className="h-8 px-2 text-destructive hover:text-destructive"
            aria-label={confirmingDelete ? "Confirm delete" : "Delete step"}
          >
            <Trash2 className="h-3 w-3" />
            {confirmingDelete ? (
              <span className="ml-1 text-[10px]">Confirm</span>
            ) : null}
          </Button>
          {confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          ) : null}
          {dependents.length > 0 ? (
            <span className="text-[10px] text-muted-foreground">
              {dependents.length} dependent{dependents.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function cloneStep(s: PlanStep): PlanStep {
  return {
    id: s.id,
    summary: s.summary,
    intent: s.intent,
    capability: s.capability,
    dependsOn: [...s.dependsOn],
    inputPreview: s.inputPreview,
  };
}

function nextStepId(steps: readonly PlanStep[]): string {
  const used = new Set(steps.map((s) => s.id));
  let i = steps.length + 1;
  while (used.has(`s${i}`)) i += 1;
  return `s${i}`;
}

// Returns true if adding edge `source -> candidate` (source.dependsOn gains
// candidate) would create a cycle. A cycle exists iff candidate already
// transitively depends on source.
function wouldIntroduceCycle(
  steps: readonly PlanStep[],
  source: string,
  candidate: string,
): boolean {
  if (source === candidate) return true;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const stack = [candidate];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (cur === source) return true;
    const node = byId.get(cur);
    if (!node) continue;
    for (const d of node.dependsOn) stack.push(d);
  }
  return false;
}
