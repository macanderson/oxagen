/**
 * Chat component registry — maps capability component IDs to lazily-loaded
 * React components. The stream route emits a "component" event containing a
 * `componentId`; the message bubble dispatches to this registry.
 *
 * IDs are stable contracts. Never rename a key without a migration —
 * persisted content_blocks rows reference them by string.
 *
 * The files under registry-components/ are full implementations
 * (install-instructions, the inline forms, the graph cards, and the rest of the
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
 * renderer, so the user gets a clear signal instead of a silent empty gap.
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

/**
 * Registry keyed by componentId string. All entries are React.lazy so the
 * component bundle is only loaded the first time a matching event arrives.
 *
 * These ids ARE the contract: `content_blocks` rows persist them as strings,
 * so a rename needs a data migration. Each entry documents itself below rather
 * than in a second list that drifts out of sync with the map.
 */
// The registry is heterogeneous — each component declares its own prop shape —
// but the renderer always supplies props as `Record<string, unknown>` (spread
// from `block.props`). The precise prop types are erased into the uniform
// `AnyLazy` value type at this single, documented boundary. No `any` involved:
// the erasure goes through `unknown`, which the policy permits where a precise
// type cannot be expressed.
export const CHAT_COMPONENTS = {
  "install-instructions": lazy(
    () => import("@/components/chat/registry-components/install-instructions"),
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
  "file-attachment": lazy(
    () => import("@/components/chat/registry-components/file-attachment"),
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
} as unknown as Record<string, AnyLazy>;
