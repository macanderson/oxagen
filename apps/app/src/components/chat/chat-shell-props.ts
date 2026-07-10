/**
 * chat-shell-props.ts — the ChatShell/ChatShellClient prop contract, as a
 * type-only leaf.
 *
 * chat-shell.tsx (server) value-imports ChatShellClient while the client
 * type-imported ChatShellProps back from chat-shell.tsx — a two-file import
 * cycle. The contract lives here so both sides depend downward only;
 * chat-shell.tsx re-exports the type for existing consumers.
 */
import type { ChatMessage } from "./message-bubble";
import type { ComposerAction } from "./message-composer";
import type { BackgroundTaskSnapshot } from "./background-task-tray";
import type { ComposerModelState, WorkspaceBudgetGovernance } from "./model-picker";
import type { McpServerSummary } from "./mcp-types";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import type { AgentOption } from "./agent-selector";

export interface ChatShellProps {
  conversationId: string | null;
  /** Public id (e.g. "conv_…") used to fetch conversation assets. */
  conversationPublicId?: string | null;
  activeLeafMessageId: string | null;
  messagesPromise: Promise<ChatMessage[]>;
  sendAction: ComposerAction;
  resolveApprovalAction: (
    approvalId: string,
    decision: "approved" | "denied",
  ) => Promise<{ ok: boolean; error?: string }>;
  resolveConsentAction: (
    approvalId: string,
    decision: "granted" | "denied",
    grantAllTools: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  resolvePlanAction: (
    planId: string,
    decision: "approved" | "denied" | "amended",
    amendedSteps?: import("./stream-event-types").PlanStep[],
  ) => Promise<{ ok: boolean; error?: string }>;
  fetchBackgroundTask: (taskId: string) => Promise<BackgroundTaskSnapshot>;
  cancelBackgroundTask?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  initialBackgroundTaskIds?: string[];
  agentCapabilities?: readonly import("./plan-card").AgentCapability[];
  /** Slug values forwarded to ChatShellClient for /api/v1/chat/stream requests. */
  orgSlug: string;
  workspaceSlug: string;
  /** User preference: submit on Enter. Passed through to the composer. */
  enterToSubmit?: boolean;
  /** User preference: what to do on concurrent submit. Passed to composer. */
  pendingPromptBehavior?: "queue" | "interrupt";
  /** Effective model defaults from server (workspace > user > system). */
  initialModelState?: ComposerModelState;
  /** Available MCP servers for the per-turn activation picker. */
  availableMcpServers?: McpServerSummary[];
  /** GitHub repos usable as the code-mode target (see _shared/code-mode-data.ts). */
  availableRepos?: RepoOption[];
  /** Workspace environments usable as the code-mode target. */
  availableEnvironments?: EnvironmentOption[];
  /** Selectable agents for the composer's agent picker (see _shared/agent-options-data.ts). */
  availableAgents?: AgentOption[];
  /** Workspace-level per-turn budget governance (OXA-2081). Null/omitted ⇒
   * no governance active for this workspace. */
  workspaceBudgetGovernance?: WorkspaceBudgetGovernance | null;
  /** Bound published agent's public id (from the Ask page's ?agent=… param).
   * Forwarded verbatim in each /api/v1/chat/stream request body as `agentId`.
   * Null/omitted ⇒ normal unbound chat. */
  agentId?: string | null;
  /** Human name of the bound agent, resolved server-side — shown as the
   * "Session bound to: <name>" indicator. Null when unbound or unresolved. */
  boundAgentName?: string | null;
}
