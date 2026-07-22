/**
 * Chat component registry — maps capability component IDs to lazily-loaded
 * React components. The stream route emits a "component" event containing a
 * `componentId`; the message bubble dispatches to this registry.
 *
 * IDs are stable contracts. Never rename a key without a migration —
 * persisted content_blocks rows reference them by string.
 *
 * The files under registry-components/ are full implementations (svg-preview,
 * image-preview, install-instructions, make-video-form, and the rest of the
 * registry), each with its own tests/stories.
 */
import { lazy, type LazyExoticComponent } from "react";
import * as React from "react";

// LazyExoticComponent is generic over component props. We widen to a common
// props shape for the registry map — consumers spread `block.props` which is
// typed as `Record<string, unknown>` in the content block.
type AnyLazy = LazyExoticComponent<
  (props: Record<string, unknown>) => React.ReactElement | null
>;

/**
 * Registry keyed by componentId string. All entries are React.lazy so the
 * component bundle is only loaded the first time a matching event arrives.
 *
 * Contract ids (REGISTRY_CONTRACT):
 *   "svg-preview"              — renders an inline SVG string or data-URL (M agent)
 *   "image-preview"            — renders a generated / fetched image (M agent)
 *   "install-instructions"     — renders a copy-able installation step block (M agent)
 *   "make-video-form"          — renders the make-a-video request form (V agent)
 *   "file-attachment"          — renders a generated document/spreadsheet/pdf/archive asset card
 *   "html-artifact"            — renders model-generated HTML in a sandboxed iframe
 *   "connection-create-inline" — renders an inline GitHub (or fallback) connection wizard card
 *   "code-diff"                — renders a unified-diff patch set (agent.repo.edit, repo.file.put)
 *   "terminal-trace"           — long-form shell scrollback for large agent.sandbox.exec output
 *   "file-tree"                — collapsible workspace/repo file tree, changed files link to their diff
 *   "coding-trace-panel"       — collapsible run-overview timeline composing terminal-trace/code-diff steps
 *   "workspace-context-panel"  — active sandbox session's file tree (client-fetched agent.sandbox.files.list)
 *   "pr-stats"                 — PR summary + stats + expandable comments + CI status (repo.pr.get)
 *   "ci-status"                — generic GitHub CI / check-run status for a ref (repo.ci.status)
 */
/**
 * Emit a structured warning when a componentId arrives with no registered
 * renderer. Called from both message-bubble and chat-shell-client so the
 * signal appears at exactly one definition site.
 *
 * Replace this with a telemetry/logger import when one is available —
 * the call sites don't need to change.
 */
export function logUnknownComponent(componentId: string): void {
  console.warn(
    `[chat-component-registry] unknown componentId "${componentId}" — no renderer registered`,
  );
}

/**
 * Visible fallback rendered when a componentId arrives that has no registered
 * renderer. Replaces the previous `return null` behaviour so the user gets a
 * clear signal instead of a silent empty gap.
 */
export function UnknownComponentCard({
  componentId,
}: {
  componentId: string;
}): React.ReactElement {
  return (
    <div
      className="rounded-xl border bg-card px-4 py-3"
      data-testid="unknown-component-card"
    >
      <p className="text-sm text-muted-foreground">
        This interactive component isn&apos;t available in this view.{" "}
        <span className="font-mono text-xs">({componentId})</span>
      </p>
    </div>
  );
}

// The registry is heterogeneous — each component declares its own prop shape —
// but the renderer always supplies props as `Record<string, unknown>` (spread
// from `block.props`). The precise prop types are erased into the uniform
// `AnyLazy` value type at this single, documented boundary. No `any` involved:
// the erasure goes through `unknown`, which the policy permits where a precise
// type cannot be expressed.
export const CHAT_COMPONENTS = {
  "svg-preview": lazy(
    () => import("@/components/chat/registry-components/svg-preview"),
  ),
  // Renders a Mermaid diagram inline as a client-side SVG artifact. Backs the
  // mermaid.generate capability's render directive.
  "mermaid-diagram": lazy(() => import("@/components/chat/mermaid-diagram")),
  "image-preview": lazy(
    () => import("@/components/chat/registry-components/image-preview"),
  ),
  "install-instructions": lazy(
    () => import("@/components/chat/registry-components/install-instructions"),
  ),
  "make-video-form": lazy(
    () => import("@/components/chat/registry-components/make-video-form"),
  ),
  "video-result": lazy(
    () => import("@/components/chat/registry-components/video-result"),
  ),
  "api-key-display": lazy(() =>
    import("@/components/api-key-display").then((m) => ({
      default: m.ApiKeyDisplay,
    })),
  ),
  "create-workspace-inline": lazy(
    () =>
      import("@/components/chat/registry-components/create-workspace-inline"),
  ),
  "create-org-inline": lazy(
    () => import("@/components/chat/registry-components/create-org-inline"),
  ),
  "invite-member-inline": lazy(
    () => import("@/components/chat/registry-components/invite-member-inline"),
  ),
  "model-settings-inline": lazy(
    () => import("@/components/chat/registry-components/model-settings-inline"),
  ),
  "billing-upgrade-inline": lazy(
    () =>
      import("@/components/chat/registry-components/billing-upgrade-inline"),
  ),
  "credits-purchase-inline": lazy(
    () =>
      import("@/components/chat/registry-components/credits-purchase-inline"),
  ),
  "confirm-destructive-inline": lazy(
    () =>
      import(
        "@/components/chat/registry-components/confirm-destructive-inline"
      ),
  ),
  "workflow-progress": lazy(
    () => import("@/components/chat/registry-components/workflow-progress"),
  ),
  "file-attachment": lazy(
    () => import("@/components/chat/registry-components/file-attachment"),
  ),
  "html-artifact": lazy(
    () => import("@/components/chat/registry-components/artifact-iframe"),
  ),
  "automation-create-inline": lazy(
    () =>
      import("@/components/chat/registry-components/automation-create-inline"),
  ),
  "connection-create-inline": lazy(
    () =>
      import("@/components/chat/registry-components/connection-create-inline"),
  ),
  "graph-stats": lazy(
    () => import("@/components/chat/registry-components/graph-stats"),
  ),
  // Generic fallback — renders ANY capability output as a typed, deep-linked
  // key/value card so the user never sees raw JSON. Synthesized by
  // resolveRenderDirective (@oxagen/oxagen/capability-meta) when a capability
  // has no bespoke component and no embedded render directive.
  "capability-result": lazy(
    () => import("@/components/chat/registry-components/capability-result"),
  ),
  // Bespoke, deep-linked components for the prioritized capabilities.
  "graph-node-card": lazy(
    () => import("@/components/chat/registry-components/graph-node-card"),
  ),
  "graph-node-list-card": lazy(
    () => import("@/components/chat/registry-components/graph-node-list-card"),
  ),
  "research-swarm-card": lazy(
    () => import("@/components/chat/registry-components/research-swarm-card"),
  ),
  "conversation-list-card": lazy(
    () =>
      import("@/components/chat/registry-components/conversation-list-card"),
  ),
  // Compact, borderless roster of workspace agents (agent.definition.list) —
  // name + muted slug, latest version, and a live/deployed status dot per row,
  // each deep-linked to the Workbench agent page. Replaces the generic key/value
  // dump for this capability.
  "agent-definition-list-card": lazy(
    () =>
      import(
        "@/components/chat/registry-components/agent-definition-list-card"
      ),
  ),
  "web-search-card": lazy(
    () => import("@/components/chat/registry-components/web-search-card"),
  ),
  // Renders agent.compose output — the composed capability chain with per-step
  // status, rationale, and expandable input/output (chain-of-thought view).
  "capability-chain-card": lazy(
    () => import("@/components/chat/registry-components/capability-chain-card"),
  ),
  // Schema registry mutation — shows a schema add/update/remove action card in chat.
  "schema-mutation-card": lazy(
    () =>
      import(
        "@/components/knowledge/schema-builder/registry-components/schema-mutation-card"
      ),
  ),
  // Schema label approval — lets the user accept/dismiss an AI-proposed label in chat.
  "schema-label-approval": lazy(
    () =>
      import(
        "@/components/knowledge/schema-builder/registry-components/schema-label-approval"
      ),
  ),
  // Unified-diff renderer backing agent.repo.edit / repo.file.put (via
  // capability-meta's structural render transform) and direct agent.ui.render
  // calls with componentId "code-diff".
  "code-diff": lazy(
    () => import("@/components/chat/registry-components/code-diff-card"),
  ),
  // Long-form shell scrollback — the companion to the inline code-execute-card
  // for large agent.sandbox.exec output (chosen by output size, see
  // capability-meta's resolveRenderDirective).
  "terminal-trace": lazy(
    () => import("@/components/chat/registry-components/terminal-trace-card"),
  ),
  // Collapsible workspace/repo file tree; changed entries deep-link to their
  // section in a "code-diff" card via the shared diffAnchorId convention.
  "file-tree": lazy(
    () => import("@/components/chat/registry-components/file-tree-card"),
  ),
  // Collapsible run-overview panel composing per-step terminal-trace/code-diff
  // cards into one timeline for a full coding-agent turn.
  "coding-trace-panel": lazy(
    () => import("@/components/chat/registry-components/coding-trace-panel"),
  ),
  // Client-fetched active sandbox session file tree (agent.sandbox.files.list),
  // rendered via the shared FileTreeCard.
  "workspace-context-panel": lazy(
    () =>
      import("@/components/chat/registry-components/workspace-context-panel"),
  ),
  // Pull-request summary + stats + comments (expandable) + CI status, backing
  // repo.pr.get (via capability-meta's structural render transform).
  "pr-stats": lazy(
    () => import("@/components/chat/registry-components/pr-stats-card"),
  ),
  // Generic GitHub CI / check-run status for a branch, commit, or PR head,
  // backing repo.ci.status.
  "ci-status": lazy(
    () => import("@/components/chat/registry-components/ci-status-card"),
  ),
} as unknown as Record<string, AnyLazy>;
