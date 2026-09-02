"use client";
/**
 * launch-workflow-dialog.tsx — launch a workflow (workflow.run) or a research
 * swarm (research.swarm.start) without going through chat.
 *
 * Two tabs sharing one dialog shell, each client-validated to the underlying
 * contract's bounds before submit (goal ≤2000, title ≤200, maxParallelism
 * 1-100; topic ≤500, maxParallel 1-20) so an out-of-bounds value never round
 * -trips to the server. A failed launch renders the capability's own
 * validation error inline (data-testid="launch-error") rather than a toast.
 *
 * Workflow launches revalidate the server list (the row appears in
 * workflow.run.txt agent_executions synchronously — see lib/automations/
 * workflows.ts). Swarm launches have no server list to revalidate (contract
 * gap — research.swarm.start never inserts an agent_executions row); the
 * caller hands the swarm off to swarm-session-store via onSwarmLaunched.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { runWorkflowAction, startResearchSwarmAction } from "../actions";
import type { SwarmSessionRecord } from "./swarm-session-store";

const GOAL_MAX = 2000;
const TITLE_MAX = 200;
const TOPIC_MAX = 500;

export interface LaunchWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
  onWorkflowLaunched?: (workflowId: string) => void;
  onSwarmLaunched?: (record: SwarmSessionRecord) => void;
}

type LaunchTab = "workflow" | "swarm";

export function LaunchWorkflowDialog({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  onWorkflowLaunched,
  onSwarmLaunched,
}: LaunchWorkflowDialogProps) {
  const router = useRouter();
  const toast = useToast();

  const [tab, setTab] = useState<LaunchTab>("workflow");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Workflow fields
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [outputFormat, setOutputFormat] = useState<"json" | "csv">("json");
  const [maxParallelism, setMaxParallelism] = useState(50);

  // Swarm fields
  const [topic, setTopic] = useState("");
  const [depth, setDepth] = useState<"shallow" | "medium" | "deep">("medium");
  const [maxParallel, setMaxParallel] = useState(5);
  const [targetLabel, setTargetLabel] = useState("Topic");

  function reset() {
    setTab("workflow");
    setGoal("");
    setTitle("");
    setOutputFormat("json");
    setMaxParallelism(50);
    setTopic("");
    setDepth("medium");
    setMaxParallel(5);
    setTargetLabel("Topic");
    setError(null);
  }

  function validateWorkflow(): string | null {
    if (goal.trim().length === 0) return "Goal is required.";
    if (goal.length > GOAL_MAX)
      return `Goal must be ${GOAL_MAX} characters or fewer.`;
    if (title.length > TITLE_MAX)
      return `Title must be ${TITLE_MAX} characters or fewer.`;
    if (
      !Number.isInteger(maxParallelism) ||
      maxParallelism < 1 ||
      maxParallelism > 100
    ) {
      return "Max parallelism must be a whole number between 1 and 100.";
    }
    return null;
  }

  function validateSwarm(): string | null {
    if (topic.trim().length === 0) return "Topic is required.";
    if (topic.length > TOPIC_MAX)
      return `Topic must be ${TOPIC_MAX} characters or fewer.`;
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 20) {
      return "Max parallel searches must be a whole number between 1 and 20.";
    }
    if (targetLabel.trim().length === 0)
      return "Target knowledge-node label is required.";
    return null;
  }

  async function handleLaunchWorkflow() {
    const validationError = validateWorkflow();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setPending(true);
    // finally: the dialog refuses to close while `pending` is true, so a
    // rejected action without this would trap the user in a dialog stuck on
    // "Launching…" until the page is reloaded.
    try {
      const res = await runWorkflowAction({
        orgSlug,
        workspaceSlug,
        goal: goal.trim(),
        title: title.trim() || undefined,
        outputFormat,
        maxParallelism,
      });

      if (res.ok) {
        toast.add({
          title: "Workflow launched",
          description: res.workflow.publicId,
          type: "success",
        });
        onWorkflowLaunched?.(res.workflow.workflowId);
        reset();
        onOpenChange(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    } catch {
      setError("Launching the workflow failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleLaunchSwarm() {
    const validationError = validateSwarm();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setPending(true);
    const trimmedTopic = topic.trim();
    const trimmedLabel = targetLabel.trim();
    // finally: see handleLaunchWorkflow — `pending` also latches the dialog shut.
    try {
      const res = await startResearchSwarmAction({
        orgSlug,
        workspaceSlug,
        topic: trimmedTopic,
        depth,
        maxParallel,
        targetLabel: trimmedLabel,
      });

      if (res.ok) {
        toast.add({
          title: "Research swarm started",
          description: `${res.swarm.estimatedTasks} search task${res.swarm.estimatedTasks === 1 ? "" : "s"} dispatched`,
          type: "success",
        });
        onSwarmLaunched?.({
          swarmId: res.swarm.swarmId,
          dispatchId: res.swarm.dispatchId,
          topic: trimmedTopic,
          depth,
          maxParallel,
          targetLabel: trimmedLabel,
          status: "running",
          completedTasks: 0,
          totalTasks: res.swarm.estimatedTasks,
          launchedAt: new Date().toISOString(),
        });
        reset();
        onOpenChange(false);
      } else {
        setError(res.error);
      }
    } catch {
      setError("Starting the research swarm failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  function handleSubmit() {
    if (tab === "workflow") void handleLaunchWorkflow();
    else void handleLaunchSwarm();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Launch a workflow or research swarm</DialogTitle>
          <DialogDescription>
            Workflows decompose one goal into N parallel sub-tasks dispatched
            via Inngest. Research swarms fan out diverse web-search variations
            on a topic as concurrent subagent tasks.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as LaunchTab);
            setError(null);
          }}
        >
          <TabsList>
            <TabsTab value="workflow" data-testid="launch-tab-workflow">
              Workflow
            </TabsTab>
            <TabsTab value="swarm" data-testid="launch-tab-swarm">
              Research swarm
            </TabsTab>
          </TabsList>

          <TabsPanel value="workflow">
            <div className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="workflow-goal">Goal</Label>
                <Textarea
                  id="workflow-goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="Gather pricing pages for our top 40 competitors and summarize tiers"
                  maxLength={GOAL_MAX}
                  rows={4}
                  data-testid="workflow-goal"
                />
                <p className="text-right text-[11px] text-muted-foreground">
                  {goal.length} / {GOAL_MAX}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-title">Title (optional)</Label>
                <Input
                  id="workflow-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Competitor pricing sweep"
                  maxLength={TITLE_MAX}
                  data-testid="workflow-title"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Output format</Label>
                  <Select
                    value={outputFormat}
                    onValueChange={(v) => setOutputFormat(v as "json" | "csv")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="json">JSON</SelectItem>
                      <SelectItem value="csv">CSV</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="workflow-max-parallelism">
                    Max parallelism (1-100)
                  </Label>
                  <Input
                    id="workflow-max-parallelism"
                    type="number"
                    min={1}
                    max={100}
                    value={maxParallelism}
                    onChange={(e) => setMaxParallelism(Number(e.target.value))}
                    data-testid="workflow-max-parallelism"
                  />
                </div>
              </div>
            </div>
          </TabsPanel>

          <TabsPanel value="swarm">
            <div className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="swarm-topic">Topic</Label>
                <Textarea
                  id="swarm-topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Series A funding trends in agentic AI infrastructure"
                  maxLength={TOPIC_MAX}
                  rows={3}
                  data-testid="swarm-topic"
                />
                <p className="text-right text-[11px] text-muted-foreground">
                  {topic.length} / {TOPIC_MAX}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Depth</Label>
                  <Select
                    value={depth}
                    onValueChange={(v) => setDepth(v as typeof depth)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="shallow">
                        Shallow (~3 searches)
                      </SelectItem>
                      <SelectItem value="medium">
                        Medium (~8 searches)
                      </SelectItem>
                      <SelectItem value="deep">Deep (~15 searches)</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="swarm-max-parallel">
                    Max parallel (1-20)
                  </Label>
                  <Input
                    id="swarm-max-parallel"
                    type="number"
                    min={1}
                    max={20}
                    value={maxParallel}
                    onChange={(e) => setMaxParallel(Number(e.target.value))}
                    data-testid="swarm-max-parallel"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="swarm-target-label">
                  Target knowledge-node label
                </Label>
                <Input
                  id="swarm-target-label"
                  value={targetLabel}
                  onChange={(e) => setTargetLabel(e.target.value)}
                  placeholder="Topic"
                  data-testid="swarm-target-label"
                />
              </div>
            </div>
          </TabsPanel>
        </Tabs>

        {error && (
          <p
            className="text-sm text-error"
            role="alert"
            data-testid="launch-error"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            type="button"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={pending}
            type="button"
            data-testid="launch-submit"
          >
            {pending
              ? "Launching…"
              : tab === "workflow"
                ? "Launch workflow"
                : "Start swarm"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
