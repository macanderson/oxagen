"use client";
/**
 * agent-editor-form.tsx — create/edit form for an agent definition.
 *
 * One component drives both flows:
 *   - mode="create" → calls createAgentAction (deploys inactive/draft by default).
 *   - mode="edit"   → calls updateAgentAction (produces a NEW unpublished version).
 *
 * Sections: identity (name/slug/description), instructions, graph access
 * (ontology/mode/retrieval/budget), agent tools (function/mcp_server/skill/agent),
 * and triggers (manual/schedule/event with event filter: source/eventType/
 * branches/pathGlobs). Validation uses the SHARED agentDefinitionConfigSchema
 * from @oxagen/oxagen/agent-schema — no duplicate schema.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Save, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  agentDefinitionConfigSchema,
  type AgentDefinitionConfig,
  type AgentTool,
  type AgentTrigger,
} from "@oxagen/oxagen/agent-schema";
import { workspace } from "@/lib/routes";
import { slugify } from "./agent-ui";
import { createAgentAction, updateAgentAction } from "./agent-actions";

// ── Props ──────────────────────────────────────────────────────────────────────

export interface AgentEditorFormProps {
  mode: "create" | "edit";
  orgSlug: string;
  workspaceSlug: string;
  /** Default ontology id (the workspace id) used to seed graph access on create. */
  ontologyId: string;
  /** Existing identity — required in edit mode. */
  agentId?: string;
  /** Existing (immutable) slug — required in edit mode for post-save navigation. */
  agentSlug?: string;
  initialName?: string;
  initialDescription?: string;
  /** Existing config — required in edit mode; seeds the form. */
  initialConfig: AgentDefinitionConfig;
  /** Whether the viewing user may save (workspace owner/admin). */
  canEdit: boolean;
}

// ── Local editable shapes (strings for numeric/array inputs) ─────────────────────

interface ToolDraft {
  type: AgentTool["type"];
  ref: string;
}

interface TriggerDraft {
  type: AgentTrigger["type"];
  eventSource: string;
  eventType: string;
  schedule: string;
  branches: string;
  pathGlobs: string;
  enabled: boolean;
}

const TOOL_TYPES: AgentTool["type"][] = ["function", "mcp_server", "skill", "agent"];
const TRIGGER_TYPES: AgentTrigger["type"][] = ["manual", "schedule", "event"];

function toToolDrafts(tools: AgentTool[]): ToolDraft[] {
  return tools.map((t) => ({ type: t.type, ref: t.ref }));
}

function toTriggerDrafts(triggers: AgentTrigger[]): TriggerDraft[] {
  return triggers.map((t) => ({
    type: t.type,
    eventSource: t.eventSource ?? "",
    eventType: t.eventType ?? "",
    schedule: t.schedule ?? "",
    branches: (t.filter?.branches ?? []).join(", "),
    pathGlobs: (t.filter?.pathGlobs ?? []).join(", "),
    enabled: t.enabled ?? false,
  }));
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentEditorForm({
  mode,
  orgSlug,
  workspaceSlug,
  ontologyId,
  agentId,
  agentSlug,
  initialName = "",
  initialDescription = "",
  initialConfig,
  canEdit,
}: AgentEditorFormProps) {
  const router = useRouter();
  const { add: addToast } = useToast();

  const [name, setName] = React.useState(initialName);
  const [slug, setSlug] = React.useState(initialName ? slugify(initialName) : "");
  // In create mode the slug auto-tracks the name until the user edits it manually.
  const [slugEdited, setSlugEdited] = React.useState(mode === "edit");
  const [description, setDescription] = React.useState(initialDescription);
  const [instructions, setInstructions] = React.useState(initialConfig.instructions ?? "");

  // Graph access
  const graph = initialConfig.graph;
  const [graphMode, setGraphMode] = React.useState<NonNullable<AgentDefinitionConfig["graph"]["mode"]>>(
    graph.mode ?? "read",
  );
  const [strategy, setStrategy] = React.useState(graph.retrieval.strategy);
  const [maxHops, setMaxHops] = React.useState(String(graph.budget.maxHops));
  const [maxNodes, setMaxNodes] = React.useState(String(graph.budget.maxNodes));
  const [minRelevance, setMinRelevance] = React.useState(
    graph.budget.minRelevance != null ? String(graph.budget.minRelevance) : "",
  );

  const [tools, setTools] = React.useState<ToolDraft[]>(toToolDrafts(initialConfig.agentTools ?? []));
  const [triggers, setTriggers] = React.useState<TriggerDraft[]>(
    toTriggerDrafts(initialConfig.triggers ?? []),
  );

  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const disabled = !canEdit || isSaving;

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  }

  // ── Tool helpers ────────────────────────────────────────────────────────────
  function addTool() {
    setTools((prev) => [...prev, { type: "skill", ref: "" }]);
  }
  function updateTool(i: number, patch: Partial<ToolDraft>) {
    setTools((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function removeTool(i: number) {
    setTools((prev) => prev.filter((_, idx) => idx !== i));
  }

  // ── Trigger helpers ─────────────────────────────────────────────────────────
  function addTrigger() {
    setTriggers((prev) => [
      ...prev,
      { type: "manual", eventSource: "", eventType: "", schedule: "", branches: "", pathGlobs: "", enabled: false },
    ]);
  }
  function updateTrigger(i: number, patch: Partial<TriggerDraft>) {
    setTriggers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function removeTrigger(i: number) {
    setTriggers((prev) => prev.filter((_, idx) => idx !== i));
  }

  // ── Build + validate config ───────────────────────────────────────────────────
  function buildConfig(): AgentDefinitionConfig {
    const builtTools: AgentTool[] = tools
      .filter((t) => t.ref.trim().length > 0)
      .map((t) => ({ type: t.type, ref: t.ref.trim() }));

    const builtTriggers: AgentTrigger[] = triggers.map((t) => {
      const base: AgentTrigger = { type: t.type, enabled: t.enabled };
      if (t.type === "schedule") {
        base.schedule = t.schedule.trim();
      }
      if (t.type === "event") {
        base.eventSource = t.eventSource.trim();
        base.eventType = t.eventType.trim();
        const branches = splitList(t.branches);
        const pathGlobs = splitList(t.pathGlobs);
        if (branches.length || pathGlobs.length) {
          base.filter = {
            ...(branches.length ? { branches } : {}),
            ...(pathGlobs.length ? { pathGlobs } : {}),
          };
        }
      }
      return base;
    });

    const minRel = minRelevance.trim() === "" ? undefined : Number(minRelevance);

    return {
      graph: {
        ontologyId: graph.ontologyId || ontologyId,
        mode: graphMode,
        retrieval: { strategy },
        budget: {
          maxHops: Number(maxHops),
          maxNodes: Number(maxNodes),
          ...(minRel !== undefined && !Number.isNaN(minRel) ? { minRelevance: minRel } : {}),
        },
      },
      agentTools: builtTools,
      triggers: builtTriggers,
      instructions: instructions.trim() || undefined,
    };
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    const config = buildConfig();
    const validation = agentDefinitionConfigSchema.safeParse(config);
    if (!validation.success) {
      setError(validation.error.issues[0]?.message ?? "Invalid agent configuration.");
      return;
    }

    setIsSaving(true);
    try {
      // Each branch resolves to a normalised { ok, error?, slug? } so the
      // success-handling below is shared without unifying the two output shapes.
      const outcome: { ok: true; slug: string } | { ok: false; error: string } =
        mode === "create"
          ? await (async () => {
              const r = await createAgentAction({
                orgSlug,
                workspaceSlug,
                slug: slug.trim(),
                name: name.trim(),
                description: description.trim() || undefined,
                config: validation.data,
              });
              return r.ok
                ? { ok: true as const, slug: r.data.slug }
                : { ok: false as const, error: r.error };
            })()
          : await (async () => {
              const r = await updateAgentAction({
                orgSlug,
                workspaceSlug,
                agentId: agentId as string,
                name: name.trim(),
                description: description.trim() || undefined,
                config: validation.data,
              });
              return r.ok
                ? { ok: true as const, slug: agentSlug ?? slug.trim() }
                : { ok: false as const, error: r.error };
            })();

      if (outcome.ok) {
        addToast({
          title: mode === "create" ? "Agent created" : "New version saved",
          description:
            mode === "create"
              ? "Your agent was created as a draft. Publish a version, then deploy it."
              : "A new unpublished version was created. Publish it to make it active.",
          type: "background",
        });
        router.push(workspace.agents.detail({ orgSlug, workspaceSlug }, outcome.slug));
        router.refresh();
      } else {
        setError(outcome.error);
        addToast({ title: "Failed to save", description: outcome.error, type: "background" });
      }
    } catch {
      const message = "An unexpected error occurred. Please try again.";
      setError(message);
      addToast({ title: "Failed to save", description: message, type: "background" });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Agent editor" className="flex flex-col gap-8" noValidate>
      {/* ── Identity ─────────────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-identity-heading" className="flex flex-col gap-4">
        <p id="agent-identity-heading" className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Identity
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-name" className="text-sm font-medium text-foreground">
            Name
          </Label>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            disabled={disabled}
            placeholder="e.g. Repo Review Agent"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-slug" className="text-sm font-medium text-foreground">
            Slug
          </Label>
          <Input
            id="agent-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            disabled={disabled || mode === "edit"}
            placeholder="repo-review-agent"
            aria-describedby="agent-slug-help"
          />
          <p id="agent-slug-help" className="text-xs text-muted-foreground">
            {mode === "edit"
              ? "The slug is immutable after creation."
              : "Lowercase kebab-case. Auto-derived from the name until you edit it."}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-description" className="text-sm font-medium text-foreground">
            Description
          </Label>
          <Textarea
            id="agent-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={disabled}
            placeholder="What does this agent do? Drives routing and subagent selection."
            className="min-h-[72px] resize-y text-sm"
          />
        </div>
      </section>

      {/* ── Instructions ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-instructions-heading" className="flex flex-col gap-2">
        <p id="agent-instructions-heading" className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Instructions
        </p>
        <Label htmlFor="agent-instructions" className="text-sm font-medium text-foreground">
          System prompt
        </Label>
        <Textarea
          id="agent-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          disabled={disabled}
          placeholder="You are an agent that…"
          className="min-h-[120px] resize-y font-mono text-sm"
        />
      </section>

      {/* ── Graph access ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-graph-heading" className="flex flex-col gap-4">
        <p id="agent-graph-heading" className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Graph access
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="graph-mode" className="text-sm font-medium text-foreground">
              Mode
            </Label>
            <select
              id="graph-mode"
              value={graphMode}
              onChange={(e) => setGraphMode(e.target.value as typeof graphMode)}
              disabled={disabled}
              className="h-8 rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="read">read</option>
              <option value="extend">extend</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="graph-strategy" className="text-sm font-medium text-foreground">
              Retrieval strategy
            </Label>
            <select
              id="graph-strategy"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as typeof strategy)}
              disabled={disabled}
              className="h-8 rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="semantic">semantic</option>
              <option value="lexical">lexical</option>
              <option value="hybrid">hybrid</option>
              <option value="explicit">explicit</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="graph-max-hops" className="text-sm font-medium text-foreground">
              Max hops
            </Label>
            <Input
              id="graph-max-hops"
              type="number"
              min={0}
              value={maxHops}
              onChange={(e) => setMaxHops(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="graph-max-nodes" className="text-sm font-medium text-foreground">
              Max nodes
            </Label>
            <Input
              id="graph-max-nodes"
              type="number"
              min={1}
              value={maxNodes}
              onChange={(e) => setMaxNodes(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="graph-min-relevance" className="text-sm font-medium text-foreground">
              Min relevance (0–1, optional)
            </Label>
            <Input
              id="graph-min-relevance"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minRelevance}
              onChange={(e) => setMinRelevance(e.target.value)}
              disabled={disabled}
              placeholder="0.5"
            />
          </div>
        </div>
      </section>

      {/* ── Agent tools ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-tools-heading" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p id="agent-tools-heading" className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Agent tools
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTool}
            disabled={disabled}
            startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Add tool
          </Button>
        </div>
        {tools.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tools yet. Add functions, MCP servers, skills, or subagents.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {tools.map((tool, i) => (
              <li key={i} className="flex items-end gap-2 rounded-lg border border-border/60 bg-card px-3 py-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`tool-type-${i}`} className="text-xs text-muted-foreground">
                    Type
                  </Label>
                  <select
                    id={`tool-type-${i}`}
                    value={tool.type}
                    onChange={(e) => updateTool(i, { type: e.target.value as AgentTool["type"] })}
                    disabled={disabled}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
                  >
                    {TOOL_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor={`tool-ref-${i}`} className="text-xs text-muted-foreground">
                    Reference
                  </Label>
                  <Input
                    id={`tool-ref-${i}`}
                    value={tool.ref}
                    onChange={(e) => updateTool(i, { ref: e.target.value })}
                    disabled={disabled}
                    placeholder="function name, MCP url/id, skill slug, or agent id"
                  />
                </div>
                <Button
                  type="button"
                  variant="destructive-outline"
                  size="icon-sm"
                  onClick={() => removeTool(i)}
                  disabled={disabled}
                  aria-label={`Remove tool ${i + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Triggers ─────────────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-triggers-heading" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p id="agent-triggers-heading" className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Triggers
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTrigger}
            disabled={disabled}
            startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Add trigger
          </Button>
        </div>
        {triggers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No triggers. Add a manual, schedule, or event trigger (e.g. fire on a GitHub repo source change).
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {triggers.map((trigger, i) => (
              <li key={i} className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-3 py-3">
                <div className="flex items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`trigger-type-${i}`} className="text-xs text-muted-foreground">
                      Type
                    </Label>
                    <select
                      id={`trigger-type-${i}`}
                      value={trigger.type}
                      onChange={(e) => updateTrigger(i, { type: e.target.value as AgentTrigger["type"] })}
                      disabled={disabled}
                      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
                    >
                      {TRIGGER_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="flex items-center gap-2 pb-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={trigger.enabled}
                      onChange={(e) => updateTrigger(i, { enabled: e.target.checked })}
                      disabled={disabled}
                      aria-label={`Trigger ${i + 1} enabled`}
                    />
                    Enabled
                  </label>
                  <div className="flex-1" />
                  <Button
                    type="button"
                    variant="destructive-outline"
                    size="icon-sm"
                    onClick={() => removeTrigger(i)}
                    disabled={disabled}
                    aria-label={`Remove trigger ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>

                {trigger.type === "schedule" && (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`trigger-schedule-${i}`} className="text-xs text-muted-foreground">
                      Cron schedule
                    </Label>
                    <Input
                      id={`trigger-schedule-${i}`}
                      value={trigger.schedule}
                      onChange={(e) => updateTrigger(i, { schedule: e.target.value })}
                      disabled={disabled}
                      placeholder="0 9 * * 1"
                    />
                  </div>
                )}

                {trigger.type === "event" && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`trigger-source-${i}`} className="text-xs text-muted-foreground">
                        Event source
                      </Label>
                      <Input
                        id={`trigger-source-${i}`}
                        value={trigger.eventSource}
                        onChange={(e) => updateTrigger(i, { eventSource: e.target.value })}
                        disabled={disabled}
                        placeholder="github_repo"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`trigger-event-${i}`} className="text-xs text-muted-foreground">
                        Event type
                      </Label>
                      <Input
                        id={`trigger-event-${i}`}
                        value={trigger.eventType}
                        onChange={(e) => updateTrigger(i, { eventType: e.target.value })}
                        disabled={disabled}
                        placeholder="push"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`trigger-branches-${i}`} className="text-xs text-muted-foreground">
                        Branches (comma-separated)
                      </Label>
                      <Input
                        id={`trigger-branches-${i}`}
                        value={trigger.branches}
                        onChange={(e) => updateTrigger(i, { branches: e.target.value })}
                        disabled={disabled}
                        placeholder="main, release/*"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`trigger-paths-${i}`} className="text-xs text-muted-foreground">
                        Path globs (comma-separated)
                      </Label>
                      <Input
                        id={`trigger-paths-${i}`}
                        value={trigger.pathGlobs}
                        onChange={(e) => updateTrigger(i, { pathGlobs: e.target.value })}
                        disabled={disabled}
                        placeholder="src/**, docs/**"
                      />
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3 border-t border-border/40 pt-4">
        <Button
          type="submit"
          variant="gradient"
          size="sm"
          disabled={disabled}
          startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {isSaving ? "Saving…" : mode === "create" ? "Create agent" : "Save new version"}
        </Button>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Only workspace owners and admins can manage agents.
          </p>
        )}
      </div>
    </form>
  );
}
