"use client";
/**
 * agent-builder.tsx — the interactive Agent Builder (Workbench → Agents → new /
 * [agentId]).
 *
 * A useState-driven wizard (there is no Stepper primitive) that walks the
 * builder through the stages of defining an interactive agent. Create mode
 * leads with an AI-assisted "Describe" step (7 steps); edit mode omits it (6):
 *
 *   0. Describe  — (create only) plain-language description → agent.definition
 *                  .suggest generates a complete config, pre-filled into the
 *                  editable steps below. Skippable — manual setup is always open.
 *   1. Identity  — name, slug, description, and the "code features" switch
 *                  (persisted as agentType "coding" | "custom").
 *   2. Prompt    — the inline system prompt / instructions.
 *   3. Equip     — the uniform agentTools[] picker (skills/tools/MCP/subagents).
 *   4. Ground    — GraphAccess: ontology binding, mode, retrieval, budget.
 *   5. Access    — the agent's IAM role (Agent RBAC): the permission ceiling
 *                  the configuration is intersected with. Persisted separately
 *                  via assign_agent_role on save; new agents default to
 *                  "Agent Contributor" (auto-assigned by the backend).
 *   6. Review    — summary + effective scope (role ∩ config) + Save draft /
 *                  Publish / Publish & Deploy.
 *
 * Triggers belong to automations/playbooks, not agent definitions (#1010) —
 * the agent is a pure, portable definition with no trigger fields.
 *
 * All persistence flows through the server actions in ./actions.ts, which gate
 * every mutation on workspace Owner/Admin. A `readOnly` builder (managed agent
 * or a non-manager viewer) renders for inspection with every control disabled.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { slugify } from "@/lib/slug";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Rocket,
  Save,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type {
  AgentDefinitionConfig,
  AgentTool,
  GraphAccess,
  GraphAccessMode,
  GraphRetrievalStrategy,
} from "@oxagen/oxagen/agent-schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { AvatarMaker } from "@/components/avatar/avatar-maker";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { MarketplaceModal } from "@/components/plugins/marketplace-modal";
import { EquipPicker, type EquipSources } from "./equip-picker";
import {
  createAgentAction,
  updateAgentAction,
  publishAgentAction,
  deployAgentAction,
  suggestAgentAction,
  assignAgentRoleAction,
} from "./actions";
import type { AgentRoleOption } from "@/lib/workbench/agent-roles";
import { RolePicker } from "./role-picker";
import { EffectiveScopePanel } from "./effective-scope-panel";
import {
  mapSuggestionToPrefill,
  planRoleAssignment,
  resolveSuggestedRole,
  DEFAULT_AGENT_ROLE_NAME,
  type BuilderPrefill,
  type AgentRecommendation,
} from "./suggestion-mapping";
import { RecommendedConnections } from "./recommended-connections";

/**
 * Client-safe mirror of CODING_AGENT_TYPE / DEFAULT_AGENT_TYPE from
 * lib/workbench/agents.ts. That module is server-only (it imports the handler
 * kernel), so the two literal discriminators are duplicated here rather than
 * dragging server code into the client bundle. Keep in sync with agents.ts.
 */
const CODING_AGENT_TYPE = "code";
const DEFAULT_AGENT_TYPE = "custom";

// DEFAULT_AGENT_ROLE_NAME ("Agent Contributor" — the role the backend
// auto-assigns to every newly created agent, and the fallback when a
// suggestion carries no suggestedRole) is imported from ./suggestion-mapping
// so the client-safe mirror of packages/agent/src/handlers/_agent-role.ts
// exists in exactly one place.

// ── Props ─────────────────────────────────────────────────────────────────────

export interface InitialAgent {
  publicId: string;
  slug: string;
  /**
   * Globally-unique, immutable agent key (org_ns.workspace_ns.slug). Null only
   * pre-backfill; shown as a copyable identifier in the edit-mode header.
   */
  agentKey?: string | null;
  name: string;
  description: string | null;
  /** Avatar value: https URL or designed-avatar spec string. Null when unset. */
  avatarUrl?: string | null;
  agentType: string;
  status: "draft" | "active" | "archived";
  deploymentStatus: "inactive" | "active";
  version: number | null;
  isPublished: boolean;
  config: AgentDefinitionConfig;
}

export interface AgentBuilderProps {
  mode: "create" | "edit";
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
  readOnly: boolean;
  sources: EquipSources;
  initialAgent?: InitialAgent;
  /**
   * Install actions from the agent-tools choke point
   * (@/lib/agent-tools/install-actions) — power the Equip step's inline
   * "Install more from Marketplace" flow. Gated on canManage. Same
   * structural shape as WorkspacePluginsPanel's action props; the builder
   * injects workspaceSlug before delegating (the modal only knows
   * workspaceId).
   */
  installAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    workspaceId: string;
    catalogServerId: string;
    pluginType: EquipInstallPluginType;
    pluginId?: string;
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  installBulkAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    workspaceId: string;
    items: Array<{
      catalogServerId?: string;
      pluginType: EquipInstallPluginType;
      pluginId?: string;
    }>;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Role picker data (Agent RBAC Phase 5a), resolved server-side: candidate
   * roles with grants + delegation-ceiling pre-check, whether the tier allows
   * custom roles, a load error (degraded render), and — edit mode — the
   * currently-assigned role name (null for a pre-RBAC agent).
   */
  roleOptions: AgentRoleOption[];
  customRolesAvailable: boolean;
  rolesError: string | null;
  initialRoleName: string | null;
}

type EquipInstallPluginType =
  | "mcp_server"
  | "integration"
  | "content_tool"
  | "capability"
  | "agent_skill"
  | "agent_capability"
  | "knowledge_source";

// ── Steps ─────────────────────────────────────────────────────────────────────

/**
 * The core wizard stages, shared by create and edit. Create mode prepends a
 * "Describe" step (AI-assisted setup) as the first stage — see stepsFor().
 */
const CORE_STEPS = [
  { key: "identity", label: "Identity" },
  { key: "prompt", label: "Prompt" },
  { key: "equip", label: "Equip" },
  { key: "ground", label: "Ground" },
  { key: "access", label: "Access" },
  { key: "review", label: "Review" },
] as const;

const DESCRIBE_STEP = { key: "describe", label: "Describe" } as const;

type BuilderStep = { key: string; label: string };

/** 7 steps in create mode (Describe first), 6 in edit mode (Describe omitted). */
function stepsFor(mode: "create" | "edit"): BuilderStep[] {
  return mode === "create" ? [DESCRIBE_STEP, ...CORE_STEPS] : [...CORE_STEPS];
}

const RETRIEVAL_STRATEGIES: GraphRetrievalStrategy[] = [
  "hybrid",
  "semantic",
  "lexical",
  "explicit",
];

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentBuilder({
  mode,
  orgSlug,
  workspaceSlug,
  canManage,
  readOnly,
  sources,
  initialAgent,
  installAction,
  installBulkAction,
  roleOptions,
  customRolesAvailable,
  rolesError,
  initialRoleName,
}: AgentBuilderProps) {
  const router = useRouter();
  const { add } = useToast();
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const initialGraph = initialAgent?.config.graph;

  // Identity
  const [name, setName] = React.useState(initialAgent?.name ?? "");
  const [slug, setSlug] = React.useState(initialAgent?.slug ?? "");
  const [slugEdited, setSlugEdited] = React.useState(mode === "edit");
  const [description, setDescription] = React.useState(
    initialAgent?.description ?? "",
  );
  // Avatar value (photo URL or designed spec string) — persisted with the draft.
  const [avatarUrl, setAvatarUrl] = React.useState(
    initialAgent?.avatarUrl ?? "",
  );
  const [codeFeatures, setCodeFeatures] = React.useState(
    (initialAgent?.agentType ?? DEFAULT_AGENT_TYPE) === CODING_AGENT_TYPE,
  );

  // Prompt
  const [instructions, setInstructions] = React.useState(
    initialAgent?.config.instructions ?? "",
  );

  // Equip
  const [agentTools, setAgentTools] = React.useState<AgentTool[]>(
    initialAgent?.config.agentTools ?? [],
  );

  // Ground (GraphAccess)
  const [ontologyId, setOntologyId] = React.useState(
    initialGraph?.ontologyId ?? "",
  );
  const [graphMode, setGraphMode] = React.useState<GraphAccessMode>(
    initialGraph?.mode ?? "read",
  );
  const [strategy, setStrategy] = React.useState<GraphRetrievalStrategy>(
    initialGraph?.retrieval.strategy ?? "hybrid",
  );
  const [maxHops, setMaxHops] = React.useState(
    initialGraph?.budget.maxHops ?? 2,
  );
  const [maxNodes, setMaxNodes] = React.useState(
    initialGraph?.budget.maxNodes ?? 40,
  );

  // Access (Agent RBAC role). selectedRoleName is what the user picked;
  // assignedRoleName is what is persisted on the agent (updates after a
  // successful assign; defaults to "Agent Contributor" right after create
  // because the backend auto-assigns it).
  const [selectedRoleName, setSelectedRoleName] = React.useState(
    initialRoleName ?? DEFAULT_AGENT_ROLE_NAME,
  );
  const [assignedRoleName, setAssignedRoleName] = React.useState<string | null>(
    initialRoleName,
  );
  // Last role-assignment failure (delegation-ceiling race, tier gate, …) —
  // shown on the Access step until the next save attempt.
  const [roleActionError, setRoleActionError] = React.useState<string | null>(
    null,
  );
  // Provenance for an AI-pre-selected role (Agent RBAC Phase 5b): why the
  // suggestion landed on this ceiling and not a narrower one. Cleared the
  // moment the user picks a different role — the line would no longer describe
  // the selection. Null whenever the role was not AI-set.
  const [roleSuggestionReason, setRoleSuggestionReason] = React.useState<
    string | null
  >(null);

  // Steps: create mode leads with the AI-assisted "Describe" step.
  const steps = React.useMemo(() => stepsFor(mode), [mode]);
  // Index of the first editable stage — where Skip and a successful Generate land.
  const identityIdx = steps.findIndex((s) => s.key === "identity");

  // Describe (AI-assisted setup) — create mode only.
  const [describeText, setDescribeText] = React.useState("");
  const [suggesting, setSuggesting] = React.useState(false);
  const [suggestError, setSuggestError] = React.useState<string | null>(null);
  // Set once a suggestion is applied; drives the cross-step "generated" banner.
  const [prefillMeta, setPrefillMeta] = React.useState<{
    rationale: string;
    warnings: string[];
  } | null>(null);
  const [bannerDismissed, setBannerDismissed] = React.useState(false);
  const [rationaleOpen, setRationaleOpen] = React.useState(false);
  // "Connect this next" recommendations from the last suggestion — tools the
  // agent SHOULD have but that aren't available in the workspace yet, so they
  // are NOT prefilled into agentTools. Component state, never persisted.
  const [recommendations, setRecommendations] = React.useState<
    AgentRecommendation[]
  >([]);

  // The persisted, immutable agent key (edit mode). Null pre-backfill or in
  // create mode until the agent is saved and the namespaces are prepended.
  const agentKey = initialAgent?.agentKey ?? null;

  // Flow
  const [stepIdx, setStepIdx] = React.useState(0);
  // Inline marketplace install from the Equip step. Closing the modal
  // refreshes the route so freshly-installed tools appear in the pools
  // (equip sources are loaded server-side).
  const [marketplaceOpen, setMarketplaceOpen] = React.useState(false);
  const handleMarketplaceOpenChange = (open: boolean) => {
    setMarketplaceOpen(open);
    if (!open) router.refresh();
  };
  const [busy, setBusy] = React.useState(false);
  // The live agent id once created; drives whether Save issues create vs update.
  const [agentId, setAgentId] = React.useState<string | null>(
    initialAgent?.publicId ?? null,
  );
  const [deployed, setDeployed] = React.useState(
    initialAgent?.deploymentStatus === "active",
  );

  const step = steps[stepIdx]!;
  const disabled = readOnly || busy;
  // The selected role's option row — feeds the Review step's effective-scope
  // accountability view (role ceiling ∩ config, display-only).
  const selectedRoleOption = roleOptions.find(
    (o) => o.roleName === selectedRoleName,
  );

  function onNameChange(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugify(value, 60));
  }

  /**
   * Fan a suggestion out across the wizard's flat state. Marks the slug as
   * user-edited so the AI-chosen slug survives later name edits, and leaves
   * every field fully editable in the normal steps.
   */
  function applyPrefill(p: BuilderPrefill, roleReason?: string) {
    setName(p.name);
    setSlug(p.slug);
    setSlugEdited(true);
    setDescription(p.description);
    setCodeFeatures(p.codeFeatures);
    setInstructions(p.instructions);
    setAgentTools(p.agentTools);
    setOntologyId(p.ontologyId);
    setGraphMode(p.graphMode);
    setStrategy(p.strategy);
    setMaxHops(p.maxHops);
    setMaxNodes(p.maxNodes);
    // Access step: the role is a prefill field like any other — pre-selected,
    // then reviewed on the Access step and re-checked on the Review step's
    // effective-scope panel (role ceiling ∩ this config) before anything saves.
    // resolveSuggestedRole refuses a role the picker does not actually offer,
    // so the AI can never select past the viewer's own delegation ceiling.
    const resolved = resolveSuggestedRole(p.roleName, roleOptions);
    setSelectedRoleName(resolved.roleName);
    setRoleSuggestionReason(
      resolved.aiSelected && roleReason?.trim() ? roleReason : null,
    );
    setRoleActionError(null);
  }

  async function onGenerate() {
    const description = describeText.trim();
    if (description.length < 10) {
      setSuggestError("Describe the agent in at least 10 characters.");
      return;
    }
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await suggestAgentAction({
        orgSlug,
        workspaceSlug,
        description,
      });
      if (!res.ok) {
        setSuggestError(res.error);
        return;
      }
      applyPrefill(
        mapSuggestionToPrefill(res.suggestion, res.suggestedRole),
        res.suggestedRole?.reason,
      );
      setPrefillMeta({ rationale: res.rationale, warnings: res.warnings });
      setRecommendations(res.recommendations);
      setBannerDismissed(false);
      setRationaleOpen(false);
      // Land on Identity so the user reviews the generated config top-to-bottom.
      if (identityIdx >= 0) setStepIdx(identityIdx);
    } finally {
      setSuggesting(false);
    }
  }

  function onSkipDescribe() {
    setSuggestError(null);
    if (identityIdx >= 0) setStepIdx(identityIdx);
  }

  function buildConfig(): AgentDefinitionConfig {
    // scopeToTypes / minRelevance / maxTraversalMs are not (yet) editable in
    // the wizard — preserve them from the loaded config instead of silently
    // dropping them on save (they are real dimensions of the effective scope).
    const graph: GraphAccess = {
      ontologyId: ontologyId.trim(),
      mode: graphMode,
      retrieval: {
        strategy,
        ...(initialGraph?.retrieval.scopeToTypes !== undefined
          ? { scopeToTypes: initialGraph.retrieval.scopeToTypes }
          : {}),
      },
      budget: {
        maxHops,
        maxNodes,
        ...(initialGraph?.budget.minRelevance !== undefined
          ? { minRelevance: initialGraph.budget.minRelevance }
          : {}),
        ...(initialGraph?.budget.maxTraversalMs !== undefined
          ? { maxTraversalMs: initialGraph.budget.maxTraversalMs }
          : {}),
      },
    };
    return {
      graph,
      agentTools,
      instructions: instructions.trim() || undefined,
    };
  }

  function agentType(): string {
    return codeFeatures ? CODING_AGENT_TYPE : DEFAULT_AGENT_TYPE;
  }

  /**
   * Persist the role selection once the definition is saved (Agent RBAC
   * Phase 5a). A freshly-created agent already holds "Agent Contributor"
   * (auto-assigned by the backend), so the sync is a no-op unless the picker
   * diverges from what is persisted. Assign-then-revoke ordering lives in
   * the server action. Non-fatal by design: a rejected assignment (e.g. the
   * delegation ceiling losing a race, a tier gate) never undoes the saved
   * draft — it surfaces as a partial-success toast plus an inline error on
   * the Access step, and the persisted role stays what it was.
   */
  async function syncRole(
    agentPublicId: string,
    wasCreated: boolean,
  ): Promise<void> {
    const persistedRole = wasCreated
      ? DEFAULT_AGENT_ROLE_NAME
      : assignedRoleName;
    if (wasCreated) setAssignedRoleName(DEFAULT_AGENT_ROLE_NAME);
    // Pure decision (unit-tested in suggestion-mapping.test.ts): assign only
    // when the selection diverges from what is persisted, revoking the role it
    // replaces. An AI-suggested role reaches assign_agent_role through exactly
    // this path — there is no separate mechanism for AI-drafted agents.
    const plan = planRoleAssignment({
      selectedRoleName,
      persistedRoleName: persistedRole,
    });
    if (plan.assign === null) {
      setRoleActionError(null);
      return;
    }
    const res = await assignAgentRoleAction({
      orgSlug,
      workspaceSlug,
      agentId: agentPublicId,
      roleName: plan.assign,
      ...(plan.revoke !== undefined ? { previousRoleName: plan.revoke } : {}),
    });
    if (res.ok) {
      setAssignedRoleName(res.roleName);
      setRoleActionError(null);
      return;
    }
    const message =
      res.code === "agent_role_ceiling_exceeded"
        ? `You cannot delegate permissions you do not hold — "${selectedRoleName}" ` +
          `grants capabilities beyond your own access` +
          (res.capabilities && res.capabilities.length > 0
            ? ` (${res.capabilities.slice(0, 3).join(", ")}${res.capabilities.length > 3 ? ", …" : ""}).`
            : ".")
        : res.error;
    setRoleActionError(message);
    add({
      title: "Draft saved — role not applied",
      description: message,
      type: "error",
    });
  }

  /**
   * Persist the draft: create on first save, update thereafter. Returns the
   * live agent public id, or null on failure (a toast is raised either way).
   * A successful save also syncs the Access step's role selection.
   */
  async function persistDraft(): Promise<string | null> {
    const config = buildConfig();
    if (agentId) {
      const res = await updateAgentAction({
        orgSlug,
        workspaceSlug,
        agentId,
        name: name.trim(),
        description: description.trim() || undefined,
        // null clears a previously-set avatar; a string sets it.
        avatarUrl: avatarUrl || null,
        agentType: agentType(),
        config,
      });
      if (!res.ok) {
        add({ title: "Save failed", description: res.error, type: "error" });
        return null;
      }
      await syncRole(agentId, false);
      return agentId;
    }
    const res = await createAgentAction({
      orgSlug,
      workspaceSlug,
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      avatarUrl: avatarUrl || undefined,
      agentType: agentType(),
      config,
    });
    if (!res.ok) {
      add({ title: "Create failed", description: res.error, type: "error" });
      return null;
    }
    setAgentId(res.publicId);
    await syncRole(res.publicId, true);
    // Move the URL to the durable edit route so a refresh lands on the agent.
    router.replace(workspace.workbench.agent(routeCtx, res.publicId));
    return res.publicId;
  }

  async function onSaveDraft() {
    setBusy(true);
    try {
      const id = await persistDraft();
      if (id) {
        add({
          title: "Draft saved",
          description: `${name.trim() || "Agent"} saved as a draft.`,
          type: "success",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function onPublish() {
    setBusy(true);
    try {
      const id = await persistDraft();
      if (!id) return;
      const res = await publishAgentAction({
        orgSlug,
        workspaceSlug,
        agentId: id,
      });
      if (!res.ok) {
        add({ title: "Publish failed", description: res.error, type: "error" });
        return;
      }
      add({
        title: "Published",
        description: `Version ${res.version} is published.`,
        type: "success",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onPublishDeploy() {
    setBusy(true);
    try {
      const id = await persistDraft();
      if (!id) return;
      const pub = await publishAgentAction({
        orgSlug,
        workspaceSlug,
        agentId: id,
      });
      if (!pub.ok) {
        add({ title: "Publish failed", description: pub.error, type: "error" });
        return;
      }
      const dep = await deployAgentAction({
        orgSlug,
        workspaceSlug,
        agentId: id,
        deploymentStatus: "active",
      });
      if (!dep.ok) {
        add({ title: "Deploy failed", description: dep.error, type: "error" });
        return;
      }
      setDeployed(true);
      add({
        title: "Published & deployed",
        description: "Deployed. Launch it from the Ask surface.",
        type: "success",
      });
    } finally {
      setBusy(false);
    }
  }

  const canSaveIdentity =
    name.trim().length > 0 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug.trim());

  /**
   * Per-step "has content" signal for the rail — a filled check means the
   * builder holds something durable for that stage, not that the stage is
   * mandatory. Describe and Review are waypoints, never "complete".
   */
  function stepFilled(key: string): boolean {
    switch (key) {
      case "identity":
        return canSaveIdentity;
      case "prompt":
        return instructions.trim().length > 0;
      case "equip":
        return agentTools.length > 0;
      case "ground":
        return ontologyId.trim().length > 0;
      case "access":
        // A role is always selected (default "Agent Contributor"); the chip
        // fills once the selection is persisted on the agent.
        return (
          assignedRoleName !== null && assignedRoleName === selectedRoleName
        );
      default:
        return false;
    }
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:gap-8">
      {/* Step rail — horizontal scroll strip on mobile (44px+ touch targets),
          vertical rail on desktop. Chips flip to a check once a stage holds
          real content, so overall progress is glanceable from any step. */}
      <nav
        className="flex flex-row gap-1 overflow-x-auto max-lg:-mx-1 max-lg:px-1 lg:w-52 lg:flex-col lg:gap-0.5"
        aria-label="Builder steps"
      >
        {steps.map((s, i) => {
          const active = i === stepIdx;
          const filled = stepFilled(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setStepIdx(i)}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors max-lg:min-h-11 max-lg:flex-shrink-0 ${
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              }`}
              aria-current={active ? "step" : undefined}
              data-testid={`builder-step-${s.key}`}
            >
              <span
                className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : filled
                      ? "border-success/50 bg-success/10 text-success"
                      : "border-border bg-background text-muted-foreground"
                }`}
                aria-hidden="true"
              >
                {filled && !active ? (
                  <Check className="h-3 w-3" aria-hidden="true" />
                ) : (
                  i + 1
                )}
              </span>
              <span className="whitespace-nowrap">{s.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Step content */}
      <div className="flex-1 min-w-0">
        {/* Immutable agent key — the globally-unique, human-readable identity.
            Shown once the agent exists (edit mode) and its namespaces are
            backfilled; copyable for API calls and A2A routing. */}
        {mode === "edit" && agentKey ? (
          <div
            className="mb-4 flex flex-wrap items-center gap-2"
            data-testid="agent-key-header"
          >
            <span className="text-xs font-medium text-muted-foreground">
              Agent key
            </span>
            <CopyableId value={agentKey} label="key" max={64} />
          </div>
        ) : null}

        {readOnly ? (
          <div
            className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
            role="status"
          >
            {initialAgent?.status === "archived"
              ? "This agent is archived."
              : "This agent is read-only — managed agents and non-admins can view but not change it."}
          </div>
        ) : null}

        {/* AI-prefill banner — shown across every step after a suggestion is
            applied (but not on the Describe step itself, its source). */}
        {prefillMeta && !bannerDismissed && step.key !== "describe" ? (
          <div
            className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
            role="status"
            data-testid="agent-prefill-banner"
          >
            <div className="flex items-start gap-3">
              <Sparkles
                className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  Configuration generated from your description — review and
                  edit anything before saving.
                </p>
                {prefillMeta.rationale.trim() ? (
                  <div>
                    <button
                      type="button"
                      onClick={() => setRationaleOpen((o) => !o)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                      aria-expanded={rationaleOpen}
                      data-testid="agent-prefill-rationale-toggle"
                    >
                      {rationaleOpen ? (
                        <ChevronUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3 w-3" aria-hidden="true" />
                      )}
                      Why this configuration
                    </button>
                    {rationaleOpen ? (
                      <p
                        className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground"
                        data-testid="agent-prefill-rationale"
                      >
                        {prefillMeta.rationale}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {prefillMeta.warnings.length > 0 ? (
                  <ul
                    className="list-inside list-disc space-y-0.5 text-xs text-warning"
                    data-testid="agent-prefill-warnings"
                  >
                    {prefillMeta.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                <RecommendedConnections
                  recommendations={recommendations}
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                />
              </div>
              <button
                type="button"
                onClick={() => setBannerDismissed(true)}
                className="flex-shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                aria-label="Dismiss"
                data-testid="agent-prefill-dismiss"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}

        {/* Quick save — reachable from every config step, not just Review, so
            long wizards never lose work to a mis-tap. Describe has nothing to
            save yet; Review carries the full action set. */}
        {!readOnly && step.key !== "describe" && step.key !== "review" ? (
          <div className="mb-2 flex items-center justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || !canSaveIdentity}
              onClick={onSaveDraft}
              startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
              data-testid="agent-save-draft-inline"
            >
              Save draft
            </Button>
          </div>
        ) : null}

        <div className="rounded-lg border bg-card p-4 sm:p-6">
          {/* ── Describe (AI-assisted setup, create mode only) ───────────── */}
          {step.key === "describe" ? (
            <div className="flex flex-col gap-4" data-testid="step-describe">
              <div className="space-y-1">
                <Label htmlFor="agent-describe">
                  Describe the agent in plain language
                </Label>
                <Textarea
                  id="agent-describe"
                  value={describeText}
                  disabled={disabled}
                  rows={6}
                  placeholder="Describe what this agent should do — its job, what starts it, and what it may touch. Example: A release-notes writer that reads merged PRs from our GitHub repo each Friday and drafts a changelog grounded in the engineering ontology."
                  onChange={(e) => setDescribeText(e.target.value)}
                  data-testid="agent-describe-input"
                />
                <p className="text-xs text-muted-foreground">
                  Oxagen drafts a complete configuration — identity, prompt,
                  tools, and graph access — grounded in this workspace&rsquo;s
                  real skills and ontologies. You review and edit every field
                  before anything is saved.
                </p>
              </div>

              {suggestError ? (
                <div
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                  data-testid="agent-describe-error"
                >
                  {suggestError}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="gradient"
                  size="sm"
                  disabled={
                    disabled || suggesting || describeText.trim().length < 10
                  }
                  onClick={onGenerate}
                  startIcon={
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  }
                  data-testid="agent-describe-generate"
                >
                  {suggesting ? "Generating…" : "Generate with AI"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || suggesting}
                  onClick={onSkipDescribe}
                  data-testid="agent-describe-skip"
                >
                  Skip — configure manually
                </Button>
              </div>
            </div>
          ) : null}

          {/* ── Identity ─────────────────────────────────────────────────── */}
          {step.key === "identity" ? (
            <div className="flex flex-col gap-5" data-testid="step-identity">
              {/* Agent avatar — photo or designed emoji/color tile, shown on
                  the agents card grid and anywhere the agent is cited. */}
              <div className="space-y-1">
                <Label>Avatar</Label>
                <AvatarMaker
                  value={avatarUrl || null}
                  onChange={setAvatarUrl}
                  name={name || slug || "Agent"}
                  shape="square"
                  entityLabel="agent"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  disabled={disabled}
                  placeholder="Release Notes Writer"
                  onChange={(e) => onNameChange(e.target.value)}
                  data-testid="agent-name-input"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="agent-slug">Slug</Label>
                <Input
                  id="agent-slug"
                  value={slug}
                  // Slug is immutable after creation (the update contract does not
                  // accept it); lock it in edit mode.
                  disabled={disabled || mode === "edit"}
                  placeholder="release-notes-writer"
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(slugify(e.target.value, 60));
                  }}
                  className="font-mono"
                  data-testid="agent-slug-input"
                />
                <p className="text-xs text-muted-foreground">
                  Lowercase kebab-case. Used in URLs and A2A routing.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="agent-description">Description</Label>
                <Textarea
                  id="agent-description"
                  value={description}
                  disabled={disabled}
                  rows={2}
                  placeholder="What does this agent do? Drives routing and subagent selection."
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="agent-description-input"
                />
              </div>
              <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 px-3 py-3">
                <div>
                  <Label
                    htmlFor="agent-code-features"
                    className="text-sm font-medium"
                  >
                    Code features
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Enables the sandboxed coding path (file edits, terminal,
                    repo tools). Off is a plain conversational / tool agent.
                  </p>
                </div>
                <Switch
                  id="agent-code-features"
                  checked={codeFeatures}
                  disabled={disabled}
                  onCheckedChange={setCodeFeatures}
                  data-testid="agent-code-features-switch"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                The model is resolved by the platform gateway at run time — no
                per-agent model pin in Phase 1.
              </p>
            </div>
          ) : null}

          {/* ── Prompt ───────────────────────────────────────────────────── */}
          {step.key === "prompt" ? (
            <div className="flex flex-col gap-3" data-testid="step-prompt">
              <div className="space-y-1">
                <Label htmlFor="agent-instructions">System prompt</Label>
                <Textarea
                  id="agent-instructions"
                  value={instructions}
                  disabled={disabled}
                  rows={12}
                  placeholder="You are a precise, citation-grounded agent. Ground every claim in the workspace knowledge graph…"
                  onChange={(e) => setInstructions(e.target.value)}
                  data-testid="agent-instructions-input"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Baked into the agent definition. Optional — leave blank to use
                  the platform default.
                </p>
              </div>
            </div>
          ) : null}

          {/* ── Equip ────────────────────────────────────────────────────── */}
          {step.key === "equip" ? (
            <div className="flex flex-col gap-3" data-testid="step-equip">
              <p className="text-sm text-muted-foreground">
                Everything this agent loads — skills, tools, MCP servers, and
                subagents — as one uniform list.
              </p>
              <EquipPicker
                sources={sources}
                value={agentTools}
                onChange={setAgentTools}
                disabled={disabled}
                onBrowseMarketplace={
                  canManage && !readOnly
                    ? () => setMarketplaceOpen(true)
                    : undefined
                }
              />
              <MarketplaceModal
                open={marketplaceOpen}
                onOpenChange={handleMarketplaceOpenChange}
                installAction={(input) =>
                  installAction({ ...input, workspaceSlug })
                }
                installBulkAction={(input) =>
                  installBulkAction({ ...input, workspaceSlug })
                }
              />
              {/* Suggested tools the workspace doesn't have yet — surfaced here
                  (not only in the dismissable banner) so they stay in view while
                  the user equips. Connect them, then re-generate or add them
                  above once available. */}
              <RecommendedConnections
                recommendations={recommendations}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            </div>
          ) : null}

          {/* ── Ground ───────────────────────────────────────────────────── */}
          {step.key === "ground" ? (
            <div className="flex flex-col gap-5" data-testid="step-ground">
              <p className="text-sm text-muted-foreground">
                Bind the agent to an ontology and bound its scoped graph
                queries. Defaults are safe — you can skip this.
              </p>
              <div className="space-y-1">
                <Label htmlFor="agent-ontology">Ontology id</Label>
                <Input
                  id="agent-ontology"
                  value={ontologyId}
                  disabled={disabled}
                  placeholder="ont_… (leave blank to bind later)"
                  onChange={(e) => setOntologyId(e.target.value)}
                  className="font-mono"
                  data-testid="agent-ontology-input"
                />
              </div>
              <fieldset className="space-y-2" disabled={disabled}>
                <legend className="text-sm font-medium">Access mode</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="agent-graph-mode"
                    className="mt-1"
                    checked={graphMode === "read"}
                    onChange={() => setGraphMode("read")}
                    disabled={disabled}
                  />
                  <span>
                    <span className="font-medium text-foreground">Read</span>
                    <span className="block text-xs text-muted-foreground">
                      Query-only. The agent never proposes new nodes or edges.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="agent-graph-mode"
                    className="mt-1"
                    checked={graphMode === "extend"}
                    onChange={() => setGraphMode("extend")}
                    disabled={disabled}
                  />
                  <span>
                    <span className="font-medium text-foreground">Extend</span>
                    <span className="block text-xs text-muted-foreground">
                      May propose new nodes and edges into the ontology.
                    </span>
                  </span>
                </label>
              </fieldset>
              <div className="space-y-1">
                <Label>Retrieval strategy</Label>
                <Select
                  value={strategy}
                  onValueChange={(v) =>
                    setStrategy(v as GraphRetrievalStrategy)
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    disabled={disabled}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {RETRIEVAL_STRATEGIES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="agent-max-hops">Max hops</Label>
                  <Input
                    id="agent-max-hops"
                    type="number"
                    min={0}
                    step={1}
                    size="sm"
                    disabled={disabled}
                    value={maxHops}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setMaxHops(
                        Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
                      );
                    }}
                    data-testid="agent-max-hops-input"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="agent-max-nodes">Max nodes</Label>
                  <Input
                    id="agent-max-nodes"
                    type="number"
                    min={1}
                    step={1}
                    size="sm"
                    disabled={disabled}
                    value={maxNodes}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setMaxNodes(
                        Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1,
                      );
                    }}
                    data-testid="agent-max-nodes-input"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* ── Access (Agent RBAC role) ─────────────────────────────────── */}
          {step.key === "access" ? (
            <div className="flex flex-col gap-4" data-testid="step-access">
              {roleActionError ? (
                <div
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                  data-testid="agent-role-action-error"
                >
                  {roleActionError}
                </div>
              ) : null}
              {roleSuggestionReason ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
                  role="status"
                  data-testid="agent-role-suggestion-reason"
                >
                  <Sparkles
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {selectedRoleName}
                    </span>{" "}
                    was pre-selected from your description — the narrowest role
                    that can still do the job. {roleSuggestionReason} Pick a
                    different one if that is not the ceiling you want.
                  </p>
                </div>
              ) : null}
              <RolePicker
                options={roleOptions}
                value={selectedRoleName}
                onChange={(roleName) => {
                  setSelectedRoleName(roleName);
                  setRoleActionError(null);
                  // The AI provenance described the previous selection — a
                  // manual pick is the user's own, so stop attributing it.
                  setRoleSuggestionReason(null);
                }}
                disabled={disabled}
                customRolesAvailable={customRolesAvailable}
                rolesError={rolesError}
                assignedRoleName={assignedRoleName}
              />
            </div>
          ) : null}

          {/* ── Review ───────────────────────────────────────────────────── */}
          {step.key === "review" ? (
            <div className="flex flex-col gap-5" data-testid="step-review">
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <SummaryItem label="Name" value={name.trim() || "—"} />
                <SummaryItem label="Slug" value={slug.trim() || "—"} mono />
                <SummaryItem
                  label="Code features"
                  value={codeFeatures ? "On (coding)" : "Off (custom)"}
                />
                <SummaryItem
                  label="Instructions"
                  value={instructions.trim() ? "Set" : "Platform default"}
                />
                <SummaryItem
                  label="Equipped"
                  value={`${agentTools.length} item${agentTools.length !== 1 ? "s" : ""}`}
                />
                <SummaryItem
                  label="Ontology"
                  value={ontologyId.trim() || "Not bound"}
                  mono
                />
                <SummaryItem
                  label="Graph"
                  value={`${graphMode} · ${strategy} · ${maxHops} hops / ${maxNodes} nodes`}
                />
                <SummaryItem
                  label="Role"
                  value={
                    selectedRoleName +
                    (assignedRoleName !== selectedRoleName
                      ? " (applied on save)"
                      : "")
                  }
                />
              </dl>

              {/* Agent key — persisted & copyable in edit mode; a slug-only
                  preview in create mode (the org/workspace namespaces are
                  prepended server-side and the full key is assigned on save). */}
              <div
                className="rounded-md border bg-muted/20 px-3 py-2"
                data-testid="agent-key-review"
              >
                <div className="mb-1 text-xs text-muted-foreground">
                  Agent key
                </div>
                {mode === "edit" && agentKey ? (
                  <CopyableId value={agentKey} label="key" max={64} />
                ) : (
                  <>
                    <div className="font-mono text-xs text-foreground">
                      <span className="text-muted-foreground/60">
                        org.workspace.
                      </span>
                      {slug.trim() || "<slug>"}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The full globally-unique key — your org and workspace
                      namespaces prepended to the slug — is assigned when the
                      agent is saved.
                    </p>
                  </>
                )}
              </div>

              {agentTools.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {agentTools.map((t) => (
                    <Badge
                      key={`${t.type}:${t.ref}`}
                      variant="secondary"
                      className="text-[10px]"
                    >
                      {t.type}: {t.ref}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {/* Effective scope (Agent RBAC): role ceiling ∩ configuration
                  across capabilities / graph / MCP / skills+subagents.
                  Display-only — computed with the resolver's own exported
                  intersection helpers, never enforced here. */}
              <div className="border-t pt-4">
                <EffectiveScopePanel
                  role={selectedRoleOption}
                  graph={{
                    mode: graphMode,
                    maxHops,
                    maxNodes,
                    ...(initialGraph?.budget.maxTraversalMs !== undefined
                      ? { maxTraversalMs: initialGraph.budget.maxTraversalMs }
                      : {}),
                    ...(initialGraph?.retrieval.scopeToTypes !== undefined
                      ? { scopeToTypes: initialGraph.retrieval.scopeToTypes }
                      : {}),
                  }}
                  agentTools={agentTools}
                />
              </div>

              {!readOnly ? (
                <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || !canSaveIdentity}
                    onClick={onSaveDraft}
                    startIcon={
                      <Save className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    data-testid="agent-save-draft"
                  >
                    Save draft
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={disabled || !canSaveIdentity}
                    onClick={onPublish}
                    startIcon={
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    data-testid="agent-publish"
                  >
                    Publish
                  </Button>
                  <Button
                    type="button"
                    variant="gradient"
                    size="sm"
                    disabled={disabled || !canSaveIdentity}
                    onClick={onPublishDeploy}
                    startIcon={
                      <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    data-testid="agent-publish-deploy"
                  >
                    Publish & deploy
                  </Button>
                  {deployed && agentId ? (
                    <a
                      href={`${workspace.sessions(routeCtx)}?agent=${encodeURIComponent(agentId)}`}
                      className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
                      data-testid="agent-launch-link"
                    >
                      Launch{" "}
                      <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              ) : null}
              {!canSaveIdentity && !readOnly ? (
                <p className="text-xs text-destructive">
                  A name and a valid kebab-case slug are required before saving.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Step nav — inline row on ≥md; below md a FIXED thumb bar docked
            flush on top of the MobileBottomBar. Fixed, never sticky: sticky
            floated mid-content on short steps and reserved a phantom band on
            768–1023px viewports where the bottom bar (sub-`md` geometry, see
            globals.css --bottom-bar-h) doesn't render at all. The in-flow
            spacer keeps the last field scrollable clear of the fixed bar,
            mirroring MobileSettingsNav (3.8125rem = py-2 ×2 + h-11 + border). */}
        <div className="h-[3.8125rem] md:hidden" aria-hidden="true" />
        <div
          // Marker consumed by globals.css: fixed bottom overlays (the PWA
          // install toast) stack above this bar instead of covering it.
          data-mobile-section-nav=""
          className="mt-4 flex items-center justify-between gap-3 max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(var(--bottom-bar-h)+env(safe-area-inset-bottom))] max-md:z-30 max-md:mt-0 max-md:border-t max-md:border-border/60 max-md:bg-background/95 max-md:px-4 max-md:py-2 max-md:backdrop-blur"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-md:h-11 max-md:flex-1"
            disabled={stepIdx === 0}
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            startIcon={<ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />}
            data-testid="builder-prev"
          >
            Back
          </Button>
          <span
            className="text-xs tabular-nums text-muted-foreground md:hidden"
            aria-label={`Step ${stepIdx + 1} of ${steps.length}`}
          >
            {stepIdx + 1} / {steps.length}
          </span>
          {stepIdx < steps.length - 1 ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="max-md:h-11 max-md:flex-1"
              onClick={() =>
                setStepIdx((i) => Math.min(steps.length - 1, i + 1))
              }
              endIcon={
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              }
              data-testid="builder-next"
            >
              Next
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground max-md:flex-1 max-md:text-right">
              {mode === "edit" && initialAgent
                ? `Editing ${initialAgent.slug} · v${initialAgent.version ?? "—"}`
                : "New agent"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-foreground ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
