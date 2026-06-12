/**
 * Chat component registry — maps capability component IDs to lazily-loaded
 * React components. The stream route emits a "component" event containing a
 * `componentId`; the message bubble dispatches to this registry.
 *
 * IDs are stable contracts. Never rename a key without a migration —
 * persisted content_blocks rows reference them by string.
 *
 * The files under registry-components/ are stub implementations supplied by
 * the R agent. The M agent (svg-preview, image-preview, install-instructions)
 * and V agent (make-video-form) replace them with full implementations.
 */
import { lazy, type LazyExoticComponent } from "react";

// LazyExoticComponent is generic over component props. We widen to a common
// props shape for the registry map — consumers spread `block.props` which is
// typed as `Record<string, unknown>` in the content block.
type AnyLazy = LazyExoticComponent<(props: Record<string, unknown>) => React.ReactElement | null>;

/**
 * Registry keyed by componentId string. All entries are React.lazy so the
 * component bundle is only loaded the first time a matching event arrives.
 *
 * Contract ids (REGISTRY_CONTRACT):
 *   "svg-preview"          — renders an inline SVG string or data-URL (M agent)
 *   "image-preview"        — renders a generated / fetched image (M agent)
 *   "install-instructions" — renders a copy-able installation step block (M agent)
 *   "make-video-form"      — renders the make-a-video request form (V agent)
 *   "file-attachment"      — renders a generated document/spreadsheet/pdf/archive asset card
 *   "html-artifact"        — renders model-generated HTML in a sandboxed iframe
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
  "api-key-display": lazy(
    () => import("@/components/api-key-display").then(m => ({ default: m.ApiKeyDisplay })),
  ),
  "create-workspace-inline": lazy(
    () => import("@/components/chat/registry-components/create-workspace-inline"),
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
    () => import("@/components/chat/registry-components/billing-upgrade-inline"),
  ),
  "credits-purchase-inline": lazy(
    () => import("@/components/chat/registry-components/credits-purchase-inline"),
  ),
  "confirm-destructive-inline": lazy(
    () => import("@/components/chat/registry-components/confirm-destructive-inline"),
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
    () => import("@/components/chat/registry-components/automation-create-inline"),
  ),
} as unknown as Record<string, AnyLazy>;
